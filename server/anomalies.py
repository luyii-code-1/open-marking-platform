"""Configurable review flags. Flags request a human check; they never alter marks."""
import hashlib
import json
import time

from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, get, put
from .dependencies import admin, require

router=APIRouter(prefix='/api/v1')
DEFAULTS={
    'blank_answers':{'enabled':False,'min_count':5},
    'same_answer_run':{'enabled':False,'min_run':5},
    'invalid_single':{'enabled':False},
}


def validate_rules(value):
    if not isinstance(value,dict) or set(value)-set(DEFAULTS):raise HTTPException(422,'异常规则名称无效')
    output={}
    for name,default in DEFAULTS.items():
        if not isinstance(value.get(name,{}),dict):raise HTTPException(422,'异常规则参数无效')
        item={**default,**value.get(name,{})}
        if set(item)-set(default) or not isinstance(item['enabled'],bool):raise HTTPException(422,'异常规则参数无效')
        parameter='min_count' if name=='blank_answers' else 'min_run' if name=='same_answer_run' else None
        if parameter and (type(item[parameter]) is not int or not (1 if parameter=='min_count' else 2)<=item[parameter]<=10000):raise HTTPException(422,'异常数量阈值无效')
        output[name]=item
    return output


def sync(db,scope,issues,actor=None):
    """An unchanged acknowledged finding stays acknowledged on repeated checks."""
    field,identifier=scope
    existing={e['rule']:e for e in find(db,'exceptions',**{field:identifier}) if e.get('source')=='automatic'}
    for rule,issue in issues.items():
        fingerprint=hashlib.sha256(json.dumps(issue,sort_keys=True).encode()).hexdigest()
        old=existing.get(rule)
        if old and old.get('fingerprint')==fingerprint:continue
        value={**(old or {}),field:identifier,**issue,'rule':rule,'source':'automatic','kind':'automatic','status':'open','fingerprint':fingerprint,'detected_at':time.time()}
        value.pop('resolution',None);value.pop('resolved_at',None)
        put(db,'exceptions',value,actor)
    for rule,old in existing.items():
        if rule not in issues and old['status']=='open':
            old.update(status='resolved',resolution='重新检查后该条件已消失或规则已关闭',resolved_at=time.time())
            put(db,'exceptions',old,actor)


def check_candidate(db,page,actor=None):
    issues={}
    if not page.get('excluded') and page['side']=='front' and (not page.get('candidate_number') or '?' in page['candidate_number']):
        batch=get(db,page['batch_id'],'scan-batches')
        issues['candidate_number']={'group_id':batch['group_id'],'batch_id':page['batch_id'],'reason':'准考证号缺填、多填或无法可靠识读','evidence':{'candidate_number':page.get('candidate_number')}}
    sync(db,('page_id',page['id']),issues,actor)


def check_submission(db,submission,actor=None):
    group=get(db,submission['group_id'],'groups')
    template=get(db,submission['template_id'],'templates')
    rules=validate_rules(group.get('anomaly_rules',{}))
    questions=[q for q in template['questions'] if q['type']!='subjective']
    selected={q['id']:set() for q in questions}
    for pid in submission['pages']:
        page=get(db,pid,'pages')
        for qid,answers in page.get('selections',{}).items():
            if qid in selected:selected[qid].update(answers)
    for qid,answers in submission.get('objective_overrides',{}).items():
        if qid in selected:selected[qid]=set(answers)
    issues={}
    context={'group_id':group['id'],'template_id':template['id']}
    if submission['status']!='absent':
        blanks=[q['number'] for q in questions if not selected[q['id']]]
        if rules['blank_answers']['enabled'] and len(blanks)>=rules['blank_answers']['min_count']:
            issues['blank_answers']={**context,'reason':f'客观题留空{len(blanks)}题，达到检查阈值','evidence':{'question_numbers':blanks,'threshold':rules['blank_answers']['min_count']}}
        invalid=[q['number'] for q in questions if q['type']=='single' and len(selected[q['id']])>1]
        if rules['invalid_single']['enabled'] and invalid:
            issues['invalid_single']={**context,'reason':'单选题出现多选填涂','evidence':{'question_numbers':invalid}}
        runs=[];run=[];previous=None
        for q in questions:
            answers=selected[q['id']]
            answer=next(iter(answers)) if q['type']=='single' and len(answers)==1 else None
            if not answer or answer!=previous:
                if len(run)>=rules['same_answer_run']['min_run']:runs.append({'answer':previous,'question_numbers':run})
                run=[]
            if answer:run.append(q['number'])
            previous=answer
        if len(run)>=rules['same_answer_run']['min_run']:runs.append({'answer':previous,'question_numbers':run})
        if rules['same_answer_run']['enabled'] and runs:
            issues['same_answer_run']={**context,'reason':'连续相同选项达到检查阈值','evidence':{'runs':runs,'threshold':rules['same_answer_run']['min_run']}}
    sync(db,('submission_id',submission['id']),issues,actor)


@router.get('/groups/{identifier}/anomaly-rules')
def rules(identifier:str,current=Depends(admin)):
    with connect() as db:return validate_rules(require(db,identifier,'groups').get('anomaly_rules',{}))


@router.put('/groups/{identifier}/anomaly-rules')
def set_rules(identifier:str,body:dict,current=Depends(admin)):
    value=validate_rules(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核')
        group['anomaly_rules']=value;put(db,'groups',group,current['id'])
        submissions=find(db,'submissions',group_id=identifier)
        for submission in submissions:check_submission(db,submission,current['id'])
        return {'rules':value,'checked_submissions':len(submissions)}
