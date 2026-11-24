"""Unified tagging system: built-in grade/elective tags and customizable user tags."""
import re
from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, get, objects, put
from .dependencies import admin, require

router = APIRouter(prefix='/api/v1')

DEFAULT_CUSTOM_TAGS = [
    ('直卓', 'purple'),
    ('卓越', 'blue'),
    ('重点', 'geekblue'),
    ('实验', 'cyan'),
    ('普通', 'default'),
]

GRADE_DEFAULT_COLORS = {
    '高一': 'blue',
    '高二': 'green',
    '高三': 'purple',
}

PRESET_COLORS = {
    'default', 'blue', 'green', 'purple', 'cyan', 'geekblue', 'magenta',
    'red', 'volcano', 'orange', 'gold', 'lime', 'processing', 'success', 'warning', 'error',
}


def clean_color(raw, default='blue'):
    if raw is None or str(raw).strip() == '':
        return default
    text = str(raw).strip()
    if text in PRESET_COLORS or re.fullmatch(r'#[0-9a-fA-F]{6}', text):
        return text
    raise HTTPException(422, '标签颜色无效，请选择预设颜色或十六进制颜色码')


def clean_tag_name(raw):
    text = str(raw or '').strip()
    if not 1 <= len(text) <= 30:
        raise HTTPException(422, '标签名称需 1 至 30 字')
    return text


def ensure_synced_custom_tags(db, actor=None):
    """Ensure every class.tags entry has a corresponding custom tag object in 'tags'."""
    existing = {t['name']: t for t in objects(db, 'tags') if t.get('category', 'custom') == 'custom'}
    classes = objects(db, 'classes')
    needed_names = set()
    for cls in classes:
        for tname in cls.get('tags') or []:
            text = str(tname).strip()
            if text:
                needed_names.add(text)
    defaults_map = dict(DEFAULT_CUSTOM_TAGS)
    changed = False
    for name in sorted(needed_names):
        if name not in existing:
            tag = put(db, 'tags', {
                'name': name,
                'category': 'custom',
                'color': defaults_map.get(name, 'blue'),
                'description': '',
                'student_ids': [],
            }, actor)
            existing[name] = tag
            changed = True
    return existing


def _meta_map(db):
    return {m.get('ref_key'): m for m in objects(db, 'tag-meta') if m.get('ref_key')}


def _set_meta(db, ref_key, color, actor):
    existing = next((m for m in objects(db, 'tag-meta') if m.get('ref_key') == ref_key), None)
    body = {**(existing or {}), 'ref_key': ref_key, 'color': color}
    return put(db, 'tag-meta', body, actor)


def build_tag_catalog(db):
    """Return unified list of built-in (grade, elective) and custom tags with member counts."""
    ensure_synced_custom_tags(db)
    meta = _meta_map(db)
    grades = [g for g in objects(db, 'grades') if not g.get('archived')]
    classes = objects(db, 'classes')
    students = objects(db, 'students')
    electives = objects(db, 'electives')
    subject_tags = objects(db, 'subject-tags')
    custom_tags = [t for t in objects(db, 'tags') if t.get('category', 'custom') == 'custom']

    class_by_id = {c['id']: c for c in classes}
    students_by_class = {}
    students_by_grade = {}
    for s in students:
        cid = s.get('class_id')
        students_by_class.setdefault(cid, []).append(s['id'])
        cls = class_by_id.get(cid)
        if cls and cls.get('grade_id'):
            students_by_grade.setdefault(cls['grade_id'], []).append(s['id'])

    result = []

    # 1. Built-in grade tags
    for g in grades:
        ref_key = f"grade:{g['id']}"
        color = meta.get(ref_key, {}).get('color') or GRADE_DEFAULT_COLORS.get(g['name'], 'blue')
        g_classes = [c['id'] for c in classes if c.get('grade_id') == g['id']]
        g_students = students_by_grade.get(g['id'], [])
        result.append({
            'id': ref_key,
            'ref_id': g['id'],
            'name': g['name'],
            'category': 'grade',
            'builtin': True,
            'color': color,
            'description': '系统内置年级标签，修改名称将同步更新年级',
            'class_ids': g_classes,
            'student_ids': g_students,
            'class_count': len(g_classes),
            'student_count': len(g_students),
        })

    # 2. Built-in elective/subject tags
    subject_students = {}
    for el in electives:
        subj = str(el.get('subject') or '').strip()
        if not subj:
            continue
        bucket = subject_students.setdefault(subj, set())
        if el.get('kind_of_subject') == 'required':
            bucket.update(students_by_grade.get(el.get('grade_id'), []))
        else:
            bucket.update(el.get('student_ids') or [])

    seen_subjects = set()
    for st in sorted(subject_tags, key=lambda x: x.get('name', '')):
        sname = str(st.get('name') or '').strip()
        if not sname or sname in seen_subjects:
            continue
        seen_subjects.add(sname)
        ref_key = f"elective:{st['id']}"
        color = meta.get(ref_key, {}).get('color') or 'geekblue'
        sids = sorted(subject_students.get(sname, set()))
        result.append({
            'id': ref_key,
            'ref_id': st['id'],
            'name': sname,
            'category': 'elective',
            'builtin': True,
            'color': color,
            'description': '系统内置选科/科目标签',
            'class_ids': [],
            'student_ids': sids,
            'class_count': 0,
            'student_count': len(sids),
        })

    # 3. Built-in custom role tags (e.g. 班主任)
    homeroom_class_ids = []
    homeroom_teacher_ids = set()
    for c in classes:
        teaching = c.get('teaching') or {}
        hr_uids = [uid for uid, info in teaching.items() if isinstance(info, dict) and info.get('homeroom') is True]
        if hr_uids:
            homeroom_class_ids.append(c['id'])
            homeroom_teacher_ids.update(hr_uids)
    hr_ref_key = 'role:homeroom'
    result.append({
        'id': hr_ref_key,
        'ref_id': 'homeroom',
        'name': '班主任',
        'category': 'custom',
        'builtin': True,
        'color': meta.get(hr_ref_key, {}).get('color') or 'gold',
        'description': '系统内置教师职务标签，担任班主任的教师自动拥有此标签',
        'class_ids': homeroom_class_ids,
        'student_ids': [],
        'class_count': len(homeroom_class_ids),
        'student_count': 0,
        'teacher_count': len(homeroom_teacher_ids),
    })

    # 4. Custom tags
    for tag in custom_tags:
        tname = tag['name']
        cids = [c['id'] for c in classes if tname in (c.get('tags') or [])]
        direct_sids = set(tag.get('student_ids') or [])
        inherited_sids = set()
        for cid in cids:
            inherited_sids.update(students_by_class.get(cid, []))
        # Also include students that have tag name in student.tags
        for s in students:
            if tname in (s.get('tags') or []):
                direct_sids.add(s['id'])
        all_sids = sorted(direct_sids | inherited_sids)
        result.append({
            'id': tag['id'],
            'ref_id': tag['id'],
            'name': tname,
            'category': 'custom',
            'builtin': False,
            'color': tag.get('color') or 'blue',
            'description': tag.get('description') or '',
            'class_ids': cids,
            'student_ids': all_sids,
            'direct_student_ids': sorted(direct_sids),
            'class_count': len(cids),
            'student_count': len(all_sids),
        })

    return result


def student_tag_index(db):
    """Build {student_id: [tag_label, ...]} and {tag_name: color} for fast lookup."""
    catalog = build_tag_catalog(db)
    by_student = {}
    colors = {}
    for tag in catalog:
        colors[tag['name']] = tag['color']
        for sid in tag['student_ids']:
            lst = by_student.setdefault(sid, [])
            if tag['name'] not in lst:
                lst.append(tag['name'])
    return catalog, by_student, colors


@router.get('/tags')
def list_tags(current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        return build_tag_catalog(db)


@router.get('/tags/student-map')
def get_student_tag_map(current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        catalog, by_student, colors = student_tag_index(db)
        return {
            'tags': [{k: t[k] for k in ('id', 'name', 'category', 'builtin', 'color', 'class_count', 'student_count')} for t in catalog],
            'by_student': by_student,
            'colors': colors,
        }


@router.post('/tags', status_code=201)
def create_tag(body: dict, current=Depends(admin)):
    name = clean_tag_name(body.get('name'))
    color = clean_color(body.get('color'), 'blue')
    description = str(body.get('description') or '').strip()[:200]
    class_ids = body.get('class_ids') or []
    student_ids = body.get('student_ids') or []
    if not isinstance(class_ids, list) or not isinstance(student_ids, list):
        raise HTTPException(422, '成员列表无效')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        ensure_synced_custom_tags(db, current['id'])
        if name == '班主任' or any(t['name'] == name for t in objects(db, 'tags')):
            raise HTTPException(409, '「班主任」为系统内置标签' if name == '班主任' else '已有同名标签')
        valid_sids = []
        for sid in dict.fromkeys(student_ids):
            require(db, sid, 'students')
            valid_sids.append(sid)
        tag = put(db, 'tags', {
            'name': name,
            'category': 'custom',
            'color': color,
            'description': description,
            'student_ids': valid_sids,
        }, current['id'])
        for cid in dict.fromkeys(class_ids):
            cls = require(db, cid, 'classes')
            tags = list(cls.get('tags') or [])
            if name not in tags:
                tags.append(name)
                cls['tags'] = tags
                put(db, 'classes', cls, current['id'])
        return tag


@router.put('/tags/{identifier}')
def update_tag(identifier: str, body: dict, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        # Handle built-in grade tag edit (rename grade + color)
        if identifier.startswith('grade:'):
            gid = identifier.split(':', 1)[1]
            grade = require(db, gid, 'grades')
            if 'name' in body:
                new_name = clean_tag_name(body['name'])
                if any(g['id'] != gid and g['name'] == new_name for g in objects(db, 'grades')):
                    raise HTTPException(409, '已有同名年级')
                if new_name != grade['name']:
                    grade['name'] = new_name
                    put(db, 'grades', grade, current['id'])
                    for cls in find(db, 'classes', grade_id=gid):
                        cls['grade'] = new_name
                        put(db, 'classes', cls, current['id'])
            if 'color' in body:
                _set_meta(db, identifier, clean_color(body['color'], GRADE_DEFAULT_COLORS.get(grade['name'], 'blue')), current['id'])
            return {'id': identifier, 'name': grade['name'], 'color': body.get('color')}

        # Handle built-in elective/subject tag edit (rename subject tag + color)
        if identifier.startswith('elective:'):
            stid = identifier.split(':', 1)[1]
            st = require(db, stid, 'subject-tags')
            if 'name' in body:
                new_name = clean_tag_name(body['name'])
                if any(t['id'] != stid and t['name'] == new_name for t in objects(db, 'subject-tags')):
                    raise HTTPException(409, '已有同名科目')
                old_name = st['name']
                if new_name != old_name:
                    st['name'] = new_name
                    put(db, 'subject-tags', st, current['id'])
                    for el in find(db, 'electives', subject=old_name):
                        put(db, 'electives', {**el, 'subject': new_name}, current['id'])
                    for cls in objects(db, 'classes'):
                        teaching = cls.get('teaching', {})
                        changed = False
                        for rel in teaching.values():
                            if old_name in rel.get('subjects', []):
                                rel['subjects'] = [new_name if s == old_name else s for s in rel['subjects']]
                                changed = True
                        if changed:
                            put(db, 'classes', cls, current['id'])
            if 'color' in body:
                _set_meta(db, identifier, clean_color(body['color'], 'geekblue'), current['id'])
            return {'id': identifier, 'name': st['name'], 'color': body.get('color')}

        # Handle built-in role tag edit (color only)
        if identifier == 'role:homeroom':
            color = clean_color(body.get('color'), 'gold')
            if 'color' in body:
                _set_meta(db, identifier, color, current['id'])
            return {'id': identifier, 'name': '班主任', 'color': color}

        # Handle custom tag edit
        tag = require(db, identifier, 'tags')
        old_name = tag['name']
        new_name = clean_tag_name(body['name']) if 'name' in body else old_name
        if new_name == '班主任':
            raise HTTPException(409, '「班主任」为系统内置标签')
        if new_name != old_name and any(t['id'] != identifier and t['name'] == new_name for t in objects(db, 'tags')):
            raise HTTPException(409, '已有同名标签')
        tag['name'] = new_name
        if 'color' in body:
            tag['color'] = clean_color(body['color'], tag.get('color') or 'blue')
        if 'description' in body:
            tag['description'] = str(body.get('description') or '').strip()[:200]
        if 'student_ids' in body:
            if not isinstance(body['student_ids'], list):
                raise HTTPException(422, '学生列表无效')
            sids = []
            for sid in dict.fromkeys(body['student_ids']):
                require(db, sid, 'students')
                sids.append(sid)
            tag['student_ids'] = sids
        put(db, 'tags', tag, current['id'])

        # Rename across classes and students if name changed
        if new_name != old_name:
            for cls in objects(db, 'classes'):
                ctags = cls.get('tags') or []
                if old_name in ctags:
                    cls['tags'] = list(dict.fromkeys(new_name if x == old_name else x for x in ctags))
                    put(db, 'classes', cls, current['id'])
            for stu in objects(db, 'students'):
                stags = stu.get('tags') or []
                if old_name in stags:
                    stu['tags'] = list(dict.fromkeys(new_name if x == old_name else x for x in stags))
                    put(db, 'students', stu, current['id'])

        # Sync class memberships if class_ids provided
        if 'class_ids' in body:
            if not isinstance(body['class_ids'], list):
                raise HTTPException(422, '班级列表无效')
            target_cids = set(body['class_ids'])
            for cid in target_cids:
                require(db, cid, 'classes')
            for cls in objects(db, 'classes'):
                ctags = list(cls.get('tags') or [])
                has_tag = new_name in ctags
                should_have = cls['id'] in target_cids
                if should_have and not has_tag:
                    ctags.append(new_name)
                    cls['tags'] = ctags
                    put(db, 'classes', cls, current['id'])
                elif not should_have and has_tag:
                    cls['tags'] = [x for x in ctags if x != new_name]
                    put(db, 'classes', cls, current['id'])

        return tag


@router.post('/students/batch-tags')
def batch_student_tags(body: dict, current=Depends(admin)):
    student_ids = body.get('student_ids')
    mode = body.get('mode', 'add')
    if not isinstance(student_ids, list) or not student_ids or any(not isinstance(i, str) for i in student_ids):
        raise HTTPException(422, '请选择至少一名学生')
    if mode not in ('replace', 'add', 'remove', 'clear'):
        raise HTTPException(422, '标签更新方式无效')
    from .school import clean_class_tags
    tags = [] if mode == 'clear' else clean_class_tags(body.get('tags', []))
    if mode in ('add', 'remove') and not tags:
        raise HTTPException(422, '请选择标签')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        existing_custom = ensure_synced_custom_tags(db, current['id'])
        if mode in ('replace', 'add'):
            for tname in tags:
                if tname not in existing_custom:
                    existing_custom[tname] = put(db, 'tags', {
                        'name': tname, 'category': 'custom', 'color': 'blue', 'description': '', 'student_ids': [],
                    }, current['id'])
        target_sids = list(dict.fromkeys(student_ids))
        for sid in target_sids:
            stu = require(db, sid, 'students')
            cur = list(stu.get('tags') or [])
            if mode == 'clear':
                stu['tags'] = []
            elif mode == 'replace':
                stu['tags'] = list(tags)
            elif mode == 'add':
                stu['tags'] = clean_class_tags([*cur, *tags])
            else:
                stu['tags'] = [t for t in cur if t not in tags]
            put(db, 'students', stu, current['id'])
        # Keep tag.student_ids in sync for custom tags
        for tname, tag_obj in existing_custom.items():
            cur_sids = set(tag_obj.get('student_ids') or [])
            changed = False
            for sid in target_sids:
                if mode == 'clear' or (mode == 'replace' and tname not in tags) or (mode == 'remove' and tname in tags):
                    if sid in cur_sids:
                        cur_sids.discard(sid)
                        changed = True
                elif (mode in ('add', 'replace') and tname in tags):
                    if sid not in cur_sids:
                        cur_sids.add(sid)
                        changed = True
            if changed:
                tag_obj['student_ids'] = sorted(cur_sids)
                put(db, 'tags', tag_obj, current['id'])
        return {'updated': len(target_sids), 'tags': tags}
