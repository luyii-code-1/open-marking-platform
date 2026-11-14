from fastapi import APIRouter, Depends, File, UploadFile, HTTPException
from typing import Literal
from pydantic import BaseModel
from .db import connect, objects, find, put, get
from .dependencies import admin, require
from .roster_import import read_rows, match_rows

router=APIRouter(prefix='/api/v1')


class Selection(BaseModel):
    grade_id: str
    subject: str
    student_ids: list[str]
    kind: Literal["required","elective"]="elective"


@router.get('/electives')
def list_electives(current=Depends(admin)):
    with connect() as db:
        return objects(db,'electives')


@router.post('/electives/match')
def match(grade_id:str,file:UploadFile=File(),current=Depends(admin)):
    data=file.file.read(8*1024*1024+1)
    if len(data)>8*1024*1024: raise HTTPException(413,'文件超过8 MB')
    with connect() as db:
        require(db,grade_id,'grades')
        report=match_rows(db,{'grade_id':grade_id},read_rows(data,file.filename))
        issues=report['errors']+report['warnings']
        if issues: raise HTTPException(422,'；'.join(f"第{r['row']}行：{r['reason']}" for r in issues[:10]))
        return [s['id'] for s in report['students']]


def members(db, grade, ids):
    classes={c['id'] for c in objects(db,'classes') if c.get('grade_id')==grade}
    return [s for s in objects(db,'students') if s['id'] in ids and s['class_id'] in classes]


@router.put('/electives')
def store(body:Selection,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        require(db,body.grade_id,'grades')
        subject=body.subject.strip()
        if not subject: raise HTTPException(422,'请填写科目')
        subject_tag(db,subject,current['id'])
        ids=set(body.student_ids)
        if len(members(db,body.grade_id,ids))!=len(ids): raise HTTPException(422,'请选择该年级的学生')
        old=find(db,'electives',grade_id=body.grade_id,subject=subject)
        item=old[0] if old else {'grade_id':body.grade_id,'subject':subject}
        return put(db,'electives',{**item,'kind_of_subject':body.kind,'student_ids':sorted(ids) if body.kind=='elective' else []},current['id'])


@router.post('/groups/{identifier}/roster/elective')
def use_elective(identifier:str,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结')
        entry=card_catalog(db,group)
        if not entry or entry.get('kind_of_subject','elective')!='elective':raise HTTPException(422,'该科目没有选科名单')
        from .db import get
        old=get(db,group.get('roster_id'),'rosters') or {}
        supplemental=set(old.get('supplemental_ids',[])) if old.get('source')=='elective' else set()
        students=members(db,group['grade_id'],set(entry['student_ids'])|supplemental)
        return save_members(db,group,students,'elective',supplemental,current['id'])


def card_catalog(db,group):
    subject=require(db,group['subject_id'],'subjects')
    linked=subject.get('catalog_by_grade',{}).get(group.get('grade_id'))
    if linked:return require(db,linked,'electives')
    tag=get(db,subject.get('subject_tag_id'),'subject-tags') or subject
    matches=find(db,'electives',grade_id=group.get('grade_id'),subject=tag['name'].strip())
    return matches[0] if matches else None


def save_members(db,group,students,source,supplemental,actor):
    ids=[s['id'] for s in students]
    roster={'group_id':group['id'],'source':source,'class_ids':[],'students':students,'student_ids':ids,'supplemental_ids':sorted(set(ids)&supplemental)}
    if group.get('roster_id'):roster['id']=group['roster_id']
    saved=put(db,'rosters',roster,actor)
    put(db,'groups',{**group,'roster_mode':'selected','roster_id':saved['id'],'expected_students':len(ids)},actor)
    return {'count':len(ids)}


@router.post('/groups/{identifier}/roster/add-students')
def supplement(identifier:str,body:dict,current=Depends(admin)):
    from .school import group_students
    from .db import get
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结')
        ids=body.get('student_ids')
        if not group.get('grade_id') or not isinstance(ids,list) or not ids or any(not isinstance(i,str) for i in ids):raise HTTPException(422,'请选择同年级学生')
        added=members(db,group['grade_id'],set(ids))
        if len(added)!=len(set(ids)):raise HTTPException(422,'请选择同年级学生')
        old=get(db,group.get('roster_id'),'rosters') or {}
        students={s['id']:s for s in group_students(db,group) or []}
        extra=set(old.get('supplemental_ids',[]))|(set(ids)-students.keys())
        students.update({s['id']:s for s in added})
        return save_members(db,group,list(students.values()),old.get('source','manual'),extra,current['id'])


class SubjectTag(BaseModel):
    name: str


def subject_tag(db, name, actor=None):
    name = name.strip()
    if not name:
        raise HTTPException(422, '请填写科目名称')
    existing = find(db, 'subject-tags', name=name)
    return existing[0] if existing else put(db, 'subject-tags', {'name': name}, actor)


@router.get('/subject-tags')
def list_tags(current=Depends(admin)):
    with connect() as db:
        return sorted(objects(db, 'subject-tags'), key=lambda tag: tag['name'])


@router.post('/subject-tags')
def add_tag(body: SubjectTag, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        return subject_tag(db, body.name, current['id'])


def create_exam_subjects(db, project, ids, actor):
    if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
        raise HTTPException(422, '科目选择无效')
    seen = set()
    for identifier in ids:
        tag = get(db, identifier, 'subject-tags')
        if not tag:
            legacy = require(db, identifier, 'electives')
            tag = subject_tag(db, legacy['subject'], actor)
        if tag['id'] not in seen:
            put(db, 'subjects', {'project_id': project['id'], 'name': tag['name'],
                'subject_tag_id': tag['id'], 'group_mode': 'custom'}, actor)
            seen.add(tag['id'])


@router.post('/subject-tags/import')
def import_tags(file:UploadFile=File(),current=Depends(admin)):
    from .roster_import import table_rows
    data=file.file.read(8*1024*1024+1)
    if len(data)>8*1024*1024: raise HTTPException(413,'文件超过8 MB')
    rows=table_rows(data,file.filename)
    if len(rows)<2 or rows[0][1].count('科目')!=1:
        raise HTTPException(422,'表格需要“科目”列和至少一行科目名称')
    column=rows[0][1].index('科目')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        existing={tag['name'] for tag in objects(db,'subject-tags')}
        created=0
        for number,row in rows[1:]:
            if column>=len(row) or not row[column]:
                raise HTTPException(422,f'第{number}行缺少科目名称')
            if row[column] not in existing:
                subject_tag(db,row[column],current['id'])
                existing.add(row[column])
                created+=1
        return {'created':created}
