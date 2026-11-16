"""Searchable card index using the actual expected roster for class tags."""
from fastapi import APIRouter, Depends
from .db import connect, objects
from .dependencies import admin
from .school import group_students

router=APIRouter(prefix='/api/v1')


@router.get('/exam-catalog')
def exam_catalog(current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN')
        projects={p['id']:p for p in objects(db,'projects')}
        subjects={s['id']:s for s in objects(db,'subjects')}
        grades={g['id']:g for g in objects(db,'grades')}
        classes={c['id']:c for c in objects(db,'classes')}
        rows=[]
        for group in objects(db,'groups'):
            subject=subjects.get(group['subject_id'])
            project=projects.get((subject or {}).get('project_id'))
            if not project or not subject:continue
            students=group_students(db,group)
            class_ids=sorted({s['class_id'] for s in students or [] if s.get('class_id')})
            rows.append({**group,'project_id':project['id'],'project_name':project['name'],
                         'subject_name':subject['name'],'subject_key':subject.get('subject_tag_id') or subject['name'],
                         'grade_name':grades.get(group.get('grade_id'),{}).get('name') or group.get('grade_name') or '待设置年级',
                         'class_ids':class_ids,'class_names':[classes[c]['name'] for c in class_ids if c in classes],
                         'roster_count':len(students) if students is not None else None})
        return rows
