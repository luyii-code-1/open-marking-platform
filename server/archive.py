import hashlib
import json
import time
import zipfile
from contextlib import nullcontext
from uuid import uuid4

from fastapi import HTTPException
from . import db as database
from .db import connect, get, objects, put
from .dependencies import require


def checksum(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def package_path(identifier):
    from .storage import local_path
    return local_path('archives/'+identifier+'.zip')


def verify(identifier,progress=None):
    """Verify the registered immutable ZIP and every manifest entry."""
    with connect() as db:record=require(db,identifier,'archives')
    path=package_path(identifier)
    if not path.exists():raise FileNotFoundError('归档文件不存在')
    if record.get('sha256') and checksum(path)!=record['sha256']:raise ValueError('归档文件校验不一致')
    with zipfile.ZipFile(path) as package:
        names=package.namelist()
        if len(names)!=len(set(names)):raise ValueError('归档包含重复文件')
        manifest=json.loads(package.read('manifest.json'))
        from .storage import safe_key
        for index,entry in enumerate(manifest):
            if progress:progress(index,len(manifest),'校验归档')
            name=safe_key(entry['path'])
            with package.open(name) as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
            if package.getinfo(name).file_size!=entry['size'] or digest!=entry['sha256']:raise ValueError('归档内容校验失败：'+name)
        data=json.loads(package.read('data.json'))
        if data['project_id']!=record['project_id']:raise ValueError('归档项目不一致')
    if progress:progress(len(manifest),len(manifest),'校验归档')
    return record,manifest,data


def extract_file(identifier,relative,target,entry=None,package=None):
    """Read one indexed asset, never extract arbitrary ZIP paths."""
    from .storage import local_path,safe_key
    relative=safe_key(relative)
    if relative.split('/')[0] not in ('pages','assets'):raise ValueError('只能恢复扫描页和题卡资产')
    if target.resolve()!=local_path(relative):raise ValueError('恢复位置无效')
    path=package_path(identifier)
    if not path.exists():raise FileNotFoundError(path)
    target.parent.mkdir(parents=True,exist_ok=True)
    temporary=target.with_name(target.name+'.'+str(uuid4())+'.restore')
    try:
        with (zipfile.ZipFile(path) if package is None else nullcontext(package)) as package:
            if entry is None:entry=next((e for e in json.loads(package.read('manifest.json')) if e['path']==relative),None)
            if not entry:raise FileNotFoundError(relative)
            digest=hashlib.sha256();size=0
            with package.open(relative) as source,temporary.open('wb') as output:
                while block:=source.read(1024*1024):output.write(block);digest.update(block);size+=len(block)
            if digest.hexdigest()!=entry['sha256'] or size!=entry['size']:raise ValueError('恢复文件校验失败')
        temporary.replace(target)
    finally:temporary.unlink(missing_ok=True)
    return target


def collect(db,identifier):
    project=require(db,identifier,'projects')
    items=[(r['kind'],json.loads(r['body'])) for r in db.execute('SELECT kind,body FROM objects WHERE deleted=0')]
    selected={identifier};changed=True
    references=('project_id','subject_id','group_id','template_id','submission_id','batch_id','task_id','page_id')
    excluded={'archives','archive-files'}
    while changed:
        before=len(selected)
        for kind,item in items:
            if kind not in excluded and any(item.get(k) in selected for k in references):selected.add(item['id'])
        changed=len(selected)!=before
    students={item['student_id'] for kind,item in items if item['id'] in selected and 'student_id' in item}
    students.update(s['id'] for kind,item in items if kind=='rosters' and item['id'] in selected for s in item['students'])
    selected.update(students)
    selected.update(item.get('class_id') for kind,item in items if item['id'] in students)
    for kind,item in items:
        if item['id'] not in selected:continue
        assets=set(item.get('background_assets',{}).values())
        assets.update(item.get('alignment_history',[]))
        if item.get('background_asset_id'):assets.add(item['background_asset_id'])
        if item.get('conversion_id'):selected.add(item['conversion_id'])
        if item.get('asset_id'):assets.add(item['asset_id'])
        assets.update(q['image_asset_id'] for q in item.get('questions',[]) if q.get('image_asset_id'))
        assets.update(o['asset_id'] for o in item.get('region_overrides',{}).values() if o.get('asset_id'))
        selected.update(assets)
    records=[{'kind':kind,'data':item} for kind,item in items if item['id'] in selected]
    scores=[dict(r) for r in db.execute('SELECT * FROM scores') if r['task_id'] in selected]
    audit=[dict(r) for r in db.execute('SELECT * FROM audit') if r['object_id'] in selected]
    user_ids={r['user_id'] for r in scores}|{r['actor'] for r in audit}
    for record in records:
        if record['kind']=='assignments':user_ids.update(record['data'].get('user_ids',[])+record['data'].get('arbitrator_ids',[]))
    people=[dict(r) for r in db.execute('SELECT id,username,name,role FROM users') if r['id'] in user_ids]
    owners=selected|user_ids
    identifiers=[dict(r) for r in db.execute('SELECT * FROM identifiers') if r['owner_id'] in owners]
    results=[dict(r) for r in db.execute('SELECT * FROM review_results') if r['submission_id'] in selected]
    return project,records,{'format':'omp-project-2','project_id':identifier,'records':records,'score_history':scores,'review_results':results,'audit':audit,'people':people,'identifiers':identifiers}


def create(identifier,actor,progress=None,archive_id=None,ownership=None,preserve_status=False):
    from .storage import materialize
    from .paper import pdf
    with connect() as db:
        if archive_id:
            existing=get(db,archive_id,'archives')
            if existing:
                if existing['project_id']!=identifier:raise HTTPException(409,'归档编号冲突')
                return existing
        db.execute('BEGIN')
        project,records,data=collect(db,identifier)
        from .lifecycle import project_writable
        project_writable(db,identifier)
    archive_id=archive_id or str(uuid4());target=package_path(archive_id);target.parent.mkdir(parents=True,exist_ok=True)
    temporary=target.with_name(target.stem+'.'+str(uuid4())+'.tmp');manifest=[]
    try:
        with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=3,allowZip64=True) as package:
            def write_bytes(name,content):
                package.writestr(name,content);manifest.append({'path':name,'size':len(content),'sha256':hashlib.sha256(content).hexdigest()})
            write_bytes('data.json',json.dumps(data,ensure_ascii=False).encode('utf-8'))
            for record_index,record in enumerate(records):
                if progress:progress(record_index,len(records),'写入归档')
                kind,item=record['kind'],record['data']
                if kind=='templates' and item.get('status')=='published':write_bytes('templates/'+item['id']+'.pdf',pdf(item))
                if kind not in ('pages','assets'):continue
                for suffix in (('.image','.png') if kind=='pages' else ('.png',)):
                    name=kind+'/'+item['id']+suffix
                    try:source=materialize(name)
                    except FileNotFoundError:
                        if suffix=='.png' and kind=='pages' and item.get('status')!='recognized':continue
                        raise HTTPException(409,'归档缺少文件：'+name)
                    digest=hashlib.sha256();size=0
                    with source.open('rb') as stream,package.open(name,'w',force_zip64=True) as output:
                        while block:=stream.read(1024*1024):
                            if progress:progress(record_index,len(records),'写入归档')
                            output.write(block);digest.update(block);size+=len(block)
                    manifest.append({'path':name,'size':size,'sha256':digest.hexdigest()})
                    if kind=='pages' and suffix=='.image' and item.get('sha256') and digest.hexdigest()!=item['sha256']:raise HTTPException(409,'原始扫描文件与接收记录不一致：'+name)
                    expected=item.get('normalized_sha256') if kind=='pages' and suffix=='.png' else item.get('sha256') if kind=='assets' else None
                    if expected and digest.hexdigest()!=expected:raise HTTPException(409,'文件与当前记录版本不一致：'+name)
            package.writestr('manifest.json',json.dumps(manifest))
        # Verify the bytes actually written before making the archive available.
        with zipfile.ZipFile(temporary) as package:
            for index,entry in enumerate(manifest):
                if progress:progress(index,len(manifest),'校验写入内容')
                with package.open(entry['path']) as stream:
                    if hashlib.file_digest(stream,'sha256').hexdigest()!=entry['sha256']:raise IOError('归档写入校验失败')
        if progress:progress(0,1,'计算归档校验值')
        archive_sha=checksum(temporary)
        if progress:progress(1,1,'计算归档校验值')
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            from .jobs import guard
            guard(db,ownership)
            project=require(db,identifier,'projects')
            temporary.replace(target)
            result=put(db,'archives',{'id':archive_id,'project_id':identifier,'status':'verified','format':'omp-project-2','created_at':time.time(),'asset_count':sum(e['path'].startswith(('pages/','assets/')) for e in manifest),'size':target.stat().st_size,'sha256':archive_sha,'download_url':f'/api/v1/archives/{archive_id}/download'},actor)
            for entry in manifest:
                if entry['path'].startswith(('pages/','assets/')):put(db,'archive-files',{'archive_id':archive_id,'project_id':identifier,'relative':entry['path'],'sha256':entry['sha256'],'size':entry['size'],'created_at':result['created_at']},actor)
            if not preserve_status:
                project=require(db,identifier,'projects');project['status']='archived';put(db,'projects',project,actor)
        return result
    finally:temporary.unlink(missing_ok=True)


def restore(identifier,actor,progress=None):
    from .storage import local_path
    record,manifest,_=verify(identifier,progress)
    from .lifecycle import project_writable
    with connect() as db:project_writable(db,record['project_id'])
    restored=0;pending=[]
    for index,entry in enumerate(manifest):
        if progress:progress(index,len(manifest),'核对现有文件')
        if not entry['path'].startswith(('pages/','assets/')):continue
        from .storage import expected_hash
        with connect() as db:expected=expected_hash(db,entry['path'])
        if expected and expected!=entry['sha256']:raise HTTPException(409,'归档文件不是当前使用的版本，未恢复：'+entry['path'])
        path=local_path(entry['path'])
        if path.exists():
            if checksum(path)!=entry['sha256']:raise HTTPException(409,'现有文件与归档不一致，未覆盖：'+entry['path'])
            continue
        pending.append(entry)
    with zipfile.ZipFile(package_path(identifier)) as package:
        for index,entry in enumerate(pending):
            if progress:progress(index,len(pending),'恢复文件')
            with connect() as db:
                db.execute('BEGIN IMMEDIATE');project_writable(db,record['project_id'])
                extract_file(identifier,entry['path'],local_path(entry['path']),entry,package);restored+=1
    if progress:progress(len(pending),len(pending),'恢复文件')
    with connect() as db:put(db,'storage-operations',{'project_id':record['project_id'],'archive_id':identifier,'action':'restore_files','restored':restored},actor)
    return {'restored_files':restored}
