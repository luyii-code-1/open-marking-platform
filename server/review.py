from .lifecycle import RESULTS_REVIEW_GUIDE
from .merged_questions import label as question_label
import io
import json
import time
from decimal import Decimal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from math import ceil
from PIL import Image
from .db import connect, get, objects, put,find
from . import db as database
from .dependencies import user,admin,require
from .scoring import cents,final_score,objective_score
from .allocation import participants,ensure,allocate_arbitration,progress as allocation_progress,pools
from .exam_status import project_views

from .review_writes import submit as submit_write

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
    authorize_task(db,task,current)
    return task


def authorize_task(db,task,current):
    from .lifecycle import writable
    writable(db,'tasks',task)
    if current['role'] not in ('admin','manager') and task['user_id']!=current['id']: raise HTTPException(403,'无权访问该任务')


def public_task(task,db=None,submission=None,group=None,review_role=None):
    value={k:v for k,v in task.items() if k not in ('student_id','candidate_number')}
    if db is not None:
        if review_role is None:
            allocated=db.execute('SELECT round FROM review_allocations WHERE submission_id=? AND question_id=? AND user_id=?',(task['submission_id'],task['question_id'],task['user_id'])).fetchone()
            review_role='arbitration' if allocated and allocated['round']==3 else 'ordinary'
        value['review_role']=review_role
        if submission is None:submission=get(db,task.get('submission_id'),'submissions') or {}
        if group is None:group=get(db,submission.get('group_id'),'groups') or {}
        if group.get('grade_id'):
            from .room_tags import view
            value.update(grade_id=group['grade_id'],grade_name=(get(db,group['grade_id'],'grades') or {}).get('name',''),room_tags=view(db,submission.get('room_tags',[])))
    return value


def tasks_for_answer(db, submission_id, question_id, completed_only=False):
    rows = db.execute("""SELECT body FROM (
        SELECT body,kind,deleted,rowid FROM objects WHERE body::jsonb #>> '{submission_id}'=?
          AND body::jsonb #>> '{question_id}'=? OFFSET 0
        ) answer WHERE kind='tasks' AND deleted=0 AND (NOT ? OR body::jsonb #>> '{status}'='completed')
        ORDER BY rowid""", (submission_id, question_id, completed_only))
    return [json.loads(row[0]) for row in rows]


def completed(db,submission_id,question_id):
    return sorted(tasks_for_answer(db,submission_id,question_id,completed_only=True),key=lambda t:t['created_at'])


def objective_selections(db,submission):
    answers={}
    for pid in submission.get('pages',[]):
        for qid,selected in require(db,pid,'pages').get('selections',{}).items():
            answers.setdefault(qid,set()).update(selected)
    answers.update({qid:set(selected) for qid,selected in submission.get('objective_overrides',{}).items()})
    return answers


def result_for(db,submission,question,scored_task=None,*,selections=None):
    if submission['status']=='absent': return 0
    if question['type']!='subjective':
        if not question.get('answer'):return None
        if question['id'] in submission.get('objective_overrides',{}):return objective_score(submission['objective_overrides'][question['id']],question.get('answer',[]),question['points'],question.get('rule'))
        answers=selections if selections is not None else objective_selections(db,submission)
        return objective_score(answers.get(question['id'],()),question['answer'],question['points'],question.get('rule'))
    tasks=completed(db,submission['id'],question['id'])
    if scored_task is not None:
        for index, previous in enumerate(tasks):
            if previous['id'] == scored_task['id']:
                tasks[index] = scored_task
                break
        else:
            tasks.append(scored_task)
            tasks.sort(key=lambda task: task['created_at'])
    return final_score([t['score_cents'] for t in tasks],question.get('review_mode','single'),question.get('threshold',0),question.get('threshold_inclusive',True))


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


def _group_lock_flags(group: dict) -> tuple[bool, bool]:
    published = bool(group.get('frozen'))
    reopened = bool(not published and group.get('reopened_at') and group.get('published_at'))
    return published, reopened

def _group_lock_dict(group: dict) -> dict[str, bool]:
    published, reopened = _group_lock_flags(group)
    return {'published': published, 'reopened': reopened}

def _ensure_group_unlocked(group: dict) -> None:
    if group.get('frozen'):
        raise HTTPException(409, f'成绩已锁定，{RESULTS_REVIEW_GUIDE}')

def _ensure_task_group_unlocked(db, task: dict) -> None:
    template, _ = question_for(db, task['template_id'], task['question_id'])
    _ensure_group_unlocked(require(db, template['group_id'], 'groups'))

@router.get('/review-progress')
def progress(template_id:str,question_id:str,current=Depends(user)):
    from .allocation import read_progress
    from .progress_cache import SharedProgress
    shared = None
    def read(db, prepare):
        nonlocal shared
        template,question=question_for(db,template_id,question_id)
        group=require(db,template['group_id'],'groups')
        assignments=find(db,'assignments',template_id=template_id,question_id=question_id)
        if current['role'] not in ('admin','manager') and not any(current['id'] in participants(a) for a in assignments):raise HTTPException(403,'未分配此题')
        if shared is None:
            shared = SharedProgress(db, template_id, question_id)
        if assignments:
            prepare(db, template, question, assignments[-1])
        my_total=db.execute('SELECT COUNT(*) FROM review_allocations WHERE template_id=? AND question_id=? AND user_id=?',(template_id,question_id,current['id'])).fetchone()[0]
        count, finalized, all_final = shared.counts(db)
        mine=find(db,'tasks',user_id=current['id'],template_id=template_id,question_id=question_id)
        regrade_count=db.execute('SELECT COUNT(*) FROM regrade_queue WHERE user_id=? AND template_id=? AND question_id=?',(current['id'],template_id,question_id)).fetchone()[0]
        objective=sum(1 for q in template['questions'] if q['type']!='subjective' and q.get('answer'))
        personal=next(iter(allocation_progress(db,template_id,question_id,assignments[-1],user_id=current['id'])),{}) if assignments else {}
        return {**{'my_'+key:value for key,value in personal.items() if key!='user_id'},'can_arbitrate':bool(assignments and current['id'] in pools(assignments[-1])[1]),'my_regrade_pending':regrade_count,'my_total':my_total,'my_progress':round(100*sum(t['status']=='completed' for t in mine)/my_total,1) if my_total else 0,'total_submissions':count,'my_completed':sum(t['status']=='completed' for t in mine),'my_in_progress':sum(t['status']=='claimed' and t['expires_at']>time.time() for t in mine),'question_completed':finalized,'question_progress':round(100*finalized/count,1) if count else 0,'paper_progress':round(100*(all_final+objective*count)/(len(template['questions'])*count),1) if count and template['questions'] else 0,**_group_lock_dict(group)}
    result = read_progress(read)
    shared.publish()
    return result


@router.get('/review-allocation-progress')
def allocation_summary(template_id:str,current=Depends(admin)):
    from .allocation import read_progress
    def read(db, prepare):
        template=require(db,template_id,'templates')
        rows=[]
        for assignment in find(db,'assignments',template_id=template_id):
            question=next((q for q in template['questions'] if q['id']==assignment['question_id']),None)
            if not question:continue
            prepare(db,template,question,assignment)
            rows.append({'question_id':question['id'],'teachers':allocation_progress(db,template_id,question['id'],assignment)})
        return rows
    return read_progress(read)


_PERSONAL_PROJECT_ASSIGNMENTS = """
    FROM objects a
    JOIN objects t ON t.id=json_extract(a.body,'$.template_id') AND t.kind='templates' AND t.deleted=0
    JOIN objects g ON g.id=json_extract(t.body,'$.group_id') AND g.kind='groups' AND g.deleted=0
    JOIN objects s ON s.id=json_extract(g.body,'$.subject_id') AND s.kind='subjects' AND s.deleted=0
    JOIN objects p ON p.id=json_extract(s.body,'$.project_id') AND p.kind='projects' AND p.deleted=0
    WHERE a.kind='assignments' AND a.deleted=0
      AND (jsonb_exists(a.body::jsonb->'user_ids', ?) OR jsonb_exists(a.body::jsonb->'arbitrator_ids', ?))
"""


@router.get('/review-projects')
def review_projects(current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN')
        rows = db.execute("""
            SELECT p.id, json_extract(p.body,'$.name'), json_extract(p.body,'$.exam_status_mode'),
                   json_extract(s.body,'$.name'), t.id, count(*)
        """ + _PERSONAL_PROJECT_ASSIGNMENTS + ' GROUP BY p.id,p.body,s.id,s.body,t.id ORDER BY max(p.rowid) DESC,s.id,t.id',
            (current['id'], current['id']))
        projects = {}
        for project_id, name, mode, subject, template_id, count in rows:
            project = projects.setdefault(project_id, {
                'id': project_id, 'name': name, 'exam_status_mode': mode or 'auto',
                'subjects': [], 'template_ids': [], 'question_count': 0,
            })
            if subject not in project['subjects']:
                project['subjects'].append(subject)
            project['template_ids'].append(template_id)
            project['question_count'] += count
        if not projects:
            return []
        subjects = [dict(row) for row in db.execute("""
            SELECT id, json_extract(body,'$.project_id') AS project_id
            FROM objects WHERE kind='subjects' AND deleted=0 AND json_extract(body,'$.project_id')=ANY(?::text[])
        """, (list(projects),))]
        cards = [dict(row) for row in db.execute("""
            SELECT json_extract(body,'$.subject_id') AS subject_id, json_extract(body,'$.frozen') AS frozen
            FROM objects WHERE kind='groups' AND deleted=0 AND json_extract(body,'$.subject_id')=ANY(?::text[])
        """, ([s['id'] for s in subjects],))]
        return project_views(db, projects.values(), subjects, cards)


@router.get('/review-task-progress')
def task_summary(project_id: str | None = None, current=Depends(user)):
    from .allocation import read_progress
    def read(db, prepare):
        rows=[]
        if project_id is None:
            scoped = ((a, {}) for a in objects(db, 'assignments') if current['id'] in participants(a))
        else:
            matches = db.execute("""
                SELECT a.body, json_extract(s.body,'$.name'),
                       (SELECT json_extract(gr.body,'$.name') FROM objects gr
                        WHERE gr.id=json_extract(g.body,'$.grade_id') AND gr.kind='grades' AND gr.deleted=0),
                       json_extract(g.body,'$.name'), g.body
            """ + _PERSONAL_PROJECT_ASSIGNMENTS + ' AND p.id=? ORDER BY s.rowid,g.rowid,a.rowid',
                (current['id'], current['id'], project_id))
            scoped = ((json.loads(body), {'project_id': project_id, 'subject_name': subject, 'grade_name': grade,
                       'card_name': card, **_group_lock_dict(json.loads(group_body or '{}'))})
                      for body, subject, grade, card, group_body in matches)
        templates = {}
        for assignment, context in scoped:
            tid = assignment['template_id']
            if tid not in templates:
                templates[tid] = get(db, tid, 'templates')
            template = templates[tid]
            question=next((q for q in (template or {}).get('questions',[]) if q['id']==assignment['question_id']),None)
            if not question:continue
            prepare(db,template,question,assignment)
            personal=allocation_progress(db,template['id'],question['id'],assignment,user_id=current['id'])[0]
            if context:
                context.update(template_name=template.get('name') or context['card_name'] or '题卡', question_label=question_label(question),
                               points=question['points'], review_mode=question.get('review_mode', 'single'))
            rows.append({**context,**personal,'template_id':template['id'],'question_id':question['id'],'can_arbitrate':current['id'] in pools(assignment)[1]})
        return rows
    return read_progress(read)


@router.get('/tasks/{identifier}')
def details(identifier:str,current=Depends(user)):
    with connect() as db: return public_task(own_task(db,identifier,current),db)


@router.post('/tasks/claim')
async def claim(body: dict, request: Request):
    return JSONResponse(await submit_write(request, claim_in_transaction, body))


def claim_in_transaction(db, prepared, current, body):
    held=body.get('pending_task_ids',[])
    if not isinstance(held,list) or any(not isinstance(value,str) for value in held):
        raise HTTPException(422,'本地作答编号列表无效')
    held=set(held)
    tid, qid = body.get('template_id'), body.get('question_id')
    if not isinstance(tid, str) or not isinstance(qid, str):
        raise HTTPException(422, '需要有效的题卡与题目编号')
    key = ('claim', tid, qid)
    config = prepared.get(key)
    if config is None:
        template, question = question_for(db, tid, qid)
        if question['type'] != 'subjective':
            raise HTTPException(422, '客观题由系统给分')
        if require(db, template['group_id'], 'groups').get('frozen'):
            raise HTTPException(409, RESULTS_REVIEW_GUIDE)
        assignments = find(db, 'assignments', template_id=tid, question_id=qid)
        if not assignments:
            raise HTTPException(409, '请先配置阅卷教师')
        assignment = assignments[-1]
        config = template, question, assignment, participants(assignment)
    template, question, assignment, teachers = config
    if current['id'] not in teachers:
        raise HTTPException(403, '尚未分配该题')
    if key not in prepared:
        ensure(db, template, question, assignment)
        prepared[key] = config
    arbitration_pending = False
    if question.get('review_mode') == 'double':
        allocate_arbitration(db, template, question, assignment)
        arbitration_pending = db.execute("""SELECT 1 FROM review_allocations a JOIN objects s ON s.id=a.submission_id
            WHERE a.user_id=? AND a.question_id=? AND a.template_id=? AND a.round=3 AND s.deleted=0
            AND json_extract(s.body,'$.status')='ready' AND NOT EXISTS (
                SELECT 1 FROM objects t INDEXED BY object_task_answer WHERE t.kind='tasks' AND t.deleted=0
                AND json_extract(t.body,'$.submission_id')=+a.submission_id AND json_extract(t.body,'$.question_id')=a.question_id
                AND json_extract(t.body,'$.status')='completed' AND json_extract(t.body,'$.user_id')=a.user_id) LIMIT 1""",
            (current['id'], qid, tid)).fetchone() is not None
    queued=db.execute('SELECT task_id FROM regrade_queue WHERE user_id=? AND template_id=? AND question_id=? ORDER BY position,task_id',(current['id'],template['id'],question['id'])).fetchall()
    # Each pending ID still belongs to its teacher. Both regrades and ordinary
    # claims must pass over these papers until their local score arrives.
    for row in ([] if arbitration_pending else queued):
        if row[0] in held:continue
        task=require(db,row[0],'tasks')
        if task['status']=='completed':return public_task({**task,'regrading':True},db)
        db.execute('DELETE FROM regrade_queue WHERE task_id=?',(row[0],))
    existing=find(db,'tasks',user_id=current['id'],template_id=template['id'],question_id=question['id'],status='claimed')
    for task in existing:
        if task['user_id']==current['id'] and task['question_id']==question['id'] and task['status']=='claimed':
            if task['expires_at']>time.time():
                if task['id'] in held:continue
                allocated=db.execute('SELECT round FROM review_allocations WHERE submission_id=? AND question_id=? AND user_id=?',(task['submission_id'],question['id'],current['id'])).fetchone()
                if arbitration_pending and (not allocated or allocated['round']!=3):continue
                task['expires_at']=time.time()+900
                return public_task(put(db,'tasks',task,current['id']),db)
            task['status']='expired';put(db,'tasks',task,current['id'])
    # OFFSET 0 keeps the correlated lookup from flattening into a join scanning the
    # whole exam before PostgreSQL has statistics on newly assigned papers.
    rows=db.execute('''WITH assigned AS MATERIALIZED (
            SELECT submission_id, question_id, template_id, user_id, round
            FROM review_allocations WHERE user_id=? AND question_id=? AND template_id=?
        )
        SELECT s.body FROM assigned a
        CROSS JOIN LATERAL (
            SELECT body,kind,deleted FROM objects WHERE id=a.submission_id OFFSET 0
        ) s
        CROSS JOIN LATERAL (
            SELECT count(*) FILTER (WHERE t.body::jsonb #>> '{status}'='completed') AS completed,
                   bool_or(t.body::jsonb #>> '{user_id}'=a.user_id AND
                       (t.body::jsonb #>> '{status}'='completed' OR t.id=ANY(?::text[]))) AS held,
                   count(*) FILTER (WHERE t.body::jsonb #>> '{status}'='claimed'
                       AND (t.body::jsonb #>> '{expires_at}')::double precision>?) AS live,
                   max((t.body::jsonb #>> '{skipped_at}')::double precision) FILTER (
                       WHERE t.body::jsonb #>> '{user_id}'=a.user_id AND t.body::jsonb #>> '{status}'='skipped') AS skipped
            FROM (SELECT id,body,kind,deleted FROM objects
                  WHERE body::jsonb #>> '{submission_id}'=a.submission_id
                    AND body::jsonb #>> '{question_id}'=a.question_id OFFSET 0) t
            WHERE t.kind='tasks' AND t.deleted=0
        ) task_counts
        WHERE s.kind='submissions' AND s.deleted=0 AND s.body::jsonb #>> '{template_id}'=a.template_id
          AND s.body::jsonb #>> '{status}'='ready'
          AND (a.round<3 OR task_counts.completed=2) AND task_counts.held IS NOT TRUE
          AND task_counts.live+task_counts.completed <
              CASE WHEN ?='single' THEN 1 WHEN task_counts.completed<2 THEN 2 ELSE 3 END
          AND NOT EXISTS (SELECT 1 FROM review_results r WHERE r.submission_id=a.submission_id
              AND r.question_id=a.question_id AND r.final_cents IS NOT NULL)
        ORDER BY a.round DESC, COALESCE(task_counts.skipped,0)
        LIMIT 1''',(current['id'],qid,tid,list(held),time.time(),question.get('review_mode','single'))).fetchall()
    for row in rows:
        submission=json.loads(row['body'])
        relevant=tasks_for_answer(db,submission['id'],question['id'])
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
        task={'id':str(uuid4()),'template_id':template['id'],'question_id':question['id'],'submission_id':submission['id'],'student_id':submission['student_id'],'student_name':'匿名作答','user_id':current['id'],'status':'claimed','created_at':time.time(),'expires_at':time.time()+900,'score':None,'final_score':None,'regions':question['regions']}
        task['answer_slice_id']=submission.get('answer_slice_ids',{}).get(question['id'])
        task['image_url']=f"/api/v1/tasks/{task['id']}/image"
        return public_task(put(db,'tasks',task,current['id']),db,submission=submission)
    return None


@router.post('/tasks/{identifier}/score')
async def score(identifier: str, body: dict, request: Request):
    return JSONResponse(await submit_write(request, score_in_transaction, identifier, body))


def score_in_transaction(db, prepared, current, identifier, body):
    try:
        amount=cents(body['score'])
        if Decimal(str(body['score']))!=Decimal(amount)/100:raise ValueError
    except (KeyError,ValueError,ArithmeticError): raise HTTPException(422,'分值无效')
    key=str(body.get('idempotency_key',''))
    if not 1<=len(key)<=200: raise HTTPException(422,'需要提交幂等编号')
    row=db.execute("""
        SELECT t.body, s.body AS submission, k.task_id AS prior_task, k.score AS prior_score,
               (SELECT round FROM review_allocations a
                WHERE a.submission_id=t.body::jsonb #>> '{submission_id}' AND a.question_id=t.body::jsonb #>> '{question_id}'
                  AND a.user_id=t.body::jsonb #>> '{user_id}' LIMIT 1) AS review_round
        FROM objects t LEFT JOIN objects s ON s.id=t.body::jsonb #>> '{submission_id}'
            AND s.kind='submissions' AND s.deleted=0
        LEFT JOIN scores k ON k.user_id=? AND k.idempotency_key=?
        WHERE t.id=? AND t.kind='tasks' AND t.deleted=0
        """,(current['id'],key,identifier)).fetchone()
    if row is None:raise HTTPException(404,'记录不存在')
    task=json.loads(row['body'])
    authorize_task(db,task,current)
    submission=json.loads(row['submission']) if row['submission'] is not None else None
    review_role='arbitration' if row['review_round']==3 else 'ordinary'
    if task['status']=='invalidated': raise HTTPException(409,'作答已更正，需要重新评阅')
    if row['prior_task'] is not None:
        if row['prior_task']!=identifier or row['prior_score']!=amount: raise HTTPException(409,'提交编号已用于其他评分')
        return {**public_task(task,db,submission=submission,review_role=review_role),'accepted_operation':{'id':key,'score':amount/100}}
    config_key = ('score', task['template_id'], task['question_id'])
    config = prepared.get(config_key)
    if config is None:
        template, question = question_for(db, task['template_id'], task['question_id'])
        group = require(db, template['group_id'], 'groups')
        config = prepared[config_key] = question, group
    question, group = config
    _ensure_group_unlocked(group)
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
    if submission is None:raise HTTPException(404,'记录不存在')
    final=result_for(db,submission,question,scored_task=task)
    db.execute('INSERT INTO review_results VALUES(?,?,?) ON CONFLICT(submission_id,question_id) DO UPDATE SET final_cents=excluded.final_cents',(submission['id'],question['id'],final))
    task['final_score']=final/100 if final is not None else None
    put(db,'tasks',task,current['id'])
    db.execute('INSERT INTO scores VALUES(?,?,?,?,?)',(str(uuid4()),identifier,current['id'],amount,key))
    db.execute('DELETE FROM regrade_queue WHERE task_id=?',(identifier,))
    return {**public_task(task,db,submission=submission,group=group,review_role=review_role),'accepted_operation':{'id':key,'score':amount/100}}


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
        _ensure_group_unlocked(require(db,template['group_id'],'groups'))
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
        _ensure_task_group_unlocked(db,task)
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
        _ensure_task_group_unlocked(db,task)
        return put(db,'exceptions',{'task_id':identifier,'submission_id':task['submission_id'],'kind':body['kind'],'reason':str(body.get('reason','')),'status':'open'},current['id'])


@router.get('/tasks/{identifier}/image')
def image(identifier:str,current=Depends(user)):
    with connect() as db:
        task=own_task(db,identifier,current)
        submission=require(db,task['submission_id'],'submissions')
        template,question=question_for(db,task['template_id'],task['question_id'])
        answer=get(db,task.get('answer_slice_id'),'answer-slices')
    return render_answer_image(submission,template,question,answer)


def render_answer_image(submission,template,question,answer):
    from .review_layout import display_sources,pixel_box
    override=submission.get('region_overrides',{}).get(question['id'],{})
    if answer:override={'asset_id':answer.get('asset_id')}
    if override.get('asset_id'):
        from fastapi.responses import FileResponse
        from .storage import materialize
        return FileResponse(materialize('assets/'+override['asset_id']+'.png'),headers={'Cache-Control':'private, no-store'})
    pieces=[]
    sources=display_sources(submission,template,question,answer)
    for source in sources:
        region=source['region']
        page=int(region['page'])-1
        if page>=len(submission['pages']): raise HTTPException(409,'答卷缺页')
        with connect() as db:
            if (get(db,source.get('page_id',submission['pages'][page]),'pages') or {}).get('upload_format')=='jpeg-sheet-1':
                raise HTTPException(409,'请通过整页图片清单加载答卷，在浏览器中显示作答区域')
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
    for piece,source in zip(pieces,sources):
        if source.get('masks'):
            left,upper,right,bottom=pixel_box(source['region'])
            sx,sy=piece.width/(right-left),piece.height/(bottom-upper)
            for x,y,w,h in source['masks']:
                piece.paste('white',(int((x-left)*sx),int((y-upper)*sy),
                                     ceil((x+w-left)*sx),ceil((y+h-upper)*sy)))
        merged.paste(piece,(0,top))
        top+=piece.height+12
    buffer=io.BytesIO(); merged.save(buffer,format='JPEG',quality=90)
    return Response(buffer.getvalue(),media_type='image/jpeg',headers={'Cache-Control':'private, no-store'})


@router.get('/exceptions')
def exceptions(group_id:str|None=None,status:str|None=None,room_tag_id:str|None=None,current=Depends(admin)):
    with connect() as db:
        from .room_tags import exception_source,includes,view as room_view
        output=[]
        for item in objects(db,'exceptions'):
            source=exception_source(db,item)
            item={**item,'room_tags':room_view(db,source.get('room_tags',[]))}
            if not includes(item,room_tag_id):continue
            if not item.get('group_id'):
                item['group_id']=source.get('group_id')
            if not item.get('candidate_number'):
                page=get(db,item.get('page_id'),'pages') or {}
                item['candidate_number']=source.get('candidate_number') or page.get('candidate_number')
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
        return {'exception':item,'context':{'project_id':(project or {}).get('id'),'subject_id':(subject or {}).get('id'),'group_id':(group or {}).get('id'),'grade_id':(group or {}).get('grade_id'),'batch_id':(batch or {}).get('id'),'submission_id':(submission or {}).get('id'),'page_id':(page or {}).get('id'),'project':(project or {}).get('name'),'subject':(subject or {}).get('name'),'group':(group or {}).get('name'),'room':(batch or {}).get('room'),'room_tags':room_view(db,(submission or batch or {}).get('room_tags',[])), 'grade':(get(db,(group or {}).get('grade_id'),'grades') or {}).get('name'),'candidate_number':(submission or page or {}).get('candidate_number'),'student_name':(student or {}).get('name')},'pages':[{'id':p['id'],'side':p['side'],'sequence':p['sequence'],'status':p['status'],'image_url':f"/api/v1/pages/{p['id']}/image",'selections':{str(q['number']):p.get('selections',{}).get(q['id'],[]) for q in (template or {}).get('questions',[]) if q['type']!='subjective' and q['id'] in p.get('selections',{})}} for p in pages if p],'answer_image_url':f"/api/v1/tasks/{task['id']}/image" if task else None}


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
    allowed_classes=result_class_scope(db,group,current)
    rows=card_result_rows(db,group,convert_scores)
    return [r for r in rows if allowed_classes is None or r['class_id'] in allowed_classes]


def result_class_scope(db,group,current):
    group_id=group['id']
    allowed_classes=None
    if current['role'] not in ('admin','manager'):
        from .visibility import class_scope,groups_for_classes
        allowed_classes=class_scope(db,current['id'],group.get('subject_id'))
        if group_id not in groups_for_classes(db,allowed_classes): raise HTTPException(403,'成绩尚未发布或不属于任教班级')
    return allowed_classes


def card_result_rows(db,group,convert_scores=True):
    """Internal scoring rows before applying a caller-authorized view."""
    from .conversion_bindings import resolve
    group=resolve(db,group)
    group_id=group['id']
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
    output=[]
    versions={}
    for submission in find(db,'submissions',group_id=group_id):
        student=submission.get('student_snapshot') or require(db,submission['student_id'],'students')
        tid=submission['template_id']
        if tid not in versions:versions[tid]=require(db,tid,'templates')
        questions=versions[tid]['questions']
        read_options=submission['status']!='absent' and any(q['type']!='subjective' and q.get('answer') and q['id'] not in submission.get('objective_overrides',{}) for q in questions)
        selections=objective_selections(db,submission) if read_options else None
        scores={question_label(q):result_for(db,submission,q,selections=selections) for q in questions}
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
    return output


@router.post('/results/publish')
def publish_results(body:dict,current=Depends(admin)):
    group_id=body.get('group_id')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        rows=results_for(db,group_id,current)
        unscanned=[r['student_id'] for r in rows if r['status']=='unscanned']
        group=require(db,group_id,'groups')
        from .workflow import overview,publication_blockers
        blockers=publication_blockers(overview(db,group,current))
        if blockers:raise HTTPException(409,'；'.join(blockers))
        submissions={s['id'] for s in objects(db,'submissions') if s['group_id']==group_id}
        batches={b['id'] for b in objects(db,'scan-batches') if b['group_id']==group_id}
        if db.execute("SELECT 1 FROM regrade_queue r JOIN objects t ON t.id=r.task_id JOIN objects s ON s.id=json_extract(t.body,'$.submission_id') WHERE s.deleted=0 AND json_extract(s.body,'$.group_id')=? LIMIT 1",(group_id,)).fetchone():raise HTTPException(409,'存在尚未完成的重阅任务')
        if any(e['status']=='open' and e['kind']!='excellent' and (e.get('submission_id') in submissions or e.get('batch_id') in batches) for e in objects(db,'exceptions')): raise HTTPException(409,'存在未处理异常')
        put(db,'publication-events',{'group_id':group_id,'forced_unscanned':bool(unscanned),'unscanned_student_ids':unscanned,'reason':str(body.get('reason',''))},current['id'])
        from .conversion_bindings import resolve
        group=resolve(db,group)
        if group.get('conversion_id') and not group.get('frozen'):
            from copy import deepcopy
            group['conversion_snapshot']=deepcopy(require(db,group['conversion_id'],'score-conversions'))
            group['conversion_revision']=group['conversion_snapshot'].get('revision',1)
        snapshot=put(db,'result-snapshots',{'group_id':group_id,'rows':rows},current['id'])
        group.update(frozen=True,published_at=time.time(),published_unscanned_count=len(unscanned),result_snapshot_id=snapshot['id'])
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
