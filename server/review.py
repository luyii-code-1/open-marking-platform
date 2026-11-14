from .merged_questions import label as question_label
import io
import time
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from PIL import Image
from .db import connect, get, objects, put,find
from . import db as database
from .dependencies import user,admin,require
from .scoring import cents,final_score,objective_score
from .allocation import participants,ensure,allocate_arbitration

router=APIRouter(prefix='/api/v1')


def question_for(db,template_id,question_id):
    template=require(db,template_id,'templates')
    from .lifecycle import writable
    writable(db,'templates',template)
    question=next((q for q in template['questions'] if q['id']==question_id),None)
    if question is None: raise HTTPException(404,'题目不存在')
    return template,question


def own_task(db,identifier,current):
    task=require(db,identifier,'tasks')
    from .lifecycle import writable
    writable(db,'tasks',task)
    if current['role'] not in ('admin','manager') and task['user_id']!=current['id']: raise HTTPException(403,'无权访问该任务')
    return task


def public_task(task,db=None):
    value={k:v for k,v in task.items() if k not in ('student_id','candidate_number')}
    if db is not None:
        submission=get(db,task.get('submission_id'),'submissions') or {}
        group=get(db,submission.get('group_id'),'groups') or {}
        if group.get('grade_id'):
            from .room_tags import view
            value.update(grade_id=group['grade_id'],grade_name=(get(db,group['grade_id'],'grades') or {}).get('name',''),room_tags=view(db,submission.get('room_tags',[])))
    return value


def completed(db,submission_id,question_id):
    return sorted(find(db,'tasks',submission_id=submission_id,question_id=question_id,status='completed'),key=lambda t:t['created_at'])


def result_for(db,submission,question):
    if submission['status']=='absent': return 0
    if question['type']!='subjective':
        if question['id'] in submission.get('objective_overrides',{}):return objective_score(submission['objective_overrides'][question['id']],question.get('answer',[]),question['points'],question.get('rule'))
        selected=[]
        for page_id in submission['pages']:
            selected.extend(require(db,page_id,'pages').get('selections',{}).get(question['id'],[]))
        return objective_score(selected,question.get('answer',[]),question['points'],question.get('rule'))
    tasks=completed(db,submission['id'],question['id'])
    return final_score([t['score_cents'] for t in tasks],question.get('review_mode','single'),question.get('threshold',0))


@router.get('/tasks')
def tasks(current=Depends(user)):
    with connect() as db:
        return [public_task(t,db) for t in find(db,'tasks',user_id=current['id'],status='claimed')]


@router.get('/tasks/history')
def history(template_id:str|None=None,question_id:str|None=None,current=Depends(user)):
    with connect() as db:
        filters={'user_id':current['id'],'status':'completed'}
        if template_id:filters['template_id']=template_id
        if question_id:filters['question_id']=question_id
        output=[]
        for task in find(db,'tasks',**filters):
            final=db.execute('SELECT final_cents FROM review_results WHERE submission_id=? AND question_id=?',(task['submission_id'],task['question_id'])).fetchone()
            if final:task['final_score']=final[0]/100 if final[0] is not None else None
            output.append(public_task(task,db))
        return sorted(output,key=lambda t:(t['created_at'],t['id']))


@router.get('/review-progress')
def progress(template_id:str,question_id:str,current=Depends(user)):
    with connect() as db:
        template,question=question_for(db,template_id,question_id)
        assignments=find(db,'assignments',template_id=template_id,question_id=question_id)
        if current['role'] not in ('admin','manager') and not any(current['id'] in participants(a) for a in assignments):raise HTTPException(403,'未分配此题')
        if assignments:
            db.execute('BEGIN IMMEDIATE')
            ensure(db,template,question,assignments[-1])
            allocate_arbitration(db,template,question,assignments[-1])
        my_total=db.execute('SELECT COUNT(*) FROM review_allocations WHERE template_id=? AND question_id=? AND user_id=?',(template_id,question_id,current['id'])).fetchone()[0]
        count=db.execute("SELECT COUNT(*) FROM objects INDEXED BY object_submission WHERE kind='submissions' AND deleted=0 AND json_extract(body,'$.template_id')=? AND json_extract(body,'$.status')='ready'",(template_id,)).fetchone()[0]
        finalized=db.execute("SELECT COUNT(*) FROM review_results r JOIN objects s ON s.id=r.submission_id WHERE r.question_id=? AND r.final_cents IS NOT NULL AND s.deleted=0 AND json_extract(s.body,'$.template_id')=?",(question_id,template_id)).fetchone()[0]
        mine=find(db,'tasks',user_id=current['id'],template_id=template_id,question_id=question_id)
        regrade_count=db.execute('SELECT COUNT(*) FROM regrade_queue WHERE user_id=? AND template_id=? AND question_id=?',(current['id'],template_id,question_id)).fetchone()[0]
        all_final=db.execute("SELECT COUNT(*) FROM review_results r JOIN objects s ON s.id=r.submission_id WHERE r.final_cents IS NOT NULL AND s.deleted=0 AND json_extract(s.body,'$.template_id')=?",(template_id,)).fetchone()[0]
        objective=sum(q['type']!='subjective' for q in template['questions'])
        return {'my_regrade_pending':regrade_count,'my_total':my_total,'my_progress':round(100*sum(t['status']=='completed' for t in mine)/my_total,1) if my_total else 0,'total_submissions':count,'my_completed':sum(t['status']=='completed' for t in mine),'my_in_progress':sum(t['status']=='claimed' and t['expires_at']>time.time() for t in mine),'question_completed':finalized,'question_progress':round(100*finalized/count,1) if count else 0,'paper_progress':round(100*(all_final+objective*count)/(len(template['questions'])*count),1) if count and template['questions'] else 0}


@router.get('/tasks/{identifier}')
def details(identifier:str,current=Depends(user)):
    with connect() as db: return public_task(own_task(db,identifier,current),db)


@router.post('/tasks/claim')
def claim(body:dict,current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        template,question=question_for(db,body.get('template_id'),body.get('question_id'))
        if question['type']!='subjective': raise HTTPException(422,'客观题由系统给分')
        group=require(db,template['group_id'],'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结')
        assignments=find(db,'assignments',template_id=template['id'],question_id=question['id'])
        if not assignments:raise HTTPException(409,'请先配置阅卷教师')
        assignment=assignments[-1]
        if current['id'] not in participants(assignment):raise HTTPException(403,'尚未分配该题')
        ensure(db,template,question,assignment)
        allocate_arbitration(db,template,question,assignment)
        queued=db.execute('SELECT task_id FROM regrade_queue WHERE user_id=? AND template_id=? AND question_id=? ORDER BY position,task_id',(current['id'],template['id'],question['id'])).fetchall()
        for row in queued:
            task=require(db,row[0],'tasks')
            if task['status']=='completed':return public_task({**task,'regrading':True},db)
            db.execute('DELETE FROM regrade_queue WHERE task_id=?',(row[0],))
        existing=find(db,'tasks',user_id=current['id'],question_id=question['id'],status='claimed')
        for task in existing:
            if task['user_id']==current['id'] and task['question_id']==question['id'] and task['status']=='claimed':
                if task['expires_at']>time.time():
                    task['expires_at']=time.time()+900
                    return public_task(put(db,'tasks',task,current['id']),db)
                task['status']='expired';put(db,'tasks',task,current['id'])
        import json
        # Remove TEXT column affinity on the correlated UUID so SQLite can
        # seek the JSON expression index rather than scan every task.
        rows=db.execute('''SELECT s.body FROM objects s INDEXED BY object_submission WHERE s.kind='submissions' AND s.deleted=0
            AND json_extract(s.body,'$.template_id')=? AND json_extract(s.body,'$.status')='ready'
            AND EXISTS(SELECT 1 FROM review_allocations a WHERE a.submission_id=s.id AND a.question_id=? AND a.user_id=?
                AND (a.round<3 OR (SELECT COUNT(*) FROM objects t INDEXED BY object_task_answer WHERE t.kind='tasks' AND t.deleted=0 AND json_extract(t.body,'$.submission_id')=+s.id AND json_extract(t.body,'$.question_id')=a.question_id AND json_extract(t.body,'$.status')='completed')=2))
            AND NOT EXISTS(SELECT 1 FROM review_results r WHERE r.submission_id=s.id AND r.question_id=? AND r.final_cents IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM objects t INDEXED BY object_task_answer WHERE t.kind='tasks' AND t.deleted=0
                AND json_extract(t.body,'$.submission_id')=+s.id AND json_extract(t.body,'$.question_id')=?
                AND json_extract(t.body,'$.status')='completed' AND json_extract(t.body,'$.user_id')=?)
            AND (SELECT COUNT(*) FROM objects t INDEXED BY object_task_answer WHERE t.kind='tasks' AND t.deleted=0
                AND json_extract(t.body,'$.submission_id')=+s.id AND json_extract(t.body,'$.question_id')=?
                AND (json_extract(t.body,'$.status')='completed' OR (json_extract(t.body,'$.status')='claimed' AND json_extract(t.body,'$.expires_at')>?)))
                < CASE WHEN ?='single' THEN 1 ELSE
                    CASE WHEN (SELECT COUNT(*) FROM objects t INDEXED BY object_task_answer WHERE t.kind='tasks' AND t.deleted=0
                        AND json_extract(t.body,'$.submission_id')=+s.id AND json_extract(t.body,'$.question_id')=? AND json_extract(t.body,'$.status')='completed')<2 THEN 2 ELSE 3 END END
            ORDER BY COALESCE((SELECT MAX(json_extract(t.body,'$.skipped_at')) FROM objects t INDEXED BY object_task_answer WHERE t.kind='tasks' AND t.deleted=0 AND json_extract(t.body,'$.submission_id')=+s.id AND json_extract(t.body,'$.question_id')=? AND json_extract(t.body,'$.status')='skipped' AND json_extract(t.body,'$.user_id')=?),0)
            LIMIT 1''',(template['id'],question['id'],current['id'],question['id'],question['id'],current['id'],question['id'],time.time(),question.get('review_mode','single'),question['id'],question['id'],current['id'])).fetchall()
        for row in rows:
            submission=json.loads(row['body'])
            relevant=find(db,'tasks',submission_id=submission['id'],question_id=question['id'])
            if any(t['user_id']==current['id'] and t['status']=='completed' for t in relevant): continue
            if result_for(db,submission,question) is not None: continue
            done=[t for t in relevant if t['status']=='completed']
            live=[t for t in relevant if t['status']=='claimed' and t['expires_at']>time.time()]
            slots=1 if question.get('review_mode','single')=='single' else (2 if len(done)<2 else 3)
            if len(done)+len(live)>=slots: continue
            for stale in relevant:
                if stale['status']=='claimed' and stale['expires_at']<=time.time():
                    stale['status']='expired'; put(db,'tasks',stale,current['id'])
            from .answer_slices import sync
            submission=sync(db,submission,template,current['id'])
            task=put(db,'tasks',{'template_id':template['id'],'question_id':question['id'],'submission_id':submission['id'],'student_id':submission['student_id'],'student_name':'匿名作答','user_id':current['id'],'status':'claimed','created_at':time.time(),'expires_at':time.time()+900,'score':None,'final_score':None,'regions':question['regions']},current['id'])
            task['answer_slice_id']=submission.get('answer_slice_ids',{}).get(question['id'])
            task['image_url']=f"/api/v1/tasks/{task['id']}/image"
            return public_task(put(db,'tasks',task,current['id']),db)
        return None


@router.post('/tasks/{identifier}/score')
def score(identifier:str,body:dict,current=Depends(user)):
    try: amount=cents(body['score'])
    except (KeyError,ValueError,ArithmeticError): raise HTTPException(422,'分值无效')
    key=str(body.get('idempotency_key',''))
    if not 1<=len(key)<=200: raise HTTPException(422,'需要提交幂等编号')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        task=own_task(db,identifier,current)
        if task['status']=='invalidated': raise HTTPException(409,'作答已更正，需要重新评阅')
        prior=db.execute('SELECT * FROM scores WHERE user_id=? AND idempotency_key=?',(current['id'],key)).fetchone()
        if prior:
            if prior['task_id']!=identifier or prior['score']!=amount: raise HTTPException(409,'提交编号已用于其他评分')
            return {**public_task(task,db),'accepted_operation':{'id':key,'score':amount/100}}
        template,question=question_for(db,task['template_id'],task['question_id'])
        group=require(db,template['group_id'],'groups')
        if group.get('frozen'): raise HTTPException(409,'成绩已冻结，请联系管理员复核')
        if task['status'] not in ('claimed','completed') or (task['status']=='claimed' and task['expires_at']<time.time()): raise HTTPException(409,'任务已失效，请重新领取')
        if 'offline_protocol' in body:
            if type(body['offline_protocol']) is not int or body['offline_protocol']!=1:raise HTTPException(422,'离线评分协议不受支持')
            revision=body.get('base_score_revision')
            if type(revision) is not int or revision<0:raise HTTPException(422,'缺少有效的评分版本')
            if revision!=task.get('score_revision',0):raise HTTPException(409,'评分已在其他窗口更新，本地记录已保留，请核对后再评阅')
        if not 0<=amount<=cents(question['points']): raise HTTPException(422,'分值超出范围')
        step=cents(question.get('step',.5))
        if step<=0 or amount%step: raise HTTPException(422,'分值不符合评分步长')
        task.update(status='completed',score_cents=amount,score=amount/100,score_revision=task.get('score_revision',0)+1)
        put(db,'tasks',task,current['id'])
        submission=require(db,task['submission_id'],'submissions')
        final=result_for(db,submission,question)
        db.execute('INSERT INTO review_results VALUES(?,?,?) ON CONFLICT(submission_id,question_id) DO UPDATE SET final_cents=excluded.final_cents',(submission['id'],question['id'],final))
        task['final_score']=final/100 if final is not None else None
        put(db,'tasks',task,current['id'])
        db.execute('INSERT INTO scores VALUES(?,?,?,?,?)',(str(uuid4()),identifier,current['id'],amount,key))
        db.execute('DELETE FROM regrade_queue WHERE task_id=?',(identifier,))
        return {**public_task(task,db),'accepted_operation':{'id':key,'score':amount/100}}


@router.get('/review/offline-capabilities')
def offline_capabilities(current=Depends(user)):
    return {'protocols':[1],'score_revision':True}


@router.post('/tasks/{identifier}/regrade-from')
def regrade_from(identifier:str,body:dict,current=Depends(user)):
    if not str(body.get('reason','')).strip():raise HTTPException(422,'请填写重阅原因')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        first=own_task(db,identifier,current)
        if first['user_id']!=current['id'] or first['status']!='completed':raise HTTPException(409,'请选择本人已完成的一份评分')
        template,_=question_for(db,first['template_id'],first['question_id'])
        if require(db,template['group_id'],'groups').get('frozen'):raise HTTPException(409,'成绩已冻结，请联系管理员复核')
        tasks=sorted(find(db,'tasks',user_id=current['id'],template_id=template['id'],question_id=first['question_id'],status='completed'),key=lambda t:(t['created_at'],t['id']))
        tasks=[t for t in tasks if (t['created_at'],t['id'])>=(first['created_at'],first['id'])]
        position=time.time_ns()
        for i,task in enumerate(tasks):
            db.execute('INSERT INTO regrade_queue VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET position=excluded.position',(task['id'],current['id'],template['id'],first['question_id'],position+i))
        put(db,'regrade-events',{'task_id':identifier,'template_id':template['id'],'question_id':first['question_id'],'user_id':current['id'],'reason':body['reason'],'count':len(tasks)},current['id'])
        return {'queued':len(tasks)}


@router.post('/tasks/{identifier}/skip')
def skip(identifier:str,current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        task=own_task(db,identifier,current)
        queued=db.execute('SELECT 1 FROM regrade_queue WHERE task_id=? AND user_id=?',(identifier,current['id'])).fetchone()
        if task['status']=='completed' and queued:
            db.execute('UPDATE regrade_queue SET position=? WHERE task_id=?',(time.time_ns(),identifier))
            return public_task(task,db)
        if task['status']!='claimed': raise HTTPException(409,'只能跳过待评分任务')
        task['status']='skipped';task['skipped_at']=time.time()
        return public_task(put(db,'tasks',task,current['id']),db)


@router.post('/tasks/{identifier}/report')
def report(identifier:str,body:dict,current=Depends(user)):
    if body.get('kind') not in ('exception','excellent'): raise HTTPException(422,'报告类型无效')
    with connect() as db:
        task=own_task(db,identifier,current)
        return put(db,'exceptions',{'task_id':identifier,'submission_id':task['submission_id'],'kind':body['kind'],'reason':str(body.get('reason','')),'status':'open'},current['id'])


@router.get('/tasks/{identifier}/image')
def image(identifier:str,current=Depends(user)):
    with connect() as db:
        task=own_task(db,identifier,current)
        submission=require(db,task['submission_id'],'submissions')
        _,question=question_for(db,task['template_id'],task['question_id'])
        answer=get(db,task.get('answer_slice_id'),'answer-slices')
    override=submission.get('region_overrides',{}).get(question['id'],{})
    if answer:override={'asset_id':answer.get('asset_id')}
    if override.get('asset_id'):
        from fastapi.responses import FileResponse
        from .storage import materialize
        return FileResponse(materialize('assets/'+override['asset_id']+'.png'),headers={'Cache-Control':'private, no-store'})
    pieces=[]
    sources=answer['sources'] if answer else [{'region':r} for r in override.get('regions',question['regions'])]
    for source in sources:
        region=source['region']
        page=int(region['page'])-1
        if page>=len(submission['pages']): raise HTTPException(409,'答卷缺页')
        from .scanner_pipeline import local_piece
        prepared=local_piece(source.get('page_id',submission['pages'][page]),question['id'],region,source.get('normalized_sha256'))
        if prepared is not None:
            with Image.open(io.BytesIO(prepared)) as cut:pieces.append(cut.convert('RGB'))
            continue
        from .storage import remote_piece
        prepared=remote_piece('pages/'+source.get('page_id',submission['pages'][page])+'.png',region)
        if prepared is not None:
            with Image.open(io.BytesIO(prepared)) as cut:pieces.append(cut.convert('RGB'))
            continue
        from .storage import materialize
        try:path=materialize('pages/'+source.get('page_id',submission['pages'][page])+'.png')
        except FileNotFoundError:raise HTTPException(409,'校正图尚未就绪')
        if not path.exists(): raise HTTPException(409,'校正图尚未就绪')
        with Image.open(path) as original:
            x,y,w,h=(region[k]*4 for k in ('x','y','width','height'))
            pieces.append(original.crop((int(x),int(y),int(x+w),int(y+h))).convert('RGB'))
    if not pieces: raise HTTPException(409,'题目没有答题区')
    merged=Image.new('RGB',(max(p.width for p in pieces),sum(p.height for p in pieces)+12*(len(pieces)-1)),'white')
    top=0
    for piece in pieces: merged.paste(piece,(0,top)); top+=piece.height+12
    buffer=io.BytesIO(); merged.save(buffer,format='JPEG',quality=90)
    return Response(buffer.getvalue(),media_type='image/jpeg',headers={'Cache-Control':'private, no-store'})


@router.get('/exceptions')
def exceptions(group_id:str|None=None,status:str|None=None,room_tag_id:str|None=None,current=Depends(admin)):
    with connect() as db:
        from .room_tags import exception_tags,includes
        output=[]
        for item in objects(db,'exceptions'):
            item={**item,'room_tags':exception_tags(db,item)}
            if not includes(item,room_tag_id):continue
            if not item.get('group_id'):
                submission=get(db,item.get('submission_id'),'submissions')
                batch=get(db,item.get('batch_id'),'scan-batches')
                item['group_id']=(submission or batch or {}).get('group_id')
            if (group_id is None or item.get('group_id')==group_id) and (status is None or item['status']==status):output.append(item)
        return output


@router.get('/exceptions/{identifier}')
def exception_details(identifier:str,current=Depends(admin)):
    with connect() as db:
        item=require(db,identifier,'exceptions')
        submission=get(db,item.get('submission_id'),'submissions')
        task=get(db,item.get('task_id'),'tasks')
        if not submission and task:submission=get(db,task['submission_id'],'submissions')
        page=get(db,item.get('page_id'),'pages')
        if not page and submission and submission['pages']:page=get(db,submission['pages'][0],'pages')
        batch=get(db,item.get('batch_id') or (page or {}).get('batch_id'),'scan-batches')
        group=get(db,item.get('group_id') or (submission or batch or {}).get('group_id'),'groups')
        subject=get(db,(group or {}).get('subject_id'),'subjects')
        project=get(db,(subject or {}).get('project_id'),'projects')
        pages=[get(db,p,'pages') for p in submission['pages']] if submission else [page] if page else []
        template=get(db,(submission or {}).get('template_id') or (batch or {}).get('template_id'),'templates')
        student=(submission or {}).get('student_snapshot') or get(db,(submission or {}).get('student_id'),'students')
        from .school import student_view
        from .room_tags import view as room_view
        if student and (group or {}).get('grade_id'):student=student_view(db,student)
        return {'exception':item,'context':{'project':(project or {}).get('name'),'subject':(subject or {}).get('name'),'group':(group or {}).get('name'),'room':(batch or {}).get('room'),'room_tags':room_view(db,(submission or batch or {}).get('room_tags',[])), 'grade':(get(db,(group or {}).get('grade_id'),'grades') or {}).get('name'),'candidate_number':(submission or page or {}).get('candidate_number'),'student_name':(student or {}).get('name')},'pages':[{'id':p['id'],'side':p['side'],'sequence':p['sequence'],'status':p['status'],'image_url':f"/api/v1/pages/{p['id']}/image",'selections':{str(q['number']):p.get('selections',{}).get(q['id'],[]) for q in (template or {}).get('questions',[]) if q['type']!='subjective' and q['id'] in p.get('selections',{})}} for p in pages if p],'answer_image_url':f"/api/v1/tasks/{task['id']}/image" if task else None}


@router.post('/exceptions/resolve')
def resolve_many(body:dict,current=Depends(admin)):
    identifiers=body.get('ids',[]);resolution=str(body.get('resolution','')).strip()
    if not isinstance(identifiers,list) or not 1<=len(identifiers)<=500 or any(not isinstance(i,str) for i in identifiers) or not resolution:raise HTTPException(422,'请选择1至500条记录并填写核查结论')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        items=[require(db,i,'exceptions') for i in set(identifiers)]
        for item in items:
            item.update(status='resolved',resolution=resolution,resolved_at=time.time());put(db,'exceptions',item,current['id'])
        return {'resolved':len(items)}


@router.post('/exceptions/{identifier}/resolve')
def resolve(identifier:str,body:dict,current=Depends(admin)):
    if not str(body.get('resolution','')).strip():raise HTTPException(422,'请填写核查结论')
    with connect() as db:
        exception=require(db,identifier,'exceptions')
        exception.update(status='resolved',resolution=str(body['resolution']).strip(),resolved_at=time.time())
        return put(db,'exceptions',exception,current['id'])


@router.get('/results')
def results(group_id:str,room_tag_id:str|None=None,current=Depends(user)):
    with connect() as db:
        from .room_tags import includes
        return [row for row in results_for(db,group_id,current) if includes(row,room_tag_id)]


def results_for(db,group_id,current,convert_scores=True):
    group=require(db,group_id,'groups')
    roster=require(db,group['roster_id'],'rosters') if group.get('roster_id') else None
    from .school import group_students,student_view
    from .room_tags import view as room_view
    live=bool(group.get('grade_id'))
    members=group_students(db,group)
    roster_students={s['id']:s for s in members or []}
    classes={c['id']:c for c in objects(db,'classes')}
    def identity(student):
        if live:
            value=student_view(db,student)
            return {**{k:value.get(k) for k in ('name','class_id','class_name','grade','grade_id')},'student_id':student['id'],'group_grade_id':group['grade_id']}
        saved=roster_students.get(student['id'],{})
        label=saved if saved.get('class_id')==student['class_id'] else {}
        cls=classes.get(student['class_id'],{})
        return {'student_id':student['id'],'name':student['name'],'class_id':student['class_id'],
                'class_name':student.get('class_name',label.get('class_name',cls.get('name',student['class_id']))),
                'grade':student.get('grade',label.get('grade',cls.get('grade')))}
    allowed_classes=None
    if current['role'] not in ('admin','manager'):
        from .visibility import class_scope,groups_for_classes
        allowed_classes=class_scope(db,current['id'],group.get('subject_id'))
        if group_id not in groups_for_classes(db,allowed_classes): raise HTTPException(403,'成绩尚未发布或不属于任教班级')
    output=[]
    for submission in objects(db,'submissions'):
        if submission['group_id']!=group_id: continue
        student=submission.get('student_snapshot') or require(db,submission['student_id'],'students')
        template=require(db,submission['template_id'],'templates')
        scores={question_label(q):result_for(db,submission,q) for q in template['questions']}
        ready=all(v is not None for v in scores.values())
        output.append({**identity(student),'candidate_number':student_view(db,student)['candidate_number'] if live else submission['candidate_number'],'scanned_candidate_number':submission['candidate_number'],'room_tags':room_view(db,submission.get('room_tags',[])) if live else submission.get('room_tags',[]),'scores':{k:v/100 if v is not None else None for k,v in scores.items()},'total':sum(scores.values())/100 if ready else None,'status':'absent' if submission['status']=='absent' else 'completed' if ready else 'pending'})
    if members is not None:
        seen={r['student_id'] for r in output}
        template=get(db,group.get('template_id'),'templates') or {'questions':[]}
        for student in members:
            if student['id'] not in seen:
                output.append({**identity(student),'candidate_number':student['candidate_number'],'scores':{question_label(q):None for q in template['questions']},'total':None,'status':'unscanned'})
    if group.get('conversion_id') and convert_scores:
        from .conversion import apply,active_config
        conversion=active_config(group,require(db,group['conversion_id'],'score-conversions'))
        try:apply(output,conversion)
        except ValueError as error:raise HTTPException(422,str(error))
    return [row for row in output if allowed_classes is None or row['class_id'] in allowed_classes]


@router.post('/results/publish')
def publish_results(body:dict,current=Depends(admin)):
    group_id=body.get('group_id')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        rows=results_for(db,group_id,current)
        if not rows or any(r['status'] not in ('completed','absent','unscanned') for r in rows): raise HTTPException(409,'阅卷尚未全部完成')
        unscanned=[r['student_id'] for r in rows if r['status']=='unscanned']
        if unscanned and body.get('force_unscanned') is not True:raise HTTPException(409,f'有{len(unscanned)}名应考学生未扫描，可明确确认后强制发布')
        if unscanned and not str(body.get('reason','')).strip():raise HTTPException(422,'请填写强制发布原因')
        group=require(db,group_id,'groups')
        from .workflow import overview,publication_blockers
        blockers=publication_blockers(overview(db,group,current))
        if blockers:raise HTTPException(409,'；'.join(blockers))
        submissions={s['id'] for s in objects(db,'submissions') if s['group_id']==group_id}
        batches={b['id'] for b in objects(db,'scan-batches') if b['group_id']==group_id}
        if db.execute("SELECT 1 FROM regrade_queue r JOIN objects t ON t.id=r.task_id JOIN objects s ON s.id=json_extract(t.body,'$.submission_id') WHERE s.deleted=0 AND json_extract(s.body,'$.group_id')=? LIMIT 1",(group_id,)).fetchone():raise HTTPException(409,'存在尚未完成的重阅任务')
        if any(e['status']=='open' and e['kind']!='excellent' and (e.get('submission_id') in submissions or e.get('batch_id') in batches) for e in objects(db,'exceptions')): raise HTTPException(409,'存在未处理异常')
        put(db,'publication-events',{'group_id':group_id,'forced_unscanned':bool(unscanned),'unscanned_student_ids':unscanned,'reason':str(body.get('reason',''))},current['id'])
        if group.get('conversion_id') and not group.get('frozen'):
            from copy import deepcopy
            group['conversion_snapshot']=deepcopy(require(db,group['conversion_id'],'score-conversions'))
            group['conversion_revision']=group['conversion_snapshot'].get('revision',1)
        group.update(frozen=True,published_at=time.time(),published_unscanned_count=len(unscanned))
        return put(db,'groups',group,current['id'])


@router.get('/tasks/{identifier}/image-manifest')
def image_manifest(identifier:str,current=Depends(user)):
    from .review_images import manifest
    from fastapi.responses import JSONResponse
    return JSONResponse(manifest(identifier,current),headers={'Cache-Control':'private, no-store'})


@router.get('/tasks/{identifier}/image-source/{index}')
def image_source(identifier:str,index:int,version:str='',current=Depends(user)):
    from .review_images import proxy
    return proxy(identifier,index,version,current)
