import hashlib
import json
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from .lifecycle import RESULTS_REVIEW_GUIDE
from .db import connect, find, get, objects, put
from .dependencies import admin, require

router=APIRouter(prefix='/api/v1')


@router.get('/groups/{identifier}/roster/candidates')
def roster_candidates(identifier:str,current=Depends(admin)):
    from .school import group_students,student_view
    with connect() as db:
        db.execute('BEGIN')
        group=require(db,identifier,'groups')
        if not group.get('grade_id'):raise HTTPException(422,'请先设置题卡所属年级')
        classes=[c for c in objects(db,'classes') if c.get('grade_id')==group['grade_id']]
        class_ids={c['id'] for c in classes}
        selected={s['id'] for s in group_students(db,group) or []}
        students=[{**student_view(db,s),'in_roster':s['id'] in selected} for s in objects(db,'students') if s.get('class_id') in class_ids]
        return {'group_id':identifier,'grade_id':group['grade_id'],'classes':classes,'students':students,'roster_count':len(selected)}


@router.post('/groups/{identifier}/roster/remove-students')
def remove_roster_students(identifier:str,body:dict,current=Depends(admin)):
    from .school import group_students
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
        ids=body.get('student_ids')
        if not isinstance(ids,list) or not ids or any(not isinstance(sid,str) or not sid for sid in ids):raise HTTPException(422,'请选择需要移出的应考学生')
        selected=set(ids)
        members=group_students(db,group) or []
        if not selected.issubset({s['id'] for s in members}):raise HTTPException(409,'应考名单已变化，请刷新后重新选择')
        retained=sum(s['student_id'] in selected for s in find(db,'submissions',group_id=identifier))
        if retained and body.get('confirm_retained') is not True:raise HTTPException(409,'所选学生已有答卷记录，请确认仅移出应考名单并保留已有答卷、评分和成绩')
        remaining=[s for s in members if s['id'] not in selected]
        old=get(db,group.get('roster_id'),'rosters') or {}
        if group.get('grade_id') or group.get('roster_mode')=='selected':
            from .electives import save_members
            save_members(db,group,remaining,old.get('source','manual'),set(old.get('supplemental_ids',[]))-selected,current['id'])
        else:
            roster={**old,'group_id':identifier,'class_ids':[],'student_ids':[s['id'] for s in remaining],'students':remaining}
            saved=put(db,'rosters',roster,current['id'])
            put(db,'groups',{**group,'roster_id':saved['id'],'expected_students':len(remaining)},current['id'])
        return {'removed':len(selected),'retained_submissions':retained,'count':len(remaining)}


@router.get('/groups/{identifier}/roster')
def roster(identifier:str,current=Depends(admin)):
    with connect() as db:
        group=require(db,identifier,'groups')
        saved=require(db,group['roster_id'],'rosters') if group.get('roster_id') else None
        if group.get('grade_id') or group.get('roster_mode')=='selected':
            from .school import group_students
            students=group_students(db,group);submissions={s['student_id']:s for s in find(db,'submissions',group_id=identifier)}
            return {'group_id':identifier,'configured':True,'dynamic':True,'mode':group.get('roster_mode','grade'),'grade_id':group.get('grade_id'),'class_ids':[],'student_ids':(saved or {}).get('student_ids',[]),
                    'students':[{**s,'status':'unscanned' if s['id'] not in submissions else 'absent' if submissions[s['id']]['status']=='absent' else 'scanned'} for s in students]}
        submissions={s['student_id']:s for s in find(db,'submissions',group_id=identifier)}
        return {'group_id':identifier,'configured':bool(saved),'class_ids':(saved or {}).get('class_ids',[]),'student_ids':(saved or {}).get('student_ids',[]),'students':[{**s,'status':'unscanned' if s['id'] not in submissions else 'absent' if submissions[s['id']]['status']=='absent' else 'scanned'} for s in (saved or {}).get('students',[])]}


@router.put('/groups/{identifier}/roster')
def set_roster(identifier:str,body:dict,current=Depends(admin)):
    class_ids=body.get('class_ids',[]);student_ids=body.get('student_ids',[])
    if any(not isinstance(values,list) or any(not isinstance(v,str) for v in values) for values in (class_ids,student_ids)):raise HTTPException(422,'班级或学生名单无效')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
        if body.get('mode')=='grade':
            if not group.get('grade_id'):raise HTTPException(422,'请先设置题卡所属年级')
            group['roster_mode']='grade';put(db,'groups',group,current['id'])
            from .school import group_students
            return {'expected_students':len(group_students(db,group))}
        if group.get('grade_id'):raise HTTPException(409,'请通过表格导入设置指定名单，或选择使用年级全体学生')
        classes={c:require(db,c,'classes') for c in set(class_ids)}
        for sid in set(student_ids):require(db,sid,'students')
        selected=[s for s in objects(db,'students') if s['class_id'] in classes or s['id'] in student_ids]
        snapshots=[]
        for student in selected:
            cls=classes.get(student['class_id']) or require(db,student['class_id'],'classes')
            snapshots.append({**{k:student[k] for k in ('id','name','candidate_number','class_id')},'class_name':cls['name'],'grade':cls.get('grade')})
        value={'group_id':identifier,'class_ids':list(dict.fromkeys(class_ids)),'student_ids':list(dict.fromkeys(student_ids)),'students':snapshots}
        if group.get('roster_id'):value['id']=group['roster_id']
        saved=put(db,'rosters',value,current['id'])
        group.update(roster_id=saved['id'],expected_students=len(snapshots));put(db,'groups',group,current['id'])
        return {'expected_students':len(snapshots)}


@router.get('/groups/{identifier}/roster/template')
def import_template(identifier:str,current=Depends(admin)):
    with connect() as db:require(db,identifier,'groups')
    return FileResponse(Path(__file__).parent/'assets'/'roster-template.xlsx',filename='roster-template.xlsx',media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',headers={'Cache-Control':'private, no-store'})


@router.post('/groups/{identifier}/roster/import')
def import_roster(identifier:str,file:UploadFile=File(),action:str=Form('preview'),preview_sha:str=Form(''),confirm_warnings:bool=Form(False),current=Depends(admin)):
    from .roster_import import read_rows,match_rows
    if action not in ('preview','import'):raise HTTPException(422,'导入操作无效')
    content=file.file.read(5*1024*1024+1)
    if len(content)>5*1024*1024:raise HTTPException(413,'名单文件不能超过5MB')
    rows=read_rows(content,file.filename or '')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
        if not group.get('grade_id'):raise HTTPException(422,'请先设置题卡所属年级')
        report=match_rows(db,group,rows)
        payload={'file':hashlib.sha256(content).hexdigest(),'group':group,'report':report}
        signature=hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        if action=='preview':return {**report,'preview_sha':signature}
        if preview_sha!=signature:raise HTTPException(409,'文件、学生资料或题卡设置已变化，请重新预览')
        if report['errors']:raise HTTPException(422,'请先修正未匹配或无效的记录，再重新上传')
        if report['warnings'] and not confirm_warnings:raise HTTPException(422,'请确认跨年级或姓名差异记录')
        if not report['students']:raise HTTPException(422,'名单至少需要一名学生')
        value={'group_id':identifier,'class_ids':[],'student_ids':[s['id'] for s in report['students']],'students':report['students'],'source':'spreadsheet'}
        if group.get('roster_id'):value['id']=group['roster_id']
        saved=put(db,'rosters',value,current['id'])
        group.update(roster_id=saved['id'],roster_mode='selected',expected_students=len(value['student_ids']))
        put(db,'groups',group,current['id'])
        return {'expected_students':len(value['student_ids']),'duplicates':report['duplicates'],'mode':'selected'}
