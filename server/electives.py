from fastapi import APIRouter, Depends, File, UploadFile, HTTPException
from typing import Literal
from pydantic import BaseModel
from .db import connect, objects, find, put
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
    matches=find(db,'electives',grade_id=group.get('grade_id'),subject=subject['name'].strip())
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


def create_exam_subjects(db,project,ids,actor):
    if not isinstance(ids,list) or any(not isinstance(i,str) for i in ids):raise HTTPException(422,'科目选择无效')
    by_name={}
    for identifier in dict.fromkeys(ids):
        entry=require(db,identifier,'electives')
        grade=require(db,entry['grade_id'],'grades')
        if grade.get('archived'):raise HTTPException(422,'年级已停用')
        by_name.setdefault(entry['subject'],{})[grade['id']]=entry['id']
    for name,links in by_name.items():
        put(db,'subjects',{'project_id':project['id'],'name':name,'grade_ids':list(links),'catalog_by_grade':links,'group_mode':'custom'},actor)

@router.post('/electives/import-catalog')
def import_catalog(file:UploadFile=File(),current=Depends(admin)):
    from .roster_import import table_rows
    data=file.file.read(8*1024*1024+1)
    if len(data)>8*1024*1024:raise HTTPException(413,'文件超过8 MB')
    rows=table_rows(data,file.filename)
    if len(rows)<2:raise HTTPException(422,'请填写科目数据')
    headers=rows[0][1]
    columns=['年级','科目','类型']
    if any(headers.count(k)!=1 for k in columns):raise HTTPException(422,'表头需要年级、科目、类型三列')
    indices=[headers.index(k) for k in columns]
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        grades={g['name']:g['id'] for g in objects(db,'grades') if not g.get('archived')}
        existing={(s['grade_id'],s['subject']):s for s in objects(db,'electives')}
        created=0
        for n,row in rows[1:]:
            grade,name,label=[row[i] if i<len(row) else '' for i in indices]
            kind={'必考':'required','选考':'elective'}.get(label)
            if grade not in grades or not name or not kind:raise HTTPException(422,f'第{n}行请填写已有年级、科目名称和必考或选考')
            key=(grades[grade],name)
            if key in existing:
                if existing[key].get('kind_of_subject','elective')!=kind:raise HTTPException(409,f'第{n}行科目类型与已有记录不同，请单独编辑')
                continue
            existing[key]=put(db,'electives',{'grade_id':key[0],'subject':name,'kind_of_subject':kind,'student_ids':[]},current['id'])
            created+=1
        return {'created':created}
