from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
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


@router.delete('/relation')
def remove(relation: Relation, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        save(db, relation, current['id'], remove=True)
    return {'removed': True}


@router.get('/template')
def template(current=Depends(admin)):
    return FileResponse(Path(__file__).parent/'assets'/'teaching-template.xlsx',filename='teaching-template.xlsx')


@router.post('/import')
def import_relations(file: UploadFile = File(), commit: bool = False, current=Depends(admin)):
    sheets = read_file(file)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE' if commit else 'BEGIN')
        from .teaching_matrix import matrix_import
        matrix = matrix_import(db, sheets, commit, current["id"])
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
