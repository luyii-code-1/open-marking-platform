"""Read models for a card's roster, capture and publication workflow."""
import time
import hashlib
import json
from fastapi import APIRouter, Depends, HTTPException, Query
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
    roster_ids={student['id'] for student in roster['students']}
    scanned_ids={submission['student_id'] for submission in submissions if submission.get('pages')}
    state['roster_scanned']=len(roster_ids & scanned_ids)
    state['scanned_students']=len(scanned_ids)
    state['unpaired_pages']=sum(max(0,b['received_pages']-b['linked_pages']) for b in details)
    # Count scores against the version actually used by each submitted sheet.
    from .merged_questions import label
    templates={}
    by_student={r['student_id']:r for r in rows}
    progress={kind:{'done':0,'total':0} for kind in ('objective','subjective')}
    for submission in submissions:
        if submission['status']=='absent':continue
        tid=submission['template_id']
        if tid not in templates:templates[tid]=require(db,tid,'templates')
        scores=by_student.get(submission['student_id'],{}).get('scores',{})
        for question in templates[tid]['questions']:
            counter=progress['subjective' if question['type']=='subjective' else 'objective']
            counter['total']+=1
            counter['done']+=int(scores.get(label(question)) is not None)
    active=templates.get(group.get('template_id')) or get(db,group.get('template_id'),'templates') or {}
    state['missing_answers']=[q['number'] for q in active.get('questions',[]) if q['type']!='subjective' and not q.get('answer')]
    state['grading_progress']=progress
    expected=len(roster['students']) if roster['configured'] else state['room_expected'] or len(submissions)
    absent_ids={s['student_id'] for s in submissions if s.get('status')=='absent'}
    absent=len(absent_ids)
    unscanned=max(0,expected-len(scanned_ids|absent_ids))
    state['scan']={'received':len(scanned_ids),'expected':expected,'pending':unscanned,'exceptions':len(exceptions),'absent':absent}
    task_counts={}
    for task in objects(db,'tasks'):
        if task.get('status')=='completed':
            key=(task.get('submission_id'),task.get('question_id'))
            task_counts[key]=task_counts.get(key,0)+1
    arbitration=0
    for submission in submissions:
        if submission.get('status')!='ready':continue
        template=templates.get(submission['template_id'],{})
        scores=by_student.get(submission['student_id'],{}).get('scores',{})
        arbitration+=sum(q['type']=='subjective' and q.get('review_mode')=='double' and task_counts.get((submission['id'],q['id']),0)==2 and scores.get(label(q)) is None for q in template.get('questions',[]))
    exception_submissions={exception_source(db,e).get('id') for e in exceptions if exception_source(db,e).get('id') in {s['id'] for s in submissions}}
    for kind in ('objective','subjective'):
        question_count=sum((q['type']=='subjective')==(kind=='subjective') for q in active.get('questions',[]))
        done=progress[kind]['done'];total=progress[kind]['total']
        blocked=len(exception_submissions)*question_count
        pending=max(0,total-done-(arbitration if kind=='subjective' else 0))
        state[kind]={'total':total,'completed':done,'pending':max(0,pending-blocked),'exceptions':min(pending,blocked),'unscanned':unscanned*question_count}
        if kind=='subjective':state[kind]['arbitration']=arbitration
    from .lifecycle import project_for
    project=get(db,project_for(db,'groups',group),'projects') or {}
    state['scans_purged']=bool(project.get('scans_purged'))
    state['objective_reprocess_allowed']=bool(not group.get('frozen') and not state['scans_purged'] and any(q['type']!='subjective' for q in active.get('questions',[])) and any(b['recognized_pages'] for b in details))
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


@router.post('/groups/{identifier}/objective/reprocess',status_code=202)
def reprocess_objective(identifier:str,current=Depends(admin)):
    from .jobs import create_job,dispatch
    from .lifecycle import writable,project_for
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups');writable(db,'groups',group)
        if group.get('frozen'):raise HTTPException(409,'成绩已发布，请先发起复核')
        template=require(db,group.get('template_id'),'templates')
        if not any(q['type']!='subjective' for q in template['questions']):raise HTTPException(422,'当前题卡没有客观题')
        project_id=project_for(db,'groups',group)
        for job in find(db,'jobs',project_id=project_id):
            if job['kind']=='objective-reprocess' and job.get('payload',{}).get('group_id')==identifier and job['status'] in ('pending','running'):return job
        job=create_job(db,'objective-reprocess',{'group_id':identifier},project_id,current['id'])
    dispatch(job['id'],background=True)
    return job


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
    if state.get('missing_answers'):issues.append('请补录客观题答案：'+ '、'.join(map(str,state['missing_answers'])))
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


@router.get('/projects/{identifier}/scanned-sheets')
def scanned_sheets(identifier:str,q:str='',group_id:str|None=None,page:int=1,
                   grade_ids:list[str]=Query(default=[]),class_ids:list[str]=Query(default=[]),
                   subject_ids:list[str]=Query(default=[]),group_ids:list[str]=Query(default=[]),
                   sort_by:str='candidate_number',sort_order:str='asc',current=Depends(admin)):
    term=q.strip()
    selected=[grade_ids,class_ids,subject_ids,group_ids]
    if len(term)>100 or not 1<=page<=1000000 or any(len(values)>200 or any(not value or len(value)>100 for value in values) for values in selected):
        raise HTTPException(422,'查询条件或页码无效')
    if sort_by not in ('name','candidate_number','grade','class_name','subject','card','image_status') or sort_order not in ('asc','desc'):
        raise HTTPException(422,'排序字段或方向无效')
    with connect() as db:
        db.execute('BEGIN')
        project=require(db,identifier,'projects')
        if group_id:
            from .room_tags import project_for_group
            if project_for_group(db,group_id)!=identifier:raise HTTPException(404,'题卡不属于本考试')
        class_id="COALESCE(json_extract(s.body,'$.student_snapshot.class_id'),json_extract(st.body,'$.class_id'))"
        grade_id="COALESCE(json_extract(g.body,'$.grade_id'),json_extract(cl.body,'$.grade_id'))"
        class_name="COALESCE(json_extract(s.body,'$.student_snapshot.class_name'),json_extract(cl.body,'$.name'),'')"
        grade_name="COALESCE(json_extract(gr.body,'$.name'),json_extract(s.body,'$.student_snapshot.grade'),json_extract(cl.body,'$.grade'),'')"
        source=f"""FROM objects s JOIN objects g ON g.id=json_extract(s.body,'$.group_id') AND g.kind='groups' AND g.deleted=0
            JOIN objects subj ON subj.id=json_extract(g.body,'$.subject_id') AND subj.kind='subjects' AND subj.deleted=0
            LEFT JOIN objects st ON st.id=json_extract(s.body,'$.student_id') AND st.kind='students' AND st.deleted=0
            LEFT JOIN objects cl ON cl.id={class_id} AND cl.kind='classes'
            LEFT JOIN objects gr ON gr.id={grade_id} AND gr.kind='grades'
            WHERE s.kind='submissions' AND s.deleted=0 AND json_array_length(s.body,'$.pages')>0
            AND json_extract(subj.body,'$.project_id')=? AND (? IS NULL OR g.id=?)"""
        base_params=(identifier,group_id,group_id)
        projection=f"""SELECT g.id AS group_id,json_extract(g.body,'$.name') AS card,
            subj.id AS subject_id,json_extract(subj.body,'$.name') AS subject,
            {grade_id} AS grade_id,{grade_name} AS grade,{class_id} AS class_id,{class_name} AS class_name """
        options={name:{} for name in ('grades','classes','subjects','groups')}
        for row in db.execute('SELECT DISTINCT '+projection.removeprefix('SELECT ')+source,base_params):
            if row['grade_id']:options['grades'][row['grade_id']]={'id':row['grade_id'],'name':row['grade']}
            if row['class_id']:options['classes'][row['class_id']]={'id':row['class_id'],'name':row['class_name'],'grade_id':row['grade_id'],'grade':row['grade']}
            options['subjects'][row['subject_id']]={'id':row['subject_id'],'name':row['subject']}
            options['groups'][row['group_id']]={'id':row['group_id'],'name':row['card'],'subject_id':row['subject_id'],'subject':row['subject'],'grade_id':row['grade_id'],'grade':row['grade']}
        conditions=[];params=list(base_params)
        for expression,values in zip((grade_id,class_id,'subj.id','g.id'),selected):
            if values:
                ids=list(dict.fromkeys(values));conditions.append(expression+' IN ('+','.join('?' for _ in ids)+')');params.extend(ids)
        if term:
            conditions.append("""(instr(lower(json_extract(s.body,'$.student_snapshot.name')),lower(?))>0
                OR instr(lower(json_extract(st.body,'$.name')),lower(?))>0
                OR instr(json_extract(s.body,'$.candidate_number'),?)>0
                OR instr(json_extract(st.body,'$.candidate_number'),?)>0)""")
            params.extend([term]*4)
        filtered=source+(' AND '+' AND '.join(conditions) if conditions else '')
        total=db.execute('SELECT count(*) '+filtered,params).fetchone()[0]
        purged=bool(project.get('scans_purged'))
        name="COALESCE(NULLIF(json_extract(s.body,'$.student_snapshot.name'),''),json_extract(st.body,'$.name'),'')"
        image_status="'purged'" if purged else "CASE WHEN EXISTS(SELECT 1 FROM json_each(s.body,'$.pages') pid JOIN objects image ON image.id=pid.value AND image.kind='pages' AND image.deleted=0) THEN 'available' ELSE 'missing' END"
        sort_fields={'name':name,'candidate_number':"json_extract(s.body,'$.candidate_number')",'grade':grade_name,
                     'class_name':class_name,'subject':"json_extract(subj.body,'$.name')",'card':"json_extract(g.body,'$.name')",'image_status':image_status}
        direction='DESC' if sort_order=='desc' else 'ASC'
        matches=db.execute(f"SELECT s.id,s.body,{name} AS name,{image_status} AS image_status,"+projection.removeprefix('SELECT ')+filtered+
                           f" ORDER BY {sort_fields[sort_by]} COLLATE NOCASE {direction},s.id ASC LIMIT 20 OFFSET ?",(*params,(page-1)*20))
        items=[]
        for row in matches:
            sub=json.loads(row['body']);pages=[]
            if not purged:
                for pid in sub['pages']:
                    image=get(db,pid,'pages')
                    if image:pages.append({'id':pid,'side':image.get('side'),'image_url':f'/api/v1/pages/{pid}/image'})
            items.append({'id':row['id'],'name':row['name'],
                          'candidate_number':sub['candidate_number'],**{key:row[key] for key in ('subject','subject_id','card','group_id','grade','grade_id','class_id','class_name')},'pages':pages,
                          'image_status':row['image_status']})
        return {'items':items,'total':total,'page':page,'options':{name:sorted(values.values(),key=lambda row:(row['name'] or '',row['id'])) for name,values in options.items()},
                'sort_by':sort_by,'sort_order':sort_order,'scope':{'project_id':identifier,'group_id':group_id,'scans_purged':purged}}
