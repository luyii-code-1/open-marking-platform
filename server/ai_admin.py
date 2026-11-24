"""AI-friendly administration endpoints: discovery, school snapshot, and batch configuration."""
import re
import secrets
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .db import connect, objects, put
from .dependencies import admin, password_hash
from .school import clean_class_tags
from .teaching import TeacherClassAssignment, TeacherProfileConfig, save_teacher_profile

router = APIRouter(prefix='/api/v1/ai', tags=['ai-admin'])


def _norm(text: str) -> str:
    return re.sub(r'\s+', '', str(text or '')).strip()


def _norm_class_name(name: str) -> str:
    s = _norm(name)
    m = re.fullmatch(r'(\d+)班?', s)
    return f'{int(m.group(1))}班' if m else s


def _resolve_teacher(users: list[dict], ref: str) -> dict | None:
    key = _norm(ref)
    if not key:
        return None
    for u in users:
        if u['id'] == ref or u['username'] == ref or _norm(u['username']) == key:
            return u
    matches = [u for u in users if _norm(u['name']) == key]
    return matches[0] if len(matches) == 1 else None


def _resolve_class(classes: list[dict], grade_map: dict[str, str], grade_ref: str, class_ref: str) -> dict | None:
    g_key = _norm(grade_ref)
    c_key = _norm_class_name(class_ref)
    for cls in classes:
        gname = _norm(grade_map.get(cls.get('grade_id'), cls.get('grade', '')))
        cname = _norm_class_name(cls.get('name', ''))
        if gname == g_key and cname == c_key:
            return cls
    return None


@router.get('/capabilities')
def ai_capabilities(current=Depends(admin)):
    """Machine-readable discovery manifest for AI-assisted administration."""
    return {
        'version': '1.0',
        'auth': 'Bearer token via POST /api/v1/auth/login (admin or manager role)',
        'endpoints': [
            {
                'method': 'GET',
                'path': '/api/v1/ai/school-snapshot',
                'summary': '获取年级、班级、学科标签、教师任教/班主任完整快照及缺失项诊断',
            },
            {
                'method': 'PUT',
                'path': '/api/v1/teaching/teacher/{teacher_id}',
                'summary': '按教师维度一次性设置任课科目、年级、标签、任教班级与班主任班级',
                'body': {
                    'subjects': ['语文'],
                    'grade_ids': ['grade_uuid'],
                    'tags': ['2+4'],
                    'class_ids': ['class_uuid'],
                    'homeroom_class_ids': ['class_uuid'],
                },
            },
            {
                'method': 'POST',
                'path': '/api/v1/ai/homerooms/batch',
                'summary': '按「年级 + 班级名 + 教师姓名/账号」批量设置班主任，支持 dry_run 预览',
                'body': {
                    'dry_run': False,
                    'replace_existing': True,
                    'items': [{'grade': '高一', 'class_name': '1班', 'teacher': '吴国建'}],
                },
            },
            {
                'method': 'POST',
                'path': '/api/v1/ai/teachers/batch-configure',
                'summary': '按教师姓名/账号批量补齐科目、年级、标签、任教班级与班主任，支持 merge 与 dry_run',
                'body': {
                    'dry_run': False,
                    'merge': True,
                    'create_missing': False,
                    'items': [
                        {
                            'teacher': '冯利波',
                            'subjects': ['数学'],
                            'grades': ['高一'],
                            'tags': ['2+4'],
                            'classes': [{'grade': '高一', 'class_name': '1班', 'subjects': ['数学'], 'homeroom': False}],
                        }
                    ],
                },
            },
            {
                'method': 'POST',
                'path': '/api/v1/ai/classes/batch-tags',
                'summary': '按「年级 + 班级名」批量设置/追加/清空班级标签',
                'body': {
                    'dry_run': False,
                    'items': [{'grade': '高一', 'class_name': '1班', 'tags': ['直卓'], 'mode': 'replace'}],
                },
            },
        ],
    }


@router.get('/school-snapshot')
def school_snapshot(current=Depends(admin)):
    """Return full structured school roster & teaching metadata with gap diagnostics."""
    with connect() as db:
        users = [dict(r) for r in db.execute('SELECT id, username, name, role FROM users ORDER BY role, username')]
        grades = objects(db, 'grades')
        classes = objects(db, 'classes')
        subject_tags = [t['name'] for t in objects(db, 'subject-tags') if t.get('name')]
        profiles = {p['id']: p for p in objects(db, 'teacher-profiles')}

    grade_map = {g['id']: g['name'] for g in grades}
    user_map = {u['id']: u for u in users}

    teacher_classes: dict[str, list[dict]] = {u['id']: [] for u in users}
    class_views = []
    classes_without_homeroom = []

    for cls in classes:
        gname = grade_map.get(cls.get('grade_id'), cls.get('grade', ''))
        teaching = cls.get('teaching') or {}
        homeroom_teachers = []
        class_teachers = []
        for tid in sorted(set(cls.get('teacher_ids') or []) | set(teaching.keys())):
            info = teaching.get(tid) or {}
            u = user_map.get(tid)
            if not u:
                continue
            subs = list(info.get('subjects') or [])
            is_hr = bool(info.get('homeroom'))
            class_teachers.append({'id': tid, 'username': u['username'], 'name': u['name'], 'subjects': subs, 'homeroom': is_hr})
            if is_hr:
                homeroom_teachers.append({'id': tid, 'username': u['username'], 'name': u['name']})
            teacher_classes.setdefault(tid, []).append({
                'class_id': cls['id'],
                'grade_id': cls.get('grade_id'),
                'grade': gname,
                'class_name': cls['name'],
                'subjects': subs,
                'homeroom': is_hr,
            })
        view = {
            'id': cls['id'],
            'grade_id': cls.get('grade_id'),
            'grade': gname,
            'name': cls['name'],
            'tags': cls.get('tags') or [],
            'homeroom_teachers': homeroom_teachers,
            'teachers': class_teachers,
        }
        class_views.append(view)
        if not homeroom_teachers:
            classes_without_homeroom.append({'class_id': cls['id'], 'grade': gname, 'class_name': cls['name']})

    teacher_views = []
    teachers_without_subjects = []
    teachers_without_classes = []

    for u in users:
        if u['role'] != 'teacher':
            continue
        prof = profiles.get(u['id']) or {}
        rels = teacher_classes.get(u['id']) or []
        subs = sorted({*prof.get('subjects', []), *(s for r in rels for s in r['subjects'] if s)})
        gids = list(dict.fromkeys([*prof.get('grade_ids', []), *(r['grade_id'] for r in rels if r.get('grade_id'))]))
        hr_classes = [{'class_id': r['class_id'], 'grade': r['grade'], 'class_name': r['class_name']} for r in rels if r['homeroom']]
        item = {
            'id': u['id'],
            'username': u['username'],
            'name': u['name'],
            'role': u['role'],
            'profile_subjects': prof.get('subjects', []),
            'subjects': subs,
            'grade_ids': gids,
            'grades': [grade_map.get(gid, '') for gid in gids if grade_map.get(gid)],
            'tags': prof.get('tags', []),
            'class_count': len(rels),
            'classes': rels,
            'homeroom_classes': hr_classes,
        }
        teacher_views.append(item)
        if not subs:
            teachers_without_subjects.append({'id': u['id'], 'username': u['username'], 'name': u['name']})
        if not rels:
            teachers_without_classes.append({'id': u['id'], 'username': u['username'], 'name': u['name']})

    return {
        'grades': [{'id': g['id'], 'name': g['name'], 'archived': bool(g.get('archived'))} for g in grades],
        'subject_tags': sorted(set(subject_tags)),
        'classes': class_views,
        'teachers': teacher_views,
        'diagnostics': {
            'total_teachers': len(teacher_views),
            'total_classes': len(class_views),
            'teachers_without_subjects': teachers_without_subjects,
            'teachers_without_classes': teachers_without_classes,
            'classes_without_homeroom': classes_without_homeroom,
        },
    }


class HomeroomItem(BaseModel):
    grade: str = Field(min_length=1, max_length=60)
    class_name: str = Field(min_length=1, max_length=60)
    teacher: str = Field(min_length=1, max_length=100)


class BatchHomerooms(BaseModel):
    items: list[HomeroomItem] = Field(min_length=1, max_length=500)
    replace_existing: bool = True
    dry_run: bool = False


@router.post('/homerooms/batch')
def batch_set_homerooms(body: BatchHomerooms, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE' if not body.dry_run else 'BEGIN')
        users = [dict(r) for r in db.execute("SELECT id, username, name, role FROM users WHERE role='teacher'")]
        grades = objects(db, 'grades')
        classes = objects(db, 'classes')
        grade_map = {g['id']: g['name'] for g in grades}

        matched = []
        errors = []
        updated = 0
        for idx, item in enumerate(body.items, 1):
            cls = _resolve_class(classes, grade_map, item.grade, item.class_name)
            teacher = _resolve_teacher(users, item.teacher)
            if not cls:
                errors.append({'index': idx, 'item': item.model_dump(), 'error': '未找到匹配班级'})
                continue
            if not teacher:
                errors.append({'index': idx, 'item': item.model_dump(), 'error': '未找到唯一匹配的教师账号'})
                continue
            roles = dict(cls.get('teaching') or {})
            ids = set(cls.get('teacher_ids') or [])
            if body.replace_existing:
                for uid, info in list(roles.items()):
                    if uid != teacher['id'] and info.get('homeroom'):
                        info = dict(info)
                        info['homeroom'] = False
                        if not info.get('subjects'):
                            roles.pop(uid, None)
                            ids.discard(uid)
                        else:
                            roles[uid] = info
            cur = dict(roles.get(teacher['id']) or {'subjects': []})
            cur['homeroom'] = True
            roles[teacher['id']] = cur
            ids.add(teacher['id'])
            matched.append({
                'grade': grade_map.get(cls.get('grade_id'), cls.get('grade', '')),
                'class_id': cls['id'],
                'class_name': cls['name'],
                'teacher_id': teacher['id'],
                'teacher_name': teacher['name'],
            })
            if not body.dry_run:
                cls['teaching'] = roles
                cls['teacher_ids'] = sorted(ids)
                put(db, 'classes', cls, current['id'])
                updated += 1
        return {'dry_run': body.dry_run, 'updated': updated, 'matched': matched, 'errors': errors}


class BatchTeacherClassRef(BaseModel):
    grade: str = Field(min_length=1, max_length=60)
    class_name: str = Field(min_length=1, max_length=60)
    subjects: list[str] | None = None
    homeroom: bool | None = None


class BatchTeacherItem(BaseModel):
    teacher: str = Field(min_length=1, max_length=100)
    subjects: list[str] = Field(default_factory=list, max_length=100)
    grades: list[str] = Field(default_factory=list, max_length=20)
    tags: list[str] = Field(default_factory=list, max_length=20)
    classes: list[BatchTeacherClassRef] | None = None


class BatchConfigureTeachers(BaseModel):
    items: list[BatchTeacherItem] = Field(min_length=1, max_length=500)
    merge: bool = True
    create_missing: bool = False
    dry_run: bool = False


@router.post('/teachers/batch-configure')
def batch_configure_teachers(body: BatchConfigureTeachers, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE' if not body.dry_run else 'BEGIN')
        users = [dict(r) for r in db.execute("SELECT id, username, name, role FROM users WHERE role='teacher'")]
        grades = objects(db, 'grades')
        classes = objects(db, 'classes')
        profiles = {p['id']: p for p in objects(db, 'teacher-profiles')}
        grade_map = {g['id']: g['name'] for g in grades}
        grade_by_norm = {_norm(g['name']): g['id'] for g in grades}

        results = []
        created_accounts = []
        errors = []

        for idx, item in enumerate(body.items, 1):
            teacher = _resolve_teacher(users, item.teacher)
            if not teacher and body.create_missing:
                name = item.teacher.strip()
                uid = str(uuid4())
                username = name
                suffix = 2
                while db.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
                    username = f'{name}{suffix}'
                    suffix += 1
                pwd = secrets.token_urlsafe(15)
                teacher = {'id': uid, 'username': username, 'name': name, 'role': 'teacher'}
                if not body.dry_run:
                    db.execute('INSERT INTO users VALUES(?,?,?,?,?)', (uid, username, name, 'teacher', password_hash(pwd)))
                    put(db, 'account-events', {'user_id': uid, 'action': 'created', 'username': username, 'name': name, 'role': 'teacher'}, current['id'])
                    created_accounts.append({'id': uid, 'username': username, 'name': name, 'password': pwd})
                users.append(teacher)
            if not teacher:
                errors.append({'index': idx, 'teacher': item.teacher, 'error': '未找到唯一匹配的教师账号'})
                continue

            old_prof = profiles.get(teacher['id']) or {}
            gids = [grade_by_norm[_norm(g)] for g in item.grades if _norm(g) in grade_by_norm]
            merged_subjects = sorted({*(old_prof.get('subjects', []) if body.merge else []), *(s.strip() for s in item.subjects if s and s.strip())})
            merged_gids = list(dict.fromkeys([*(old_prof.get('grade_ids', []) if body.merge else []), *gids]))
            merged_tags = sorted({*(old_prof.get('tags', []) if body.merge else []), *(t.strip() for t in item.tags if t and t.strip())})

            assignments: list[TeacherClassAssignment] | None = None
            if item.classes is not None:
                by_cid: dict[str, TeacherClassAssignment] = {}
                if body.merge:
                    for cls in classes:
                        existing = (cls.get('teaching') or {}).get(teacher['id'])
                        if existing:
                            by_cid[cls['id']] = TeacherClassAssignment(
                                class_id=cls['id'],
                                subjects=list(existing.get('subjects') or []),
                                homeroom=bool(existing.get('homeroom')),
                            )
                for cref in item.classes:
                    cls = _resolve_class(classes, grade_map, cref.grade, cref.class_name)
                    if not cls:
                        errors.append({'index': idx, 'teacher': item.teacher, 'error': f'未找到班级：{cref.grade} {cref.class_name}'})
                        continue
                    prev = by_cid.get(cls['id'])
                    subs = cref.subjects if cref.subjects is not None else (merged_subjects or (prev.subjects if prev else []))
                    if body.merge and prev and cref.subjects is not None:
                        subs = sorted({*prev.subjects, *cref.subjects})
                    hr = cref.homeroom if cref.homeroom is not None else (prev.homeroom if prev else False)
                    by_cid[cls['id']] = TeacherClassAssignment(class_id=cls['id'], subjects=subs, homeroom=hr)
                assignments = list(by_cid.values())

            cfg = TeacherProfileConfig(
                subjects=merged_subjects,
                grade_ids=merged_gids,
                tags=merged_tags,
                assignments=assignments,
            )
            if not body.dry_run:
                res = save_teacher_profile(db, teacher['id'], cfg, current['id'])
                classes = objects(db, 'classes')
                profiles[teacher['id']] = res['profile']
            results.append({'teacher_id': teacher['id'], 'teacher_name': teacher['name'], 'subjects': merged_subjects, 'grade_ids': merged_gids, 'tags': merged_tags})

        return {'dry_run': body.dry_run, 'configured': len(results), 'results': results, 'created_accounts': created_accounts, 'errors': errors}


class BatchClassTagItem(BaseModel):
    grade: str = Field(min_length=1, max_length=60)
    class_name: str = Field(min_length=1, max_length=60)
    tags: list[str] = Field(default_factory=list)
    mode: str = Field(default='replace', pattern='^(replace|add|clear)$')


class BatchClassTags(BaseModel):
    items: list[BatchClassTagItem] = Field(min_length=1, max_length=500)
    dry_run: bool = False


@router.post('/classes/batch-tags')
def batch_class_tags(body: BatchClassTags, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE' if not body.dry_run else 'BEGIN')
        grades = objects(db, 'grades')
        classes = objects(db, 'classes')
        grade_map = {g['id']: g['name'] for g in grades}
        updated = 0
        errors = []
        for idx, item in enumerate(body.items, 1):
            cls = _resolve_class(classes, grade_map, item.grade, item.class_name)
            if not cls:
                errors.append({'index': idx, 'item': item.model_dump(), 'error': '未找到匹配班级'})
                continue
            tags = clean_class_tags(item.tags)
            if item.mode == 'clear':
                next_tags = []
            elif item.mode == 'add':
                next_tags = clean_class_tags([*(cls.get('tags') or []), *tags])
            else:
                next_tags = tags
            if not body.dry_run:
                cls['tags'] = next_tags
                put(db, 'classes', cls, current['id'])
                updated += 1
        return {'dry_run': body.dry_run, 'updated': updated, 'errors': errors}
