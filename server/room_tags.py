"""Project-scoped labels with snapshots on scan batches and submissions."""
import csv
import io
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from .db import connect, find, get, objects, put
from .dependencies import admin, scan_user, scan_admin, require, is_manager

router=APIRouter(prefix='/api/v1')


def project_for_group(db,group_id):
    group=require(db,group_id,'groups');subject=require(db,group['subject_id'],'subjects')
    return subject['project_id']


def snapshot(db,project_id,ids):
    if not isinstance(ids,list) or len(ids)>20 or any(not isinstance(i,str) for i in ids) or len(set(ids))!=len(ids):raise HTTPException(422,'考场标签应为最多20个不重复编号')
    result=[]
    for identifier in sorted(ids):
        tag=require(db,identifier,'room-tags')
        if tag['project_id']!=project_id:raise HTTPException(422,'考场标签不属于当前考试')
        result.append({'id':tag['id'],'name':tag['name']})
    return result


def includes(value,identifier):return not identifier or any(t['id']==identifier for t in value.get('room_tags',[]))


def from_pages(db,pages):
    labels={}
    for page_id in pages:
        page=require(db,page_id,'pages');batch=require(db,page['batch_id'],'scan-batches')
        labels.update((t['id'],t) for t in batch.get('room_tags',[]))
    return [labels[k] for k in sorted(labels)]


def exception_source(db,value):
    submission=get(db,value.get('submission_id'),'submissions')
    if not submission and value.get('task_id'):
        task=get(db,value['task_id'],'tasks') or {};submission=get(db,task.get('submission_id'),'submissions')
    if submission:return submission
    page=get(db,value.get('page_id'),'pages') or {}
    batch=get(db,value.get('batch_id',page.get('batch_id')),'scan-batches') or {}
    return batch


def exception_tags(db,value):return exception_source(db,value).get('room_tags',[])


@router.get('/room-tags')
def listing(project_id:str|None=None,current=Depends(scan_user)):
    with connect() as db:
        values=find(db,'room-tags',project_id=project_id) if project_id else objects(db,'room-tags')
        if is_manager(current) or current['role']=='scanner':return values
        from .visibility import result_groups
        groups={g['id']:g for g in objects(db,'groups')};subjects={s['id']:s for s in objects(db,'subjects')}
        visible={subjects.get(groups.get(g,{}).get('subject_id'),{}).get('project_id') for g in result_groups(db,current['id'])}
        return [v for v in values if v['project_id'] in visible]


@router.post('/projects/{identifier}/room-tags',status_code=201)
def create(identifier:str,body:dict,current=Depends(admin)):
    name=str(body.get('name','')).strip()
    if not 1<=len(name)<=60:raise HTTPException(422,'考场标签需1至60字')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');require(db,identifier,'projects')
        if any(t['name']==name for t in find(db,'room-tags',project_id=identifier)):raise HTTPException(409,'本考试已有同名考场标签')
        return put(db,'room-tags',{'project_id':identifier,'name':name,'archived':False},current['id'])


@router.put('/room-tags/{identifier}')
def update(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');value=require(db,identifier,'room-tags')
        name=str(body.get('name',value['name'])).strip();archived=body.get('archived',value.get('archived',False))
        if not 1<=len(name)<=60 or type(archived) is not bool:raise HTTPException(422,'标签名称或归档状态无效')
        if any(t['id']!=identifier and t['name']==name for t in find(db,'room-tags',project_id=value['project_id'])):raise HTTPException(409,'本考试已有同名考场标签')
        value.update(name=name,archived=archived);return put(db,'room-tags',value,current['id'])


def export_csv(headers,rows,filename):
    from .operations import csv_cell
    stream=io.StringIO(newline='');writer=csv.writer(stream);writer.writerow(headers)
    for row in rows:writer.writerow([csv_cell(c) for c in row])
    return Response('\ufeff'+stream.getvalue(),media_type='text/csv',headers={'Content-Disposition':f'attachment; filename="{filename}"','Cache-Control':'private, no-store'})


@router.get('/exports/scans')
def export_scans(project_id:str|None=None,room_tag_id:str|None=None,group_id:str|None=None,current=Depends(admin)):
    with connect() as db:
        batches=[b for b in objects(db,'scan-batches') if includes(b,room_tag_id) and (not group_id or b['group_id']==group_id) and (not project_id or project_for_group(db,b['group_id'])==project_id)]
        return export_csv(['批次编号','题卡组','考场标签','考场备注','状态'],[[b['id'],b['group_id'],'、'.join(t['name'] for t in b.get('room_tags',[])),b.get('room',''),b.get('status','')] for b in batches],'scan-batches.csv')


@router.get('/exports/exceptions')
def export_exceptions(group_id:str|None=None,room_tag_id:str|None=None,status:str|None=None,current=Depends(admin)):
    with connect() as db:
        values=[]
        for v in objects(db,'exceptions'):
            source=exception_source(db,v)
            values.append({**v,'room_tags':source.get('room_tags',[]),'group_id':v.get('group_id') or source.get('group_id')})
        values=[v for v in values if includes(v,room_tag_id) and (not group_id or v.get('group_id')==group_id) and (not status or v['status']==status)]
        return export_csv(['记录编号','类型','考场标签','说明','状态','核查结论'],[[v['id'],v['kind'],'、'.join(t['name'] for t in v['room_tags']),v.get('reason',''),v['status'],v.get('resolution','')] for v in values],'exceptions.csv')
