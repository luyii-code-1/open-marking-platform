"""Project-scoped conversion inheritance with publication locking."""
from fastapi import APIRouter, Depends, HTTPException
from .db import connect, get, objects, put
from .dependencies import system_admin, require

router = APIRouter(prefix='/api/v1')


def resolve(db, group):
    if group.get('frozen'):return group
    subject = get(db,group.get('subject_id'),'subjects') or {}
    project = get(db,subject.get('project_id'),'projects') or {}
    mode = group.get('conversion_mode')
    if mode == 'none':identifier,source = None,'题卡'
    elif mode == 'override' or mode is None and group.get('conversion_id'):identifier,source = group.get('conversion_id'),'题卡'
    elif group.get('grade_id') in subject.get('grade_conversions',{}):identifier,source = subject['grade_conversions'][group['grade_id']],'年级'
    elif subject.get('conversion_mode') == 'none':identifier,source = None,'科目'
    elif subject.get('conversion_id'):identifier,source = subject['conversion_id'],'科目'
    else:identifier,source = project.get('conversion_id'),'考试项目'
    return {**group,'conversion_id':identifier,'conversion_source':source}


@router.get('/conversion-bindings')
def bindings(project_id:str, current=Depends(system_admin)):
    with connect() as db:
        project = require(db,project_id,'projects')
        subjects = [s for s in objects(db,'subjects') if s.get('project_id')==project_id]
        groups = [resolve(db,g) for g in objects(db,'groups') if g.get('subject_id') in {s['id'] for s in subjects}]
        return {'project':project,'subjects':subjects,'groups':groups}


@router.put('/conversion-bindings')
def bind(body:dict, current=Depends(system_admin)):
    kind = body.get('kind'); identifier = body.get('id'); mode = body.get('mode','inherit'); cid = body.get('conversion_id')
    if kind not in ('projects','subjects','groups') or mode not in ('inherit','override','none'):raise HTTPException(422,'赋分作用域无效')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        target = require(db,identifier,kind)
        if mode=='override':
            from copy import deepcopy
            config=require(db,cid,'score-conversions')
            subject=target if kind=='subjects' else get(db,target.get('subject_id'),'subjects') if kind=='groups' else None
            project_id=target['id'] if kind=='projects' else (subject or {}).get('project_id')
            if config.get('project_id')!=project_id:
                copied={k:deepcopy(v) for k,v in config.items() if k not in ('id','revision','change_reason')}
                copied.update(project_id=project_id,source_template_id=cid,revision=1)
                cid=put(db,'score-conversions',copied,current['id'])['id']
        if kind=='groups' and target.get('frozen'):raise HTTPException(409,'成绩已发布，请先发起成绩复核')
        grade_id = body.get('grade_id')
        if grade_id:
            if kind!='subjects':raise HTTPException(422,'年级规则需指定科目')
            require(db,grade_id,'grades')
            mapping = dict(target.get('grade_conversions',{}))
            if mode=='inherit':mapping.pop(grade_id,None)
            else:mapping[grade_id] = cid if mode=='override' else None
            target['grade_conversions'] = mapping
        else:
            target.update(conversion_mode=mode,conversion_id=cid if mode=='override' else None)
        put(db,kind,target,current['id'])
        # Validate every affected draft before committing the inheritance change.
        from .conversion_routes import validate_existing
        for group in objects(db,'groups'):
            subject = get(db,group.get('subject_id'),'subjects') or {}
            relevant = group['id']==identifier if kind=='groups' else group.get('subject_id')==identifier if kind=='subjects' else subject.get('project_id')==identifier
            if relevant and not group.get('frozen') and group.get('template_id'):
                effective = resolve(db,group)
                if effective.get('conversion_id'):
                    validate_existing(db,effective,require(db,effective['conversion_id'],'score-conversions'),current)
        return target
