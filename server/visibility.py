"""Published results scoped by class and school subject name."""
from .db import objects, get


def class_scope(db, user_id, subject_id):
    subject = get(db, subject_id, 'subjects') or {}
    return {cls['id'] for cls in objects(db, 'classes')
            if permits(cls, user_id, subject.get('name', '').strip())}


def permits(cls, user_id, subject):
    role = cls.get('teaching', {}).get(user_id, {})
    return user_id in cls.get('teacher_ids', []) and (
        role.get('homeroom') is True or subject in role.get('subjects', []))


def result_groups(db, user_id):
    classes = [c for c in objects(db, 'classes') if user_id in c.get('teacher_ids', [])
               and user_id in c.get('teaching', {})]
    names = {s['id']: s['name'].strip() for s in objects(db, 'subjects')}
    groups = {g['id']: names.get(g.get('subject_id'), '') for g in objects(db, 'groups')}
    visible = set()
    for cls in classes:
        visible.update(g for g in groups_for_classes(db, [cls['id']]) if permits(cls, user_id, groups.get(g, '')))
    return visible


def groups_for_classes(db, classes):
    if not classes:return set()
    placeholders=','.join('?' for _ in classes);parameters=list(classes)
    scanned=db.execute('''SELECT DISTINCT json_extract(s.body,'$.group_id') FROM objects s
        JOIN objects g ON g.id=json_extract(s.body,'$.group_id') AND g.kind='groups' AND g.deleted=0
        LEFT JOIN objects student ON student.id=json_extract(s.body,'$.student_id') AND student.kind='students'
        WHERE s.kind='submissions' AND s.deleted=0 AND json_extract(g.body,'$.frozen')=1
        AND CASE WHEN json_extract(g.body,'$.grade_id') IS NOT NULL THEN COALESCE(json_extract(student.body,'$.class_id'),json_extract(s.body,'$.student_snapshot.class_id')) ELSE COALESCE(json_extract(s.body,'$.student_snapshot.class_id'),json_extract(student.body,'$.class_id')) END IN ('''+placeholders+')',parameters)
    groups={r[0] for r in scanned}
    rosters=db.execute('''SELECT DISTINCT json_extract(r.body,'$.group_id') FROM objects r
        JOIN objects g ON g.id=json_extract(r.body,'$.group_id') AND g.kind='groups' AND g.deleted=0
        JOIN json_each(r.body,'$.students') student
        WHERE json_extract(g.body,'$.grade_id') IS NULL AND r.kind='rosters' AND r.deleted=0 AND json_extract(g.body,'$.frozen')=1
        AND json_extract(student.value,'$.class_id') IN ('''+placeholders+')',parameters)
    groups.update(r[0] for r in rosters)
    dynamic=db.execute('''SELECT DISTINCT g.id FROM objects g JOIN objects c ON c.kind='classes' AND c.deleted=0 AND json_extract(c.body,'$.grade_id')=json_extract(g.body,'$.grade_id') JOIN objects s ON s.kind='students' AND s.deleted=0 AND json_extract(s.body,'$.class_id')=c.id WHERE g.kind='groups' AND g.deleted=0 AND json_extract(g.body,'$.frozen')=1 AND (COALESCE(json_extract(g.body,'$.roster_mode'),'grade')!='selected' OR EXISTS (SELECT 1 FROM objects r, json_each(r.body,'$.student_ids') m WHERE r.id=json_extract(g.body,'$.roster_id') AND r.deleted=0 AND m.value=s.id)) AND c.id IN ('''+placeholders+')',parameters)
    groups.update(r[0] for r in dynamic)
    return groups
