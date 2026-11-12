import time
import zipfile
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, get, objects, put
from .dependencies import admin,require
from .archive import checksum,verify
from .storage import backend,local_path,location,Storage

router=APIRouter(prefix='/api/v1')


class Busy(HTTPException):
    retryable=True
    def __init__(self,message):super().__init__(409,message)


def summary(plan,current):
    files=plan['files']
    return {'id':plan['id'],'archive_id':plan['archive_id'],'mode':plan['mode'],'expires_at':plan['expires_at'],'status':plan['status'],'can_confirm':plan['actor']==current['id'] and not plan.get('invalidated_by_deletion'),'file_count':len(files),'local_bytes':sum(f['size'] for f in files if f['local']),'remote_files':sum(bool(f['remote_id']) for f in files),'files':files[:100],'last_result':{'status':plan['status'],'released_files':plan.get('released_files',0),'failed':plan.get('failed',[])}}


@router.get('/release-plans/{identifier}')
def plan_details(identifier:str,current=Depends(admin)):
    with connect() as db:return summary(require(db,identifier,'release-plans'),current)


def scope(db,identifier):
    require(db,identifier,'projects')
    from .lifecycle import project_writable
    project_writable(db,identifier)
    subjects={s['id'] for s in find(db,'subjects',project_id=identifier)}
    groups=[g for g in objects(db,'groups') if g.get('subject_id') in subjects]
    if any(not g.get('frozen') for g in groups):raise HTTPException(409,'请先完成并发布本项目各题卡组，再释放扫描卷')
    gids={g['id'] for g in groups}
    batches={b['id'] for b in objects(db,'scan-batches') if b['group_id'] in gids}
    pages=[p for p in objects(db,'pages') if p['batch_id'] in batches]
    pids={p['id'] for p in pages}
    if any(j['status'] in ('pending','running') and j.get('payload',{}).get('page_id') in pids for j in objects(db,'jobs')):raise HTTPException(409,'本项目仍有页面处理任务，请完成后再释放')
    return pages


@router.post('/projects/{identifier}/release-preview')
def preview(identifier:str,body:dict,current=Depends(admin)):
    return prepare(identifier,body,current)


def prepare(identifier,body,current,progress=None,plan_id=None,ownership=None):
    if plan_id:
        with connect() as db:
            existing=get(db,plan_id,'release-plans')
            if existing:return summary(existing,current)
    archive_id=body.get('archive_id');mode=body.get('mode','local')
    if mode not in ('local','all'):raise HTTPException(422,'释放范围无效')
    try:archive,manifest,_=verify(archive_id,progress)
    except (ValueError,FileNotFoundError,zipfile.BadZipFile) as error:raise HTTPException(409,str(error))
    if archive['project_id']!=identifier:raise HTTPException(422,'归档不属于该考试')
    with connect() as db:
        pages=scope(db,identifier)
        references={r['relative']:r for r in objects(db,'storage-assets') if r['status']=='stored'}
    entries={e['path']:e for e in manifest};files=[]
    for index,page in enumerate(pages):
        if progress:progress(index,len(pages),'核对扫描文件')
        for suffix in ('.image','.png'):
            relative='pages/'+page['id']+suffix;path=local_path(relative);reference=references.get(relative)
            if not path.exists() and not reference and not (page.get('status')=='recognized' or suffix=='.image'):continue
            entry=entries.get(relative)
            if not entry:raise HTTPException(409,'有扫描文件未被该归档覆盖，请重新归档：'+relative)
            if path.exists() and checksum(path)!=entry['sha256']:raise HTTPException(409,'扫描文件已变化，请重新归档：'+relative)
            remote=mode=='all' and reference is not None
            if remote and (reference.get('backend')!=backend() or reference.get('location')!=location()):raise HTTPException(409,'远端位置与文件目录不一致，不能删除；请核对存储配置并重新同步')
            if path.exists() or remote:files.append({**entry,'relative':relative,'local':path.exists(),'remote_id':reference['id'] if remote else None,'candidate_number':page.get('candidate_number'),'side':page.get('side'),'sequence':page.get('sequence')})
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        from .jobs import guard
        guard(db,ownership)
        value={'project_id':identifier,'archive_id':archive_id,'mode':mode,'files':files,'actor':current['id'],'expires_at':time.time()+600,'status':'preview'}
        if plan_id:value['id']=plan_id
        plan=put(db,'release-plans',value,current['id'])
    if progress:progress(len(pages),len(pages),'核对扫描文件')
    return summary(plan,current)


@router.post('/projects/{identifier}/release')
def release(identifier:str,body:dict,current=Depends(admin)):
    return execute_release(identifier,body,current)


def execute_release(identifier,body,current,progress=None):
    if body.get('confirm') is not True:raise HTTPException(422,'请再次确认释放操作')
    with connect() as db:
        plan=require(db,body.get('plan_id'),'release-plans')
        if plan.get('invalidated_by_deletion'):raise HTTPException(409,'考试层级已变化，请重新预览释放清单')
        project=require(db,identifier,'projects')
        if plan['project_id']!=identifier or plan['actor']!=current['id']:raise HTTPException(403,'释放清单不属于当前操作')
        if plan['status']=='completed':return {'status':'completed','released_files':plan['released_files'],'failed':[]}
        if plan['status']=='preview' and plan['expires_at']<time.time():raise HTTPException(409,'释放清单已过期，请重新预览')
        if plan['status']=='running' and plan.get('lease_until',0)>time.time():raise Busy('该释放操作仍在运行')
    try:verify(plan['archive_id'],progress)
    except (ValueError,FileNotFoundError,zipfile.BadZipFile) as error:raise HTTPException(409,str(error))
    # Validate every local byte before removing the first file.
    for index,entry in enumerate(plan['files']):
        if progress:progress(index,len(plan['files']),'核对释放内容')
        path=local_path(entry['relative'])
        if path.exists() and checksum(path)!=entry['sha256']:raise HTTPException(409,'文件变化，释放清单已失效')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');scope(db,identifier)
        project=require(db,identifier,'projects');plan=require(db,plan['id'],'release-plans')
        if plan.get('invalidated_by_deletion'):raise HTTPException(409,'考试层级已变化，请重新预览释放清单')
        if plan['status']=='running' and plan.get('lease_until',0)>time.time():raise Busy('该释放操作仍在运行')
        if project.get('storage_operation',{}).get('until',0)>time.time():raise Busy('项目已有文件操作正在运行')
        operation_token=str(uuid4())
        plan.update(status='running',lease_until=time.time()+600,operation_token=operation_token);put(db,'release-plans',plan,current['id'])
        project['storage_operation']={'id':plan['id'],'token':operation_token,'until':plan['lease_until']};put(db,'projects',project,current['id'])
    released=0;failed=[];last_heartbeat=time.time();interrupted=True
    try:
        for index,entry in enumerate(plan['files']):
            if progress:progress(index,len(plan['files']),'释放扫描文件')
            try:
                path=local_path(entry['relative'])
                if entry['remote_id']:
                    with connect() as db:reference=require(db,entry['remote_id'],'storage-assets')
                    if reference['status']=='stored':
                        if reference.get('backend')!=backend() or reference.get('location')!=location():raise ValueError('远端位置变化')
                        Storage().delete(reference['key'])
                        with connect() as db:
                            reference.update(status='archived',archive_id=plan['archive_id']);put(db,'storage-assets',reference,current['id'])
                path.unlink(missing_ok=True);released+=1
            except Exception as error:failed.append({'relative':entry['relative'],'error':type(error).__name__})
            if time.time()-last_heartbeat>60:
                with connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    if require(db,plan['id'],'release-plans').get('operation_token')!=operation_token:raise Busy('文件操作租约已变化')
                    plan['lease_until']=time.time()+600;put(db,'release-plans',plan,current['id'])
                    project=require(db,identifier,'projects');project['storage_operation']={'id':plan['id'],'token':operation_token,'until':plan['lease_until']};put(db,'projects',project,current['id'])
                last_heartbeat=time.time()
        interrupted=False
    finally:
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if require(db,plan['id'],'release-plans').get('operation_token')==operation_token:
                if interrupted:failed.append({'relative':'','error':'operation_interrupted'})
                plan.update(status='partial' if failed else 'completed',released_files=released,failed=failed,lease_until=0);put(db,'release-plans',plan,current['id'])
                project=require(db,identifier,'projects')
                if project.get('storage_operation',{}).get('token')==operation_token:project.pop('storage_operation',None);put(db,'projects',project,current['id'])
    if progress:progress(len(plan['files']),len(plan['files']),'释放扫描文件')
    return {'status':plan['status'],'released_files':released,'failed':failed}
