"""Global school identities and current grade-based examination membership."""
from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, get, objects, put
from .dependencies import admin, require

router=APIRouter(prefix='/api/v1')


def grade_by_name(db,name,actor=None):
    name=str(name).strip()
    if not 1<=len(name)<=60:raise HTTPException(422,'年级名称需1至60字')
    existing=next((g for g in objects(db,'grades') if g['name']==name),None)
    return existing or put(db,'grades',{'name':name,'archived':False},actor)


def assign_class(db,value,body,actor=None):
    if 'grade_id' in body:
        grade=require(db,body['grade_id'],'grades')
        if grade.get('archived') and value.get('grade_id')!=grade['id']:raise HTTPException(422,'年级已停用')
        value.update(grade_id=grade['id'],grade=grade['name'])
    elif 'grade' in body and str(body['grade']).strip():
        grade=grade_by_name(db,body['grade'],actor)
        value.update(grade_id=grade['id'],grade=body['grade'])
    return value


def migrate():
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        from .electives import subject_tag
        existing={tag['name'] for tag in objects(db,'subject-tags')}
        names={s['subject'].strip() for s in objects(db,'electives')} | {s['name'].strip() for s in objects(db,'subjects')}
        for name in sorted(names-existing):
            if name: subject_tag(db,name)
        for cls in objects(db,'classes'):
            if not cls.get('grade_id') and str(cls.get('grade','')).strip():
                assign_class(db,cls,{'grade':cls['grade']});put(db,'classes',cls)


def student_view(db,student):
    student=get(db,student['id'],'students') or student
    cls=get(db,student.get('class_id'),'classes') or {}
    grade=get(db,cls.get('grade_id'),'grades') or {}
    return {**student,'class_name':cls.get('name',student.get('class_name','')),
            'grade_id':grade.get('id'),'grade':grade.get('name',cls.get('grade',student.get('grade')))}


def group_students(db,group):
    if group.get('roster_mode')=='selected':
        roster=get(db,group.get('roster_id'),'rosters') or {}
        students={s['id']:s for s in objects(db,'students')}
        return [student_view(db,students[sid]) for sid in roster.get('student_ids',[]) if sid in students]
    if group.get('grade_id'):
        classes={c['id'] for c in objects(db,'classes') if c.get('grade_id')==group['grade_id']}
        return [student_view(db,s) for s in objects(db,'students') if s.get('class_id') in classes]
    roster=get(db,group.get('roster_id'),'rosters')
    return roster.get('students',[]) if roster else None


@router.post('/subjects/{identifier}/grades')
def add_subject_grade(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        subject=require(db,identifier,'subjects');grade=require(db,body.get('grade_id'),'grades')
        if grade.get('archived'):raise HTTPException(422,'年级已停用')
        subject['grade_ids']=list(dict.fromkeys([*subject.get('grade_ids',[]),grade['id']]))
        return put(db,'subjects',subject,current['id'])


@router.delete('/subjects/{identifier}/grades/{grade_id}')
def remove_subject_grade(identifier:str,grade_id:str,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        subject=require(db,identifier,'subjects');require(db,grade_id,'grades')
        if find(db,'groups',subject_id=identifier,grade_id=grade_id):
            raise HTTPException(409,'该年级下仍有题卡，请先调整题卡年级或删除题卡')
        subject['grade_ids']=[value for value in subject.get('grade_ids',[]) if value!=grade_id]
        return put(db,'subjects',subject,current['id'])


def bind_group(db,group,grade_id,actor):
    grade=require(db,grade_id,'grades')
    if grade.get('archived') and group.get('grade_id')!=grade_id:raise HTTPException(422,'年级已停用')
    if group.get('grade_id') and group['grade_id']!=grade_id and any(find(db,kind,group_id=group['id']) for kind in ('room-tags','scan-batches','submissions')):
        raise HTTPException(409,'本组已有考场或扫描记录，请新建题卡组使用其他年级')
    group['grade_id']=grade_id
    return put(db,'groups',group,actor)


@router.get('/grades')
def grades(current=Depends(admin)):
    with connect() as db:return objects(db,'grades')


@router.post('/grades')
def create_grade(body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        name=str(body.get('name','')).strip()
        if any(g['name']==name for g in objects(db,'grades')):raise HTTPException(409,'已有同名年级')
        return grade_by_name(db,name,current['id'])


@router.put('/grades/{identifier}')
def edit_grade(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');value=require(db,identifier,'grades')
        name=str(body.get('name',value['name'])).strip();archived=body.get('archived',value.get('archived',False))
        if not 1<=len(name)<=60 or type(archived) is not bool:raise HTTPException(422,'年级名称或状态无效')
        if any(g['id']!=identifier and g['name']==name for g in objects(db,'grades')):raise HTTPException(409,'已有同名年级')
        value.update(name=name,archived=archived);put(db,'grades',value,current['id'])
        # Keep the legacy display field consistent for older consumers.
        for cls in find(db,'classes',grade_id=identifier):cls['grade']=name;put(db,'classes',cls,current['id'])
        return value


@router.put('/groups/{identifier}/grade')
def group_grade(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核')
        return bind_group(db,group,body.get('grade_id'),current['id'])
