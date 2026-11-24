import json
from fastapi import Form, APIRouter, Depends, File, HTTPException, UploadFile
from pathlib import Path
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from .db import connect, get, objects, put
from .dependencies import admin, user
from .student_import import read_file

router = APIRouter(prefix='/api/v1/teaching')
HEADERS = ['教师账号', '年级', '班级', '任教学科', '是否班主任']


class Relation(BaseModel):
    teacher_id: str
    class_id: str
    subjects: list[str] = Field(max_length=100)
    homeroom: bool | None = None


class TeacherClassAssignment(BaseModel):
    class_id: str
    subjects: list[str] = Field(default_factory=list, max_length=100)
    homeroom: bool = False


class TeacherProfileConfig(BaseModel):
    subjects: list[str] = Field(default_factory=list, max_length=100)
    grade_ids: list[str] = Field(default_factory=list, max_length=20)
    tags: list[str] = Field(default_factory=list, max_length=20)
    class_ids: list[str] | None = None
    homeroom_class_ids: list[str] | None = None
    assignments: list[TeacherClassAssignment] | None = None


def save_teacher_profile(db, teacher_id: str, config: TeacherProfileConfig, actor: str) -> dict:
    row = db.execute("SELECT id, username, name, role FROM users WHERE id=?", (teacher_id,)).fetchone()
    if not row:
        raise HTTPException(404, '教师账号不存在')
    clean_subjects = sorted({s.strip() for s in config.subjects if s and s.strip()})
    valid_grades = {g['id'] for g in objects(db, 'grades')}
    clean_grade_ids = [gid for gid in dict.fromkeys(config.grade_ids) if gid in valid_grades]
    clean_tags = sorted({t.strip() for t in config.tags if t and t.strip()})[:20]

    profile = {
        'id': teacher_id,
        'subjects': clean_subjects,
        'grade_ids': clean_grade_ids,
        'tags': clean_tags,
    }
    put(db, 'teacher-profiles', profile, actor)

    updated_classes = 0
    if config.assignments is not None or config.class_ids is not None or config.homeroom_class_ids is not None:
        all_classes = objects(db, 'classes')
        class_by_id = {c['id']: c for c in all_classes}
        target: dict[str, dict] = {}
        if config.assignments is not None:
            for item in config.assignments:
                if item.class_id not in class_by_id:
                    raise HTTPException(422, f'班级不存在：{item.class_id}')
                subs = sorted({s.strip() for s in item.subjects if s and s.strip()})
                if not subs and not item.homeroom:
                    continue
                target[item.class_id] = {'subjects': subs, 'homeroom': bool(item.homeroom)}
        else:
            taught_set = set(config.class_ids or [])
            homeroom_set = set(config.homeroom_class_ids or [])
            for cid in taught_set | homeroom_set:
                if cid not in class_by_id:
                    raise HTTPException(422, f'班级不存在：{cid}')
                existing_role = (class_by_id[cid].get('teaching') or {}).get(teacher_id) or {}
                if cid in taught_set:
                    subs = clean_subjects or sorted({s.strip() for s in existing_role.get('subjects', []) if s and s.strip()})
                else:
                    subs = sorted({s.strip() for s in existing_role.get('subjects', []) if s and s.strip()})
                is_homeroom = cid in homeroom_set
                if not subs and not is_homeroom:
                    continue
                target[cid] = {'subjects': subs, 'homeroom': is_homeroom}

        for cls in all_classes:
            cid = cls['id']
            roles = dict(cls.get('teaching') or {})
            ids = set(cls.get('teacher_ids') or [])
            old_role = roles.get(teacher_id)
            old_in = teacher_id in ids
            if cid in target:
                new_role = target[cid]
                if old_role != new_role or not old_in:
                    roles[teacher_id] = new_role
                    ids.add(teacher_id)
                    cls['teaching'] = roles
                    cls['teacher_ids'] = sorted(ids)
                    put(db, 'classes', cls, actor)
                    updated_classes += 1
            else:
                if teacher_id in roles or old_in:
                    roles.pop(teacher_id, None)
                    ids.discard(teacher_id)
                    cls['teaching'] = roles
                    cls['teacher_ids'] = sorted(ids)
                    put(db, 'classes', cls, actor)
                    updated_classes += 1

    return {'teacher_id': teacher_id, 'profile': profile, 'updated_classes': updated_classes}


def save(db, relation, actor, remove=False):
    cls = get(db, relation.class_id, 'classes')
    if not cls or not db.execute("SELECT 1 FROM users WHERE id=? AND role='teacher'", (relation.teacher_id,)).fetchone():
        raise HTTPException(422, '班级或教师账号不存在')
    subjects = sorted({s.strip() for s in relation.subjects if s.strip()})
    if not remove and not subjects and not relation.homeroom:
        raise HTTPException(422, '请选择任教学科或班主任')
    uid = relation.teacher_id
    roles = cls.setdefault('teaching', {})
    ids = set(cls.get('teacher_ids', []))
    if remove:
        roles.pop(uid, None)
        ids.discard(uid)
    else:
        roles[uid] = {'subjects': subjects, 'homeroom': relation.homeroom}
        ids.add(uid)
    cls['teacher_ids'] = sorted(ids)
    put(db, 'classes', cls, actor)


@router.get('/mine')
def mine(current=Depends(user)):
    with connect() as db:
        grades = {g['id']: g['name'] for g in objects(db, 'grades')}
        return [dict(class_id=c['id'], class_name=c['name'], grade=grades.get(c.get('grade_id'), c.get('grade')), **c.get('teaching', {}).get(current['id'], {}))
                for c in objects(db, 'classes') if current['id'] in c.get('teacher_ids', [])]


@router.put('/relation')
def edit(relation: Relation, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        save(db, relation, current['id'])
    return {'saved': True}


@router.put('/teacher/{teacher_id}')
def configure_teacher(teacher_id: str, body: TeacherProfileConfig, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        result = save_teacher_profile(db, teacher_id, body, current['id'])
    return {'saved': True, **result}


class RelationRef(BaseModel):
    teacher_id: str
    class_id: str


class BatchRemoveRelations(BaseModel):
    items: list[RelationRef] = Field(min_length=1, max_length=500)


@router.delete('/relation')
def remove(relation: Relation, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        save(db, relation, current['id'], remove=True)
    return {'removed': True}


@router.post('/relations/remove')
def remove_batch(body: BatchRemoveRelations, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        for item in body.items:
            save(db, Relation(teacher_id=item.teacher_id, class_id=item.class_id, subjects=[]), current['id'], remove=True)
    return {'removed': len(body.items)}


@router.get('/template')
def template(current=Depends(admin)):
    return FileResponse(Path(__file__).parent/'assets'/'teaching-template.xlsx',filename='teaching-template.xlsx')


@router.post('/import')
def import_relations(file: UploadFile = File(), commit: bool = False, decisions:str=Form("{}"), current=Depends(admin)):
    sheets = read_file(file)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE' if commit else 'BEGIN')
        from .teaching_matrix import matrix_import
        try:
            choices=json.loads(decisions)
            if not isinstance(choices,dict) or not all(isinstance(v,str) for v in choices.values()):raise ValueError
        except ValueError:raise HTTPException(422,'教师匹配选项无效')
        matrix = matrix_import(db, sheets, commit, current["id"],choices)
        if matrix is not None:
            return matrix
        users = {u['username']:u['id'] for u in db.execute("SELECT id,username FROM users WHERE role='teacher'")}
        grades = {g['id']:g['name'] for g in objects(db, 'grades')}
        lookup = {}
        for cls in objects(db, 'classes'):
            key = (grades.get(cls.get('grade_id'), cls.get('grade')), cls['name'])
            lookup.setdefault(key, []).append(cls['id'])
        pairs = {}
        errors = []
        for sheet, (headers, rows) in sheets.items():
            if sheet == '填写说明':
                continue
            if any(headers.count(h) != 1 for h in HEADERS):
                raise HTTPException(422, f'{sheet} 缺少模板列或表头重复')
            columns = [headers.index(h) for h in HEADERS]
            for line, row in rows:
                account, grade, name, subject, flag = (row[i].strip() if i < len(row) else '' for i in columns)
                uid = users.get(account)
                matches = lookup.get((grade, name), [])
                prefix = f'{sheet} 第 {line} 行'
                if not uid or len(matches) != 1 or flag not in ('是','否') or (not subject and flag == '否'):
                    errors.append(prefix + '：请检查教师账号、年级班级、学科及班主任（是／否）')
                    continue
                key = (uid, matches[0])
                item = pairs.setdefault(key, Relation(teacher_id=uid, class_id=matches[0], subjects=[], homeroom=flag=='是'))
                if item.homeroom != (flag=='是'):
                    errors.append(prefix + '：同一教师与班级的班主任标记不一致')
                if subject and subject not in item.subjects:
                    item.subjects.append(subject)
        if not pairs and not errors:
            raise HTTPException(422, '没有任教记录')
        if commit and not errors:
            for item in pairs.values():
                save(db, item, current['id'])
        return {'relations':[r.model_dump() for r in pairs.values()], 'count': len(pairs), 'errors': errors, 'saved': commit and not errors}
