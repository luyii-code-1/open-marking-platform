"""Published result scope from the teacher's current class assignments."""


def taught_classes(db,user_id):
    return {r[0] for r in db.execute("SELECT id FROM objects WHERE kind='classes' AND deleted=0 AND EXISTS(SELECT 1 FROM json_each(body,'$.teacher_ids') WHERE value=?)",(user_id,))}


def result_groups(db,user_id,classes=None):
    classes=taught_classes(db,user_id) if classes is None else classes
    if not classes:return set()
    placeholders=','.join('?' for _ in classes);parameters=list(classes)
    scanned=db.execute('''SELECT DISTINCT json_extract(s.body,'$.group_id') FROM objects s
        JOIN objects g ON g.id=json_extract(s.body,'$.group_id') AND g.kind='groups' AND g.deleted=0
        LEFT JOIN objects student ON student.id=json_extract(s.body,'$.student_id') AND student.kind='students'
        WHERE s.kind='submissions' AND s.deleted=0 AND json_extract(g.body,'$.frozen')=1
        AND COALESCE(json_extract(s.body,'$.student_snapshot.class_id'),json_extract(student.body,'$.class_id')) IN ('''+placeholders+')',parameters)
    groups={r[0] for r in scanned}
    rosters=db.execute('''SELECT DISTINCT json_extract(r.body,'$.group_id') FROM objects r
        JOIN objects g ON g.id=json_extract(r.body,'$.group_id') AND g.kind='groups' AND g.deleted=0
        JOIN json_each(r.body,'$.students') student
        WHERE r.kind='rosters' AND r.deleted=0 AND json_extract(g.body,'$.frozen')=1
        AND json_extract(student.value,'$.class_id') IN ('''+placeholders+')',parameters)
    groups.update(r[0] for r in rosters)
    return groups
