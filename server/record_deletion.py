"""Inspect references and remove unused or cascade-eligible school records while retaining audit history."""
from copy import deepcopy
import json
import re
from typing import Literal
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from .db import connect, get, objects, put
from .dependencies import admin, require
from .lifecycle import writable

router = APIRouter(prefix='/api/v1')
KINDS = Literal['room-tags', 'grades', 'classes', 'students', 'users', 'subject-tags', 'electives', 'tags']
KIND_LABELS = {
    'projects': '考试项目',
    'subjects': '科目',
    'groups': '题卡',
    'grades': '年级',
    'classes': '行政班',
    'students': '学生',
    'users': '教师账号',
    'subject-tags': '全校科目',
    'electives': '选科名单',
    'tags': '自定义标签',
    'rosters': '应考名单',
    'scan-batches': '扫描批次',
    'submissions': '答卷',
    'result-snapshots': '已发布成绩快照',
    'assignments': '阅卷分工',
    'tasks': '阅卷任务',
    'room-tags': '考场',
    'templates': '题卡版式',
}
IGNORED_KINDS = {'account-events', 'passkey', 'auth-challenge', 'recovery-code', 'tag-meta'}


class DeletePreviewRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    mode: Literal['cascade', 'unlink'] = 'unlink'


class DeleteExecuteRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    cascade: bool = False
    mode: Literal['cascade', 'unlink'] = 'cascade'
    force: bool = False


def _find_referenced_ids(value, id_set):
    found = set()
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            if current in id_set:
                found.add(current)
        elif isinstance(current, list):
            stack.extend(current)
        elif isinstance(current, dict):
            for k, v in current.items():
                if k in id_set:
                    found.add(k)
                stack.append(v)
    return found


def _context_maps(db):
    projects = {p['id']: p for p in objects(db, 'projects')}
    subjects = {s['id']: s for s in objects(db, 'subjects')}
    groups = {g['id']: g for g in objects(db, 'groups')}
    templates = {t['id']: t for t in objects(db, 'templates')}
    grades = {g['id']: g for g in objects(db, 'grades')}
    classes = {c['id']: c for c in objects(db, 'classes')}
    return {'projects': projects, 'subjects': subjects, 'groups': groups, 'templates': templates, 'grades': grades, 'classes': classes}


def _card_path(ctx, group):
    if not group:
        return '未知题卡'
    subject = ctx['subjects'].get(group.get('subject_id')) or {}
    project = ctx['projects'].get(subject.get('project_id')) or {}
    grade = ctx['grades'].get(group.get('grade_id')) or {}
    parts = [project.get('name'), subject.get('name'), grade.get('name'), group.get('name')]
    return ' / '.join(p for p in parts if p) or group.get('id', '题卡')


def _describe_object(ctx, okind, obj):
    oid = obj.get('id', '')
    if okind == 'grades':
        return obj.get('name') or oid
    if okind == 'classes':
        grade = ctx['grades'].get(obj.get('grade_id'), {}).get('name') or obj.get('grade')
        return ' · '.join(p for p in (grade, obj.get('name')) if p) or oid
    if okind == 'students':
        cls = ctx['classes'].get(obj.get('class_id'))
        cls_label = _describe_object(ctx, 'classes', cls) if cls else ''
        cand = obj.get('candidate_number')
        base = f"{obj.get('name', oid)}（{cand}）" if cand else obj.get('name', oid)
        return f"{base} · {cls_label}" if cls_label else base
    if okind == 'electives':
        grade = ctx['grades'].get(obj.get('grade_id'), {}).get('name') or ''
        return ' · '.join(p for p in (grade, obj.get('subject')) if p) or oid
    if okind == 'subjects':
        project = ctx['projects'].get(obj.get('project_id'), {}).get('name') or ''
        return ' / '.join(p for p in (project, obj.get('name')) if p) or oid
    if okind == 'groups':
        return _card_path(ctx, obj)
    if okind == 'rosters':
        group = ctx['groups'].get(obj.get('group_id'))
        return _card_path(ctx, group)
    if okind == 'assignments':
        template = ctx['templates'].get(obj.get('template_id')) or {}
        group = ctx['groups'].get(template.get('group_id'))
        return _card_path(ctx, group)
    if okind == 'scan-batches':
        group = ctx['groups'].get(obj.get('group_id'))
        room = obj.get('room')
        base = _card_path(ctx, group)
        return f"{base}（考场 {room}）" if room else base
    if okind == 'submissions':
        group = ctx['groups'].get(obj.get('group_id'))
        cand = obj.get('candidate_number')
        base = _card_path(ctx, group)
        return f"{base}（考号 {cand}）" if cand else base
    if okind == 'result-snapshots':
        group = ctx['groups'].get(obj.get('group_id'))
        return _card_path(ctx, group)
    if okind == 'tasks':
        template = ctx['templates'].get(obj.get('template_id')) or {}
        group = ctx['groups'].get(template.get('group_id'))
        return _card_path(ctx, group)
    if okind == 'room-tags':
        project = ctx['projects'].get(obj.get('project_id'), {}).get('name') or ''
        return ' / '.join(p for p in (project, obj.get('name')) if p) or oid
    return obj.get('name') or obj.get('subject') or oid


def _apply_unlink_to_copy(okind, obj, unlink_spec):
    updated = deepcopy(obj)
    if okind == 'classes':
        remove_teachers = unlink_spec.get('teachers', set())
        remove_subjects = unlink_spec.get('subjects', set())
        remove_tags = unlink_spec.get('tags', set())
        if unlink_spec.get('clear_grade'):
            updated['grade_id'] = None
            updated['grade'] = ''
        if remove_tags:
            updated['tags'] = [t for t in updated.get('tags', []) if t not in remove_tags]
        if remove_teachers:
            updated['teacher_ids'] = [uid for uid in updated.get('teacher_ids', []) if uid not in remove_teachers]
            teaching = dict(updated.get('teaching') or {})
            for uid in remove_teachers:
                teaching.pop(uid, None)
            updated['teaching'] = teaching
        if remove_subjects:
            teaching = dict(updated.get('teaching') or {})
            keep_ids = set(updated.get('teacher_ids', []))
            for uid in list(teaching.keys()):
                role = dict(teaching[uid] or {})
                subs = [s for s in role.get('subjects', []) if s not in remove_subjects]
                role['subjects'] = subs
                if not subs and not role.get('homeroom'):
                    teaching.pop(uid, None)
                    keep_ids.discard(uid)
                else:
                    teaching[uid] = role
            updated['teaching'] = teaching
            updated['teacher_ids'] = sorted(keep_ids)
    elif okind == 'students':
        remove_tags = unlink_spec.get('tags', set())
        if remove_tags:
            updated['tags'] = [t for t in updated.get('tags', []) if t not in remove_tags]
        if unlink_spec.get('clear_class'):
            updated['class_id'] = ''
    elif okind == 'tags':
        remove_students = unlink_spec.get('students', set())
        if remove_students:
            updated['student_ids'] = [sid for sid in updated.get('student_ids', []) if sid not in remove_students]
    elif okind == 'electives':
        remove_students = unlink_spec.get('students', set())
        if remove_students:
            updated['student_ids'] = [sid for sid in updated.get('student_ids', []) if sid not in remove_students]
    elif okind == 'assignments':
        remove_teachers = unlink_spec.get('teachers', set())
        if remove_teachers:
            updated['user_ids'] = [uid for uid in updated.get('user_ids', []) if uid not in remove_teachers]
            updated['arbitrator_ids'] = [uid for uid in updated.get('arbitrator_ids', []) if uid not in remove_teachers]
    elif okind == 'rosters':
        remove_students = unlink_spec.get('students', set())
        if remove_students:
            updated['student_ids'] = [sid for sid in updated.get('student_ids', []) if sid not in remove_students]
            updated['students'] = [s for s in updated.get('students', []) if s.get('id') not in remove_students]
            updated['supplemental_ids'] = [sid for sid in updated.get('supplemental_ids', []) if sid not in remove_students]
    return updated


def plan_deletion(db, kind: KINDS, raw_ids: list[str], mode: Literal['cascade', 'unlink'] = 'cascade'):
    ids = list(dict.fromkeys(i for i in raw_ids if isinstance(i, str) and i.strip()))
    if not ids:
        raise HTTPException(422, '请选择至少一条记录')

    ctx = _context_maps(db)
    targets = []
    blockers = []
    blocker_keys = set()

    def add_blocker(item_kind, item_id, name, reason):
        key = (item_kind, item_id, reason)
        if key in blocker_keys:
            return
        blocker_keys.add(key)
        blockers.append({
            'kind': item_kind,
            'kind_label': KIND_LABELS.get(item_kind, item_kind),
            'id': item_id,
            'name': name,
            'reason': reason,
        })

    target_rows = {}
    for identifier in ids:
        if kind == 'users':
            row = db.execute('SELECT id, name, username, role FROM users WHERE id=?', (identifier,)).fetchone()
            if not row:
                raise HTTPException(404, '账号不存在')
            row_dict = dict(row)
            label = f"{row_dict['name']}（{row_dict['username']}）"
            target_rows[identifier] = row_dict
            targets.append({'kind': kind, 'kind_label': KIND_LABELS[kind], 'id': identifier, 'name': label})
            if row_dict['role'] != 'teacher':
                add_blocker('users', identifier, label, '只可删除普通教师账号')
            else:
                for table, text in (
                    ('scores', '教师已产生评分记录，不可删除'),
                    ('review_allocations', '教师已存在阅卷分配记录，不可删除'),
                    ('regrade_queue', '教师存在重阅记录，不可删除'),
                ):
                    if db.execute(f'SELECT 1 FROM {table} WHERE user_id=? LIMIT 1', (identifier,)).fetchone():
                        add_blocker('users', identifier, label, text)
                        break
        else:
            row_dict = require(db, identifier, kind)
            writable(db, kind, row_dict)
            target_rows[identifier] = row_dict
            targets.append({
                'kind': kind,
                'kind_label': KIND_LABELS.get(kind, kind),
                'id': identifier,
                'name': _describe_object(ctx, kind, row_dict),
            })

    all_classes = list(ctx['classes'].values())
    all_students = objects(db, 'students')
    all_electives = objects(db, 'electives')
    all_assignments = objects(db, 'assignments')
    all_rosters = objects(db, 'rosters')
    all_groups = list(ctx['groups'].values())
    all_subjects = list(ctx['subjects'].values())

    cascade_delete_map: dict[str, tuple[str, dict]] = {}
    unlink_specs: dict[str, tuple[str, dict, dict, list[str]]] = {}

    def mark_cascade_delete(item_kind, obj):
        oid = obj['id']
        if oid in target_rows or oid in cascade_delete_map:
            return
        cascade_delete_map[oid] = (item_kind, obj)

    def mark_unlink(item_kind, obj, key, values, action_text):
        oid = obj['id']
        if oid in target_rows or oid in cascade_delete_map:
            return
        entry = unlink_specs.setdefault(oid, (item_kind, obj, {}, []))
        bucket = entry[2].setdefault(key, set())
        bucket.update(values)
        if action_text not in entry[3]:
            entry[3].append(action_text)

    delete_class_ids = set(ids) if kind == 'classes' else set()
    delete_student_ids = set(ids) if kind == 'students' else set()
    delete_elective_ids = set(ids) if kind == 'electives' else set()
    delete_teacher_ids = {uid for uid in ids if kind == 'users' and target_rows[uid].get('role') == 'teacher'}

    if kind == 'grades':
        grade_set = set(ids)
        if mode == 'unlink':
            for cls in all_classes:
                if cls.get('grade_id') in grade_set:
                    mark_unlink('classes', cls, 'clear_grade', {True}, '解除所属年级关联（保留班级与学生）')
            for ele in all_electives:
                if ele.get('grade_id') in grade_set:
                    mark_cascade_delete('electives', ele)
                    delete_elective_ids.add(ele['id'])
        else:
            for cls in all_classes:
                if cls.get('grade_id') in grade_set:
                    mark_cascade_delete('classes', cls)
                    delete_class_ids.add(cls['id'])
            for stu in all_students:
                if stu.get('class_id') in delete_class_ids:
                    mark_cascade_delete('students', stu)
                    delete_student_ids.add(stu['id'])
            for ele in all_electives:
                if ele.get('grade_id') in grade_set:
                    mark_cascade_delete('electives', ele)
                    delete_elective_ids.add(ele['id'])
    elif kind == 'classes':
        if mode == 'unlink':
            for stu in all_students:
                if stu.get('class_id') in delete_class_ids:
                    mark_unlink('students', stu, 'clear_class', {True}, '解除行政班关联（保留学生资料）')
        else:
            for stu in all_students:
                if stu.get('class_id') in delete_class_ids:
                    mark_cascade_delete('students', stu)
                    delete_student_ids.add(stu['id'])
    elif kind == 'tags':
        tag_names = {row['name'] for row in target_rows.values()}
        direct_sids = {sid for row in target_rows.values() for sid in (row.get('student_ids') or [])}
        if mode == 'unlink':
            for cls in all_classes:
                hit = tag_names & set(cls.get('tags') or [])
                if hit:
                    mark_unlink('classes', cls, 'tags', hit, f"从班级移除标签（{'、'.join(sorted(hit))}）")
            for stu in all_students:
                hit = tag_names & set(stu.get('tags') or [])
                if hit:
                    mark_unlink('students', stu, 'tags', hit, f"从学生移除标签（{'、'.join(sorted(hit))}）")
        else:
            for cls in all_classes:
                if tag_names & set(cls.get('tags') or []):
                    mark_cascade_delete('classes', cls)
                    delete_class_ids.add(cls['id'])
            for stu in all_students:
                if (
                    stu['id'] in direct_sids
                    or (tag_names & set(stu.get('tags') or []))
                    or stu.get('class_id') in delete_class_ids
                ):
                    mark_cascade_delete('students', stu)
                    delete_student_ids.add(stu['id'])
    elif kind == 'subject-tags':
        tag_names = {row['name'] for row in target_rows.values()}
        tag_ids = set(ids)
        for ele in all_electives:
            if ele.get('subject') in tag_names:
                mark_cascade_delete('electives', ele)
                delete_elective_ids.add(ele['id'])
        for cls in all_classes:
            matched = {
                s
                for role in (cls.get('teaching') or {}).values()
                for s in (role.get('subjects') or [])
                if s in tag_names
            }
            if matched:
                mark_unlink('classes', cls, 'subjects', matched, f"移除任教学科（{'、'.join(sorted(matched))}）")
        for sub in all_subjects:
            if sub.get('subject_tag_id') in tag_ids or (not sub.get('subject_tag_id') and sub.get('name') in tag_names):
                add_blocker('subjects', sub['id'], _describe_object(ctx, 'subjects', sub), '该科目已用于考试项目，需先处理对应考试')

    if delete_teacher_ids:
        for cls in all_classes:
            hit = delete_teacher_ids & (set(cls.get('teacher_ids', [])) | set((cls.get('teaching') or {}).keys()))
            if hit:
                mark_unlink('classes', cls, 'teachers', hit, '解除行政班任教关系')
        for assign in all_assignments:
            hit = delete_teacher_ids & (set(assign.get('user_ids', [])) | set(assign.get('arbitrator_ids', [])))
            if hit:
                template = ctx['templates'].get(assign.get('template_id')) or {}
                group = ctx['groups'].get(template.get('group_id'))
                if group and group.get('frozen'):
                    add_blocker('assignments', assign['id'], _describe_object(ctx, 'assignments', assign), '已发布题卡的阅卷分工，不可修改')
                else:
                    mark_unlink('assignments', assign, 'teachers', hit, '移出未发布题卡的阅卷池/仲裁池')

    if delete_elective_ids:
        from .electives import card_catalog
        for group in all_groups:
            if not group.get('grade_id'):
                continue
            try:
                cat = card_catalog(db, group)
            except HTTPException:
                cat = None
            if cat and cat.get('id') in delete_elective_ids:
                add_blocker('groups', group['id'], _describe_object(ctx, 'groups', group), '选科名单已绑定到考试题卡，需先处理对应题卡')

    if delete_student_ids:
        student_grade_ids = set()
        for sid in delete_student_ids:
            stu = target_rows.get(sid) if kind == 'students' else cascade_delete_map.get(sid, (None, None))[1]
            if stu:
                cls = ctx['classes'].get(stu.get('class_id'))
                if cls and cls.get('grade_id'):
                    student_grade_ids.add(cls['grade_id'])
        for group in all_groups:
            if group.get('grade_id') in student_grade_ids and group.get('roster_mode') == 'grade':
                add_blocker('groups', group['id'], _describe_object(ctx, 'groups', group), '学生已纳入该题卡的年级全体应考名单')
        for tag_obj in objects(db, 'tags'):
            if tag_obj['id'] in target_rows or tag_obj['id'] in cascade_delete_map:
                continue
            hit = delete_student_ids & set(tag_obj.get('student_ids') or [])
            if hit:
                mark_unlink('tags', tag_obj, 'students', hit, f'从自定义标签移出 {len(hit)} 名学生')
        for ele in all_electives:
            if ele['id'] in delete_elective_ids:
                continue
            hit = delete_student_ids & set(ele.get('student_ids', []))
            if hit:
                mark_unlink('electives', ele, 'students', hit, f'从选科名单移出 {len(hit)} 名学生')
        for roster in all_rosters:
            roster_sids = set(roster.get('student_ids', [])) | {s.get('id') for s in roster.get('students', []) if s.get('id')}
            hit = delete_student_ids & roster_sids
            if hit:
                group = ctx['groups'].get(roster.get('group_id'))
                if group and group.get('frozen'):
                    add_blocker('rosters', roster['id'], _describe_object(ctx, 'rosters', roster), '已发布题卡的应考名单，不可修改')
                else:
                    mark_unlink('rosters', roster, 'students', hit, f'从未发布题卡指定名单移出 {len(hit)} 名学生')

    all_deleted_ids = set(ids) | set(cascade_delete_map.keys())
    pattern = re.compile('|'.join(re.escape(i) for i in all_deleted_ids))
    rows = db.execute("SELECT id, kind, body FROM objects WHERE deleted=0").fetchall()
    for oid, okind, body_text in rows:
        if oid in all_deleted_ids or okind in IGNORED_KINDS:
            continue
        if not pattern.search(body_text):
            continue
        obj = json.loads(body_text)
        if oid in unlink_specs:
            _, _, spec, _ = unlink_specs[oid]
            simulated = _apply_unlink_to_copy(okind, obj, spec)
            remaining = _find_referenced_ids(simulated, all_deleted_ids)
        else:
            remaining = _find_referenced_ids(obj, all_deleted_ids)
        if remaining:
            add_blocker(
                okind,
                oid,
                _describe_object(ctx, okind, obj),
                f"仍被{KIND_LABELS.get(okind, okind)}引用，需先处理对应考试业务记录",
            )

    cascade_deletes = [
        {
            'kind': item_kind,
            'kind_label': KIND_LABELS.get(item_kind, item_kind),
            'id': oid,
            'name': _describe_object(ctx, item_kind, obj),
        }
        for oid, (item_kind, obj) in cascade_delete_map.items()
    ]
    cascade_unlinks = [
        {
            'kind': item_kind,
            'kind_label': KIND_LABELS.get(item_kind, item_kind),
            'id': oid,
            'name': _describe_object(ctx, item_kind, obj),
            'action': '；'.join(actions),
        }
        for oid, (item_kind, obj, _, actions) in unlink_specs.items()
    ]
    return {
        'kind': kind,
        'kind_label': KIND_LABELS.get(kind, kind),
        'targets': targets,
        'target_rows': target_rows,
        'cascade_deletes': cascade_deletes,
        'cascade_delete_map': cascade_delete_map,
        'cascade_unlinks': cascade_unlinks,
        'unlink_specs': unlink_specs,
        'blockers': blockers,
        'can_delete': len(blockers) == 0,
        'requires_cascade': len(blockers) == 0 and (len(cascade_deletes) > 0 or len(cascade_unlinks) > 0),
    }


def _execute_plan(db, plan, current, cascade: bool, force: bool = False):
    if plan['blockers'] and not force:
        summary = '；'.join(f"{b['kind_label']}「{b['name']}」（{b['reason']}）" for b in plan['blockers'][:5])
        raise HTTPException(409, f'存在受保护的引用，无法删除：{summary}')
    if plan['requires_cascade'] and not cascade and not force:
        refs = sorted({item['kind_label'] for item in [*plan['cascade_deletes'], *plan['cascade_unlinks']]})
        raise HTTPException(409, '记录已被引用：' + '、'.join(refs))

    actor = current['id']
    # 1. Apply unlinks on remaining records
    for oid, (okind, obj, spec, _) in plan['unlink_specs'].items():
        updated = _apply_unlink_to_copy(okind, obj, spec)
        put(db, okind, updated, actor)
        if okind == 'rosters' and updated.get('group_id'):
            group = get(db, updated['group_id'], 'groups')
            if group and not group.get('frozen'):
                group['expected_students'] = len(updated.get('student_ids', []))
                put(db, 'groups', group, actor)

    # 2. Delete cascaded objects first, then targets
    def remove_one(item_kind, oid, row):
        if item_kind == 'users':
            db.execute(
                "UPDATE objects SET deleted=1 WHERE kind IN ('passkey','auth-challenge','recovery-code','teacher-profiles') AND (id=? OR json_extract(body,'$.user_id')=?)",
                (oid, oid),
            )
            if force:
                db.execute("UPDATE objects SET deleted=1 WHERE kind='tasks' AND json_extract(body,'$.user_id')=?", (oid,))
                for tbl in ('review_allocations', 'regrade_queue'):
                    try:
                        db.execute(f'DELETE FROM {tbl} WHERE user_id=?', (oid,))
                    except Exception:
                        pass
                for asgn in objects(db, 'assignments'):
                    uids = asgn.get('user_ids') or []
                    aids = asgn.get('arbitrator_ids') or []
                    if oid in uids or oid in aids:
                        asgn['user_ids'] = [u for u in uids if u != oid]
                        asgn['arbitrator_ids'] = [u for u in aids if u != oid]
                        put(db, 'assignments', asgn, actor)
                for cls in objects(db, 'classes'):
                    teaching = dict(cls.get('teaching') or {})
                    tids = list(cls.get('teacher_ids') or [])
                    if oid in teaching or oid in tids:
                        teaching.pop(oid, None)
                        cls['teaching'] = teaching
                        cls['teacher_ids'] = [u for u in tids if u != oid]
                        put(db, 'classes', cls, actor)
            db.execute('DELETE FROM sessions WHERE user_id=?', (oid,))
            db.execute('DELETE FROM users WHERE id=?', (oid,))
            audit_name = row.get('name', oid)
        else:
            db.execute('UPDATE objects SET deleted=1 WHERE id=?', (oid,))
            audit_name = row.get('subject') if item_kind == 'electives' else row.get('name', oid)
        db.execute(
            'INSERT INTO audit(id,actor,action,object_id,body) VALUES(?,?,?,?,?)',
            (str(uuid4()), actor, 'delete', oid, json.dumps({'kind': item_kind, 'name': audit_name, 'cascade': cascade, 'force': force}, ensure_ascii=False)),
        )

    for oid, (item_kind, obj) in plan['cascade_delete_map'].items():
        remove_one(item_kind, oid, obj)
    for target in plan['targets']:
        remove_one(plan['kind'], target['id'], plan['target_rows'][target['id']])

    return {
        'deleted': len(plan['targets']),
        'cascaded_deletes': len(plan['cascade_deletes']),
        'cascaded_unlinks': len(plan['cascade_unlinks']),
        'forced': force,
    }


def _public_plan(plan):
    return {
        'kind': plan['kind'],
        'kind_label': plan['kind_label'],
        'targets': plan['targets'],
        'cascade_deletes': plan['cascade_deletes'],
        'cascade_unlinks': plan['cascade_unlinks'],
        'blockers': plan['blockers'],
        'can_delete': plan['can_delete'],
        'requires_cascade': plan['requires_cascade'],
    }


@router.post('/records/{kind}/delete-preview')
def preview_delete_records(kind: KINDS, body: DeletePreviewRequest, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN')
        plan = plan_deletion(db, kind, body.ids, mode=body.mode)
        return {**_public_plan(plan), 'mode': body.mode}


@router.post('/records/{kind}/delete')
def batch_delete_records(kind: KINDS, body: DeleteExecuteRequest, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        plan = plan_deletion(db, kind, body.ids, mode=body.mode)
        return _execute_plan(db, plan, current, cascade=body.cascade or body.mode == 'unlink', force=body.force)


@router.delete('/records/{kind}/{identifier}')
def delete_record(kind: KINDS, identifier: str, cascade: bool = Query(False), mode: Literal['cascade', 'unlink'] = Query('cascade'), force: bool = Query(False), current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        plan = plan_deletion(db, kind, [identifier], mode=mode)
        _execute_plan(db, plan, current, cascade=cascade or mode == 'unlink', force=force)
        return {'deleted': True, 'forced': force}
