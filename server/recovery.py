"""Restore an OMP snapshot into a new data directory, before starting services."""
import argparse
import hashlib
import json
import shutil
import sqlite3
import tempfile
import time
import zipfile
from contextlib import closing
from pathlib import Path
from . import db as database
from .db import connect,objects,put
from .backups import checksum,inspect
from .identifiers import canonical


def _reset_runtime(root,reason):
    counts={}
    with connect(root) as db:
        db.execute('BEGIN IMMEDIATE')
        counts['user_sessions']=db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
        db.execute('DELETE FROM sessions')
        locked={row['project_id'] for row in db.execute('SELECT project_id FROM deletion_locks')}
        # Preserve the confirmed business snapshot until its deletion can resume.
        # Restored scan bytes need cleanup again, including previously finished files.
        counts['deletion_files_reset']=db.execute('UPDATE deletion_files SET done=0 WHERE plan_id IN (SELECT plan_id FROM deletion_locks) AND done=1').rowcount
        for kind in ('scanner-sessions','scanner-devices','download-tickets','auth-challenge','scanner-challenges','recovery-code','jobs','tasks','release-plans','projects'):
            changed=0
            for body in objects(db,kind):
                if kind in ('scanner-sessions','scanner-devices'):
                    body.update(revoked=True,restore_reason=reason)
                    if kind=='scanner-sessions':body['expires_at']=0
                elif kind=='download-tickets':body['expires_at']=0
                elif kind in ('auth-challenge','scanner-challenges','recovery-code'):
                    body['used']=True;body['expires_at' if kind=='scanner-challenges' else 'expires']=0
                elif kind=='jobs':
                    if body['status'] not in ('pending','running'):continue
                    body.update(status='failed',lease_until=0,available_at=0,error='restored_requires_review',error_detail='从备份恢复，请核对后手动重试')
                    body.pop('run_token',None)
                elif kind=='tasks':
                    if body['status']!='claimed':continue
                    from .lifecycle import project_for
                    if project_for(db,kind,body) in locked:continue
                    body.update(status='expired',expires_at=0)
                elif kind=='release-plans':
                    if body['status']=='completed':continue
                    body.update(status='preview',expires_at=0,lease_until=0)
                    body.pop('operation_token',None)
                elif kind=='projects':
                    if body['id'] in locked:continue
                    if not body.get('storage_operation'):continue
                    body.pop('storage_operation',None)
                put(db,kind,body);changed+=1
            counts[kind]=changed
    return counts


def _restore_files(root,source):
    with connect(root) as db:
        records={kind:objects(db,kind) for kind in ('pages','assets','archives','archive-files')}
    needed={};archived={}
    for entry in sorted(records['archive-files'],key=lambda r:r.get('created_at',0),reverse=True):archived.setdefault(entry['relative'],[]).append(entry)
    for kind in ('pages','assets','archives'):
        for body in records[kind]:
            identifier=canonical(body['id'])
            suffixes=('.image','.png') if kind=='pages' and body.get('status')=='recognized' else ('.image',) if kind=='pages' else ('.png',) if kind=='assets' else ('.zip',)
            if kind=='pages' and '.png' not in suffixes and source and (source/'pages'/(identifier+'.png')).is_file():suffixes+=('.png',)
            for suffix in suffixes:
                relative=f'{kind}/{identifier}{suffix}'
                expected=body.get('normalized_sha256' if kind=='pages' and suffix=='.png' else 'sha256')
                if not expected and archived.get(relative):expected=archived[relative][0]['sha256']
                needed[relative]=expected
    result={'needed':len(needed),'copied':0,'from_archive':0,'verified':0,'without_recorded_hash':0}
    # Archive ZIPs are copied first so released scans can be recovered from them.
    for relative,expected in sorted(needed.items()):
        target=root/relative;target.parent.mkdir(parents=True,exist_ok=True)
        candidate=source/relative if source else None
        if candidate and candidate.is_file():
            if candidate.is_symlink() or not candidate.resolve().is_relative_to(source):raise ValueError('文件路径超出源目录：'+relative)
            shutil.copyfile(candidate,target);result['copied']+=1
        else:
            for entry in archived.get(relative,[]):
                if expected and entry['sha256']!=expected:continue
                package=root/'archives'/(canonical(entry['archive_id'])+'.zip')
                if not package.is_file():continue
                try:
                    with zipfile.ZipFile(package) as archive,archive.open(relative) as stream,target.open('wb') as output:
                        shutil.copyfileobj(stream,output,1024*1024)
                    if target.stat().st_size!=entry['size'] or checksum(target)!=entry['sha256']:raise ValueError('归档恢复文件校验失败：'+relative)
                except KeyError:target.unlink(missing_ok=True);continue
                result['from_archive']+=1;break
            else:raise ValueError('缺少恢复文件，请提供一致的文件快照：'+relative)
        if expected:
            if checksum(target)!=expected:raise ValueError('文件与备份记录的版本不一致：'+relative)
            result['verified']+=1
        else:result['without_recorded_hash']+=1
    return result


def restore(source,target,files_from=None,expected_sha256=None,database_only=False,reason='从备份恢复'):
    source=Path(source).resolve(strict=True);target=Path(target).absolute()
    if target.exists() or target.is_symlink():raise ValueError('恢复目标目录必须不存在')
    parent=target.parent.resolve(strict=True);target=parent/target.name
    files=Path(files_from).resolve(strict=True) if files_from is not None else None
    if files and (not files.is_dir() or target.is_relative_to(files)):raise ValueError('恢复目标不能位于源文件目录内')
    if database_only and files:raise ValueError('仅恢复数据库时不应指定文件源目录')
    if not isinstance(reason,str) or not 1<=len(reason.strip())<=1000:raise ValueError('请填写1000字以内恢复原因')
    digest=checksum(source)
    if expected_sha256 and digest!=expected_sha256.lower():raise ValueError('数据库备份SHA-256不一致')
    counts=inspect(source)
    with tempfile.TemporaryDirectory(prefix='.omp-recovery-',dir=parent) as temporary:
        root=Path(temporary)/'data';root.mkdir(mode=0o700)
        with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as snapshot:
            with closing(sqlite3.connect(root/'omp.sqlite3')) as destination:snapshot.backup(destination)
        database.initialize(root)
        files_result={'scope':'database-only','needed':None} if database_only else {'scope':'database-and-files',**_restore_files(root,files)}
        reset=_reset_runtime(root,reason.strip())
        report={'format':'omp-recovery-1','source_sha256':digest,'recovered_at':time.time(),'reason':reason.strip(),'source_counts':counts,'files':files_result,'runtime_reset':reset}
        with connect(root) as db:
            put(db,'recovery-events',report)
            # Publish a self-contained SQLite file with no outstanding WAL content.
        with closing(sqlite3.connect(root/'omp.sqlite3')) as db:db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        report['restored_counts']=inspect(root/'omp.sqlite3')
        (root/'recovery-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        if target.exists() or target.is_symlink():raise ValueError('恢复目标已存在，未覆盖')
        root.rename(target)
    return report


def main():
    parser=argparse.ArgumentParser(description='从SQLite备份恢复到新的OMP数据目录')
    parser.add_argument('backup');parser.add_argument('--target',required=True);parser.add_argument('--files-from');parser.add_argument('--sha256');parser.add_argument('--database-only',action='store_true');parser.add_argument('--reason',default='从备份恢复')
    args=parser.parse_args()
    try:result=restore(args.backup,args.target,args.files_from,args.sha256,args.database_only,args.reason)
    except (ValueError,OSError,sqlite3.Error,zipfile.BadZipFile) as error:parser.exit(1,str(error)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
