from fastapi import APIRouter, Depends, File, UploadFile, HTTPException
from pydantic import BaseModel
from .db import connect, objects, find, put
from .dependencies import admin, require
from .roster_import import read_rows, match_rows

router=APIRouter(prefix='/api/v1')


class Selection(BaseModel):
    grade_id: str
    subject: str
    student_ids: list[str]


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
        ids=set(body.student_ids)
        if len(members(db,body.grade_id,ids))!=len(ids): raise HTTPException(422,'请选择该年级的学生')
        old=find(db,'electives',grade_id=body.grade_id,subject=subject)
        item=old[0] if old else {'grade_id':body.grade_id,'subject':subject}
        return put(db,'electives',{**item,'student_ids':sorted(ids)},current['id'])


@router.post('/groups/{identifier}/roster/elective')
def use_elective(identifier:str,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结')
        subject=require(db,group['subject_id'],'subjects')['name'].strip()
        lists=find(db,'electives',grade_id=group.get('grade_id'),subject=subject)
        if not lists:raise HTTPException(422,'请先维护该年级和科目的选科名单')
        students=members(db,group['grade_id'],set(lists[0]['student_ids']))
        if not students:raise HTTPException(422,'当前选科名单为空')
        roster={'group_id':identifier,'source':'elective','class_ids':[],'students':students,'student_ids':[s['id'] for s in students]}
        if group.get('roster_id'):roster['id']=group['roster_id']
        saved=put(db,'rosters',roster,current['id'])
        put(db,'groups',{**group,'roster_mode':'selected','roster_id':saved['id'],'expected_students':len(students)},current['id'])
        return {'count':len(students)}
