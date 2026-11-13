"""Preview and audit corrections to the official card's objective scoring."""
from copy import deepcopy
import hashlib
import json
import time
from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, put
from .dependencies import admin, require
from .review import result_for
from .template_checks import issues

router=APIRouter(prefix='/api/v1')


def preview(db,identifier,body):
    template=require(db,identifier,'templates');group=require(db,template['group_id'],'groups')
    if template.get('status')!='published' or group.get('template_id')!=identifier:raise HTTPException(409,'请选择该题卡的正式版式')
    changes=body.get('questions')
    if not isinstance(changes,list) or not changes:raise HTTPException(422,'请选择需要调整的客观题')
    updated=deepcopy(template);by_id={q['id']:q for q in updated['questions']};seen=set()
    for change in changes:
        if not isinstance(change,dict) or set(change)-{'id','answer','rule'}:raise HTTPException(422,'仅可修改客观题答案和评分规则')
        q=by_id.get(change.get('id'))
        if not q or q['type']=='subjective' or q['id'] in seen:raise HTTPException(422,'题目无效或重复')
        seen.add(q['id']);q.update(change)
    errors=issues(updated,complete=True)
    if errors:raise HTTPException(422,'；'.join(errors))
    changed=[q['id'] for q,old in zip(updated['questions'],template['questions']) if q!=old]
    if not changed:raise HTTPException(422,'答案和评分规则没有变化')
    rows=[]
    for submission in find(db,'submissions',group_id=group['id']):
        if submission['template_id']!=identifier:continue
        before=sum(result_for(db,submission,q) for q in template['questions'] if q['id'] in changed)
        after=sum(result_for(db,submission,q) for q in updated['questions'] if q['id'] in changed)
        rows.append({'id':submission['id'],'candidate_number':submission['candidate_number'],'before':before/100,'after':after/100})
    digest=hashlib.sha256(json.dumps({'template':template,'changes':changes,'rows':rows,'frozen':group.get('frozen',False)},sort_keys=True).encode()).hexdigest()
    return template,updated,group,{'preview_sha':digest,'questions':changed,'affected_submissions':len(rows),'changed_scores':sum(r['before']!=r['after'] for r in rows),'rows':rows,'published':bool(group.get('frozen'))}


@router.post('/templates/{identifier}/scoring-preview')
def scoring_preview(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN')
        return preview(db,identifier,body)[3]


@router.put('/templates/{identifier}/scoring')
def apply_scoring(identifier:str,body:dict,current=Depends(admin)):
    if body.get('confirm') is not True or not isinstance(body.get('reason'),str) or not body['reason'].strip():raise HTTPException(422,'请确认影响范围并填写调整原因')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        original,updated,group,report=preview(db,identifier,body)
        if body.get('preview_sha')!=report['preview_sha']:raise HTTPException(409,'题卡或答卷已变化，请重新预览')
        group.update(frozen=False,reopen_reason=body['reason'].strip(),reopened_at=time.time())
        group.pop('scan_close',None)
        put(db,'groups',group,current['id'])
        updated['scoring_revision']=original.get('scoring_revision',1)+1
        put(db,'templates',updated,current['id'])
        put(db,'regrade-events',{'template_id':identifier,'reason':body['reason'].strip(),'before':original['questions'],'after':updated['questions'],'impact':report,'at':time.time()},current['id'])
        from .anomalies import check_submission
        for submission in find(db,'submissions',group_id=group['id']):check_submission(db,submission,current['id'])
        return {'changed_scores':report['changed_scores'],'scoring_revision':updated['scoring_revision'],'requires_publication':True}
