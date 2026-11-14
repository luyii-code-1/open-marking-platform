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


def view(db,tags):
    result=[]
    for saved in tags:
        tag=get(db,saved['id'],'room-tags') or saved
        if not tag.get('group_id'):
            result.append(saved);continue
        grade=get(db,tag.get('grade_id'),'grades') or {}
        result.append({**tag,'grade_name':grade.get('name',''),'label':f"{grade.get('name','')}－{tag['name']}"})
    return result


def progress(db,tag):
    submissions=[s for s in find(db,'submissions',group_id=tag['group_id']) if includes(s,tag['id'])] if tag.get('group_id') else []
    scanned_ids={s['student_id'] for s in submissions if s.get('status')!='absent' and s.get('pages')}
    scanned=len(scanned_ids)
    absent=len({s['student_id'] for s in submissions if s.get('status')=='absent'}-scanned_ids)
    batches={b['id'] for b in find(db,'scan-batches',group_id=tag['group_id']) if includes(b,tag['id'])} if tag.get('group_id') else set()
    pages=[p for p in objects(db,'pages') if p.get('batch_id') in batches and not p.get('excluded')]
    confirmed_pages={p for s in submissions for p in s.get('pages',[])}
    expected=tag.get('expected_students')
    return {'scanned_students':scanned,'confirmed_absent':absent,'expected_students':expected,
            'remaining_students':max(0,expected-scanned-absent) if expected is not None else None,
            'over_expected':max(0,scanned+absent-expected) if expected is not None else 0,
            'pending_pages':sum(p['id'] not in confirmed_pages and not p.get('linked_submission_id') for p in pages),
            'exception_pages':sum(p.get('status') in ('error','exception') for p in pages)}


def snapshot(db,project_id,identifiers,group=None):
    if not isinstance(identifiers,list) or any(not isinstance(i,str) for i in identifiers) or len(set(identifiers))!=len(identifiers):raise HTTPException(422,'考场标签编号无效')
    if group and group.get('grade_id') and len(identifiers)>1:raise HTTPException(422,'每份答卷最多归属一个考场')
    result=[]
    for identifier in identifiers:
        tag=require(db,identifier,'room-tags')
        if tag['project_id']!=project_id or tag.get('archived'):raise HTTPException(422,'考场不属于当前考试或已停用')
        if tag.get('group_id') and (not group or tag['group_id']!=group['id'] or tag.get('grade_id')!=group.get('grade_id')):raise HTTPException(422,'考场与当前题卡组、年级不匹配')
        if group and group.get('grade_id') and not tag.get('group_id'):raise HTTPException(422,'请选择已归属当前题卡组的考场')
        result.append({k:tag[k] for k in ('id','name','group_id','grade_id','expected_students') if k in tag})
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


def exception_tags(db,value):return view(db,exception_source(db,value).get('room_tags',[]))


@router.get('/room-tags')
def listing(project_id:str|None=None,group_id:str|None=None,grade_id:str|None=None,current=Depends(scan_user)):
    with connect() as db:
        values=find(db,'room-tags',project_id=project_id) if project_id else objects(db,'room-tags')
        values=[v for v in values if (not group_id or v.get('group_id')==group_id) and (not grade_id or v.get('grade_id')==grade_id)]
        if not (is_manager(current) or current['role']=='scanner'):
            from .visibility import result_groups
            groups={g['id']:g for g in objects(db,'groups')};subjects={s['id']:s for s in objects(db,'subjects')}
            visible=result_groups(db,current['id'])
            projects={subjects.get(groups.get(g,{}).get('subject_id'),{}).get('project_id') for g in visible}
            values=[v for v in values if v.get('group_id') in visible or not v.get('group_id') and v['project_id'] in projects]
        return [{**view(db,[v])[0],**progress(db,v)} for v in values]


def validate_room(db,project_id,body,old=None):
    value={**(old or {}),**{k:v for k,v in body.items() if k in ('name','group_id','expected_students','archived')}}
    value['name']=str(value.get('name','')).strip();value.setdefault('archived',False)
    if not 1<=len(value['name'])<=60 or type(value['archived']) is not bool:raise HTTPException(422,'考场名称或状态无效')
    if value.get('group_id'):
        group=require(db,value['group_id'],'groups')
        if project_for_group(db,group['id'])!=project_id or not group.get('grade_id'):raise HTTPException(422,'请选择本考试已设置年级的题卡组')
        value['grade_id']=group['grade_id']
        if type(value.get('expected_students')) is not int or not 0<=value['expected_students']<=100000:raise HTTPException(422,'预期人数应为0至100000的整数')
        if old and old.get('group_id')!=value['group_id'] and any(includes(b,old['id']) for b in objects(db,'scan-batches')):raise HTTPException(409,'考场已有扫描记录，不能更换题卡组')
    if any(t['id']!=value.get('id') and t['name']==value['name'] and t.get('group_id')==value.get('group_id') for t in find(db,'room-tags',project_id=project_id)):raise HTTPException(409,'本题卡组已有同名考场')
    value['project_id']=project_id
    return value


@router.post('/projects/{identifier}/room-tags',status_code=201)
def create(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');require(db,identifier,'projects')
        return put(db,'room-tags',validate_room(db,identifier,body),current['id'])


@router.put('/room-tags/{identifier}')
def update(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');value=require(db,identifier,'room-tags')
        if value.get('group_id') and not body.get('group_id',value['group_id']):raise HTTPException(422,'考场必须保留所属题卡组')
        return put(db,'room-tags',validate_room(db,value['project_id'],body,value),current['id'])


def export_csv(headers,rows,filename):
    from .operations import csv_cell
    stream=io.StringIO(newline='');writer=csv.writer(stream);writer.writerow(headers)
    for row in rows:writer.writerow([csv_cell(c) for c in row])
    return Response('\ufeff'+stream.getvalue(),media_type='text/csv',headers={'Content-Disposition':f'attachment; filename="{filename}"','Cache-Control':'private, no-store'})


@router.get('/exports/scans')
def export_scans(project_id:str|None=None,room_tag_id:str|None=None,group_id:str|None=None,current=Depends(admin)):
    with connect() as db:
        batches=[b for b in objects(db,'scan-batches') if includes(b,room_tag_id) and (not group_id or b['group_id']==group_id) and (not project_id or project_for_group(db,b['group_id'])==project_id)]
        return export_csv(['批次编号','题卡组','年级','考场','考场备注','状态'],[[b['id'],b['group_id'],(get(db,b.get('grade_id'),'grades') or {}).get('name',''),'、'.join(t.get('label',t['name']) for t in view(db,b.get('room_tags',[]))),b.get('room',''),b.get('status','')] for b in batches],'scan-batches.csv')


@router.get('/exports/exceptions')
def export_exceptions(group_id:str|None=None,room_tag_id:str|None=None,status:str|None=None,current=Depends(admin)):
    with connect() as db:
        values=[]
        for v in objects(db,'exceptions'):
            source=exception_source(db,v)
            values.append({**v,'room_tags':view(db,source.get('room_tags',[])),'group_id':v.get('group_id') or source.get('group_id')})
        values=[v for v in values if includes(v,room_tag_id) and (not group_id or v.get('group_id')==group_id) and (not status or v['status']==status)]
        return export_csv(['记录编号','类型','考场标签','说明','状态','核查结论'],[[v['id'],v['kind'],'、'.join(t.get('label',t['name']) for t in v['room_tags']),v.get('reason',''),v['status'],v.get('resolution','')] for v in values],'exceptions.csv')
