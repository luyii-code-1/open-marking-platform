from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, objects, put
from .dependencies import admin, require

router=APIRouter(prefix='/api/v1')


@router.get('/groups/{identifier}/roster')
def roster(identifier:str,current=Depends(admin)):
    with connect() as db:
        group=require(db,identifier,'groups')
        saved=require(db,group['roster_id'],'rosters') if group.get('roster_id') else None
        submissions={s['student_id']:s for s in find(db,'submissions',group_id=identifier)}
        return {'group_id':identifier,'configured':bool(saved),'class_ids':(saved or {}).get('class_ids',[]),'student_ids':(saved or {}).get('student_ids',[]),'students':[{**s,'status':'unscanned' if s['id'] not in submissions else 'absent' if submissions[s['id']]['status']=='absent' else 'scanned'} for s in (saved or {}).get('students',[])]}


@router.put('/groups/{identifier}/roster')
def set_roster(identifier:str,body:dict,current=Depends(admin)):
    class_ids=body.get('class_ids',[]);student_ids=body.get('student_ids',[])
    if any(not isinstance(values,list) or any(not isinstance(v,str) for v in values) for values in (class_ids,student_ids)):raise HTTPException(422,'班级或学生名单无效')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核')
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
