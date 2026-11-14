"""Read models for a card's roster, capture and publication workflow."""
import time
import hashlib
import json
from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, get, objects, put
from .dependencies import admin, require
from .school import group_students, student_view

router=APIRouter(prefix='/api/v1')


def membership(db,group):
    students=group_students(db,group)
    saved=get(db,group.get('roster_review_id'),'rosters')
    current={s['id']:s for s in students or []}
    previous={s['id']:s for s in (saved or {}).get('students',[])}
    removed=[student_view(db,s) for sid,s in previous.items() if sid not in current]
    submissions=find(db,'submissions',group_id=group['id'])
    retained=[student_view(db,s.get('student_snapshot') or require(db,s['student_id'],'students')) for s in submissions if s['student_id'] not in current]
    return {'configured':students is not None,'students':students or [],'reviewed_at':(saved or {}).get('at'),
            'added':[s for sid,s in current.items() if saved and sid not in previous],
            'removed':removed,'retained':retained,'needs_review':False}


def batch_progress(db,batch):
    pages=[p for p in find(db,'pages',batch_id=batch['id']) if not p.get('excluded')]
    submissions=find(db,'submissions',group_id=batch['group_id'])
    linked={pid for s in submissions for pid in s.get('pages',[])}
    return {'received_pages':len(pages),'processing_pages':sum(p.get('status')=='received' for p in pages),
            'recognized_pages':sum(p.get('status')=='recognized' for p in pages),
            'exception_pages':sum(p.get('status') not in ('received','recognized') for p in pages),
            'linked_pages':sum(p['id'] in linked or bool(p.get('linked_submission_id')) for p in pages),
            'front_pages':sum(p.get('side')=='front' for p in pages),'back_pages':sum(p.get('side')=='back' for p in pages)}


def overview(db,group,current):
    roster=membership(db,group)
    submissions=find(db,'submissions',group_id=group['id'])
    batches=find(db,'scan-batches',group_id=group['id'])
    from .room_tags import exception_source,progress
    exceptions=[e for e in objects(db,'exceptions') if e.get('status')=='open' and e.get('kind')!='excellent' and (e.get('group_id')==group['id'] or exception_source(db,e).get('group_id')==group['id'])]
    rooms=[{**r,**progress(db,r)} for r in find(db,'room-tags',group_id=group['id']) if not r.get('archived')]
    from .review import results_for
    rows=results_for(db,group['id'],current) if group.get('template_id') else []
    counts={status:sum(r['status']==status for r in rows) for status in ('unscanned','absent','pending','completed')}
    details=[{**b,**batch_progress(db,b)} for b in batches]
    signature=hashlib.sha256(json.dumps({'members':sorted(s['id'] for s in roster['students']),'batches':sorted((b['id'],b.get('status'),b['received_pages'],b['linked_pages']) for b in details),'rooms':sorted((r['id'],r.get('expected_students')) for r in rooms),'submissions':sorted((s['id'],s.get('status'),s.get('pages',[])) for s in submissions)},sort_keys=True).encode()).hexdigest()
    closed=group.get('scan_close',{}).get('signature')==signature
    regrades=db.execute("SELECT COUNT(*) FROM regrade_queue r JOIN objects t ON t.id=r.task_id JOIN objects s ON s.id=json_extract(t.body,'$.submission_id') WHERE s.deleted=0 AND json_extract(s.body,'$.group_id')=?",(group['id'],)).fetchone()[0]
    state = {'scan_signature':signature,'scan_closed':closed,'scan_closed_at':group.get('scan_close',{}).get('at') if closed else None,'roster_configured':roster['configured'],'regrades':regrades,'group_id':group['id'],'roster_count':len(roster['students']),'roster_needs_review':roster['needs_review'],
            'roster_added':len(roster['added']),'roster_removed':len(roster['removed']),
            'room_expected':sum(r.get('expected_students') or 0 for r in rooms),'rooms':rooms,
            'batches':details,
            'open_batches':sum(b.get('status')!='paired' and b['received_pages']>0 for b in details),'open_exceptions':len(exceptions),
            'scanned':sum(s.get('status')!='absent' for s in submissions),'results':counts,
            'published':bool(group.get('frozen')),'template_id':group.get('template_id')}
    state['publication_blockers']=publication_blockers(state)
    return state


@router.get('/groups/{identifier}/workflow')
def workflow(identifier:str,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN')
        return overview(db,require(db,identifier,'groups'),current)


@router.get('/groups/{identifier}/roster/changes')
def roster_changes(identifier:str,current=Depends(admin)):
    with connect() as db:
        return membership(db,require(db,identifier,'groups'))


@router.post('/groups/{identifier}/roster/review')
def review_roster(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已发布，请先发起复核')
        students=group_students(db,group)
        if students is None:raise HTTPException(409,'请先设置应考名单')
        if not isinstance(body.get('student_ids'),list) or any(not isinstance(s,str) for s in body['student_ids']):raise HTTPException(422,'学生编号列表无效')
        if sorted(body.get('student_ids',[]))!=sorted(s['id'] for s in students):raise HTTPException(409,'应考名单已变化，请刷新后重新核对')
        checkpoint={'group_id':identifier,'source':'membership-review','at':time.time(),'actor':current['id'],'students':students}
        if group.get('roster_review_id'):checkpoint['id']=group['roster_review_id']
        group['roster_review_id']=put(db,'rosters',checkpoint,current['id'])['id']
        put(db,'groups',group,current['id'])
        return {'reviewed':len(students)}


@router.post('/groups/{identifier}/scan-close')
def close_scanning(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已发布，请先发起复核')
        state=overview(db,group,current)
        if not state['template_id']:raise HTTPException(409,'请先发布版式')
        if not state['roster_configured']:raise HTTPException(409,'请先设置应考名单')
        if state['open_batches'] or state['open_exceptions']:raise HTTPException(409,'请先完成全部批次并处理异常')
        if body.get('confirm') is not True:raise HTTPException(422,'请确认全部考场、上传与入库情况已核对')
        if body.get('signature')!=state['scan_signature']:raise HTTPException(409,'扫描或名单数据已变化，请刷新后重新核对')
        group['scan_close']={'signature':state['scan_signature'],'at':time.time(),'actor':current['id'],'unscanned':state['results']['unscanned']}
        put(db,'groups',group,current['id'])
        return {'closed':True,'unscanned':state['results']['unscanned']}


def publication_blockers(state):
    issues=[]
    if not state['template_id']:issues.append('尚未发布版式')
    if state['open_batches']:issues.append('仍有未完成的扫描批次')
    if state['open_exceptions']:issues.append('仍有影响成绩的异常')
    if state['results']['pending'] or state['regrades']:issues.append('评分或重阅尚未完成')
    if not sum(state['results'].values()):issues.append('没有可发布的学生记录')
    return issues


@router.put('/{kind}/{identifier}/name')
def rename(kind:str,identifier:str,body:dict,current=Depends(admin)):
    if kind not in ('projects','subjects','groups'):raise HTTPException(404,'记录类型不存在')
    name=body.get('name')
    if not isinstance(name,str) or not 1<=len(name.strip())<=100:raise HTTPException(422,'名称需1至100字')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');value=require(db,identifier,kind)
        value['name']=name.strip()
        return put(db,kind,value,current['id'])


@router.post('/scan-batches/{identifier}/finish-empty')
def finish_empty(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');batch=require(db,identifier,'scan-batches')
        if require(db,batch['group_id'],'groups').get('frozen'):raise HTTPException(409,'成绩已发布，请先发起复核')
        if batch['status']=='frozen':raise HTTPException(409,'请先处理批次异常')
        if any(not p.get('excluded') for p in find(db,'pages',batch_id=identifier)):raise HTTPException(409,'有采集页面的批次请确认配对并入库')
        if body.get('confirm') is not True:raise HTTPException(422,'请确认该批次无需接收页面')
        batch.update(status='paired',completed_empty=True,completed_at=time.time())
        return put(db,'scan-batches',batch,current['id'])
