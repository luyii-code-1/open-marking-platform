import time
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException
from .db import connect,find,put
from .dependencies import admin,require
from .jobs import create_job,dispatch

router=APIRouter(prefix='/api/v1')
KINDS={'archive-project','preview-release','release-project','restore-archive'}


def submit(project_id,kind,payload,current):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');require(db,project_id,'projects')
        active=[j for j in find(db,'jobs',project_id=project_id) if j['kind'] in KINDS and j['status'] in ('pending','running')]
        for job in active:
            comparable={k:v for k,v in job['payload'].items() if k not in ('new_archive_id','new_plan_id')}
            if job['kind']==kind and comparable==payload and job.get('actor')==current['id']:return job
        if active:raise HTTPException(409,'本项目已有文件任务，请完成后再提交')
        value=dict(payload)
        if kind=='archive-project':value['new_archive_id']=str(uuid4())
        if kind=='preview-release':value['new_plan_id']=str(uuid4())
        if kind=='release-project':
            plan=require(db,value['plan_id'],'release-plans')
            if plan.get('invalidated_by_deletion'):raise HTTPException(409,'考试层级已变化，请重新预览释放清单')
            if plan['project_id']!=project_id or plan['actor']!=current['id']:raise HTTPException(403,'释放清单不属于当前操作')
            if plan['status']=='preview' and plan['expires_at']<time.time():raise HTTPException(409,'释放清单已过期，请重新预览')
            if plan['status']!='completed':
                plan.update(status='queued',confirmed_at=time.time());put(db,'release-plans',plan,current['id'])
        job=create_job(db,kind,value,project_id,current['id'])
    dispatch(job['id'],background=True)
    return job


@router.post('/projects/{identifier}/archive-jobs',status_code=202)
def archive_job(identifier:str,current=Depends(admin)):
    return submit(identifier,'archive-project',{},current)


@router.post('/projects/{identifier}/release-preview-jobs',status_code=202)
def preview_job(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        archive=require(db,body.get('archive_id'),'archives')
        if archive['project_id']!=identifier:raise HTTPException(422,'归档不属于该考试')
    if body.get('mode','local') not in ('local','all'):raise HTTPException(422,'释放范围无效')
    return submit(identifier,'preview-release',{'archive_id':archive['id'],'mode':body.get('mode','local')},current)


@router.post('/projects/{identifier}/release-jobs',status_code=202)
def release_job(identifier:str,body:dict,current=Depends(admin)):
    if body.get('confirm') is not True:raise HTTPException(422,'请再次确认释放操作')
    return submit(identifier,'release-project',{'plan_id':body.get('plan_id'),'confirm':True},current)


@router.post('/archives/{identifier}/restore-jobs',status_code=202)
def restore_job(identifier:str,current=Depends(admin)):
    with connect() as db:archive=require(db,identifier,'archives')
    return submit(archive['project_id'],'restore-archive',{'archive_id':identifier},current)


def perform(job,progress):
    with connect() as db:
        person=db.execute('SELECT id,role FROM users WHERE id=?',(job['actor'],)).fetchone()
        if not person or person['role']!='admin':raise HTTPException(403,'提交人的管理权限已失效')
        current=dict(person)
    body=job['payload'];identifier=job['project_id']
    if job['kind']=='archive-project':
        from .archive import create
        return create(identifier,current['id'],progress,body['new_archive_id'],(job['id'],job['run_token']))
    if job['kind']=='preview-release':
        from .release import prepare
        return prepare(identifier,body,current,progress,body['new_plan_id'],(job['id'],job['run_token']))
    if job['kind']=='release-project':
        from .release import execute_release
        return execute_release(identifier,body,current,progress)
    from .archive import restore
    return restore(body['archive_id'],current['id'],progress)
