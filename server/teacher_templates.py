"""Teacher-authored independent templates with internal share links and admin review/adoption."""
from copy import deepcopy
import re
import secrets
import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from . import paper
from .db import connect, get, objects, put
from .dependencies import admin, require, user
from .identifiers import prepare_questions
from .lifecycle import RESULTS_REVIEW_GUIDE
from .sheet_style import defaults as apply_sheet_defaults
from .template_checks import asset_ids, issues
from .templates import DEFINITION_FIELDS, default_group

router = APIRouter(prefix='/api/v1')


def _default_definition(name: str) -> dict:
    definition = {
        'id': str(uuid4()),
        'name': name,
        'subtitle': '',
        'font_size': 13,
        'leading': 20,
        'paper': 'A4',
        'sides': 2,
        'layout_version': 3,
        'sheet_columns': 1,
        'notice_template': 'standard-v1',
        'notice_layout': 2,
        'column_frame': True,
        'uniform_subjective': True,
        'auto_subjective_layout': True,
        'print_style': 'standard-v2',
        'forbidden_regions': [],
        'candidate_length': 9,
        'revision': 0,
        'questions': [],
    }
    apply_sheet_defaults(definition)
    prepare_questions(definition)
    return definition


def _clean_definition(definition: dict, fallback_name: str) -> dict:
    if not isinstance(definition, dict):
        raise HTTPException(422, '题卡配置无效')
    name = str(definition.get('name', fallback_name) or fallback_name).strip()
    if not 1 <= len(name) <= 100:
        raise HTTPException(422, '请填写100字以内题卡标题')
    if definition.get('paper', 'A4') not in ('A3', 'A4') or definition.get('sides', 2) not in (1, 2):
        raise HTTPException(422, '纸型或面数无效')
    clean = {k: deepcopy(definition[k]) for k in DEFINITION_FIELDS if k in definition}
    clean['name'] = name
    clean.setdefault('paper', 'A4')
    clean.setdefault('sides', 2)
    clean.setdefault('candidate_length', 9)
    clean.setdefault('layout_version', 3)
    clean.setdefault('sheet_columns', 2 if clean['paper'] == 'A3' else 1)
    clean.setdefault('notice_template', 'standard-v1')
    clean.setdefault('notice_layout', 2)
    clean.setdefault('column_frame', True)
    clean.setdefault('uniform_subjective', True)
    clean.setdefault('auto_subjective_layout', True)
    clean.setdefault('print_style', 'standard-v2')
    clean.setdefault('forbidden_regions', [])
    clean.setdefault('questions', [])
    apply_sheet_defaults(clean)
    prepare_questions(clean)
    return clean


def _extract_token(raw: str) -> str:
    text = (raw or '').strip()
    if not text:
        return ''
    if text.lower().startswith('omp-tpl:'):
        return text.split(':', 1)[1].strip()
    if 'import_template=' in text or 'share_token=' in text or '://' in text or text.startswith('#'):
        parsed = urlsplit(text)
        for source in (parsed.query, parsed.fragment.split('?', 1)[1] if '?' in parsed.fragment else ''):
            if not source:
                continue
            qs = parse_qs(source)
            for key in ('import_template', 'share_token', 'token'):
                if qs.get(key):
                    return qs[key][0].strip()
    m = re.search(r'(?:import_template|share_token)=([A-Za-z0-9_-]+)', text)
    if m:
        return m.group(1)
    return text


def _serialize(row: dict) -> dict:
    definition = row.get('definition') or {}
    questions = definition.get('questions') or []
    return {
        **row,
        'internal_link': f"omp-tpl:{row['share_token']}",
        'question_count': len(questions),
        'total_points': round(sum(float(q.get('points') or 0) for q in questions), 2),
    }


def _check_read_access(row: dict, current: dict):
    if current['role'] in ('admin', 'manager'):
        return
    if row.get('owner_id') != current['id']:
        raise HTTPException(403, '无权访问他人的独立题卡')


@router.get('/teacher-templates')
def list_teacher_templates(status: str = '', current=Depends(user)):
    with connect() as db:
        rows = objects(db, 'teacher-templates')
        if current['role'] not in ('admin', 'manager'):
            rows = [r for r in rows if r.get('owner_id') == current['id']]
        if status and status != 'all':
            rows = [r for r in rows if r.get('status') == status]
        rows.sort(key=lambda r: r.get('updated_at') or r.get('created_at') or 0, reverse=True)
        return [_serialize(r) for r in rows]


@router.get('/teacher-templates/notifications')
def template_notifications(current=Depends(user)):
    with connect() as db:
        rows = objects(db, 'teacher-templates')
    items = []
    is_admin = current['role'] in ('admin', 'manager')
    for r in rows:
        if r.get('owner_id') == current['id'] and r.get('assigned_by') and r.get('status') in ('draft', 'rejected'):
            scope = ' · '.join(v for v in (r.get('target_project_name'), r.get('target_subject_name'), r.get('target_grade_name'), r.get('target_group_name')) if v)
            detail = r.get('review_note') if r.get('status') == 'rejected' else (r.get('description') or f"管理员 {r.get('assigned_by_name', '')} 已下发制卡任务，完成后可保存并推送给管理员。")
            items.append({
                'id': r['id'],
                'kind': 'assigned_template',
                'status': r['status'],
                'title': f"制卡任务：{r.get('name', '未命名题卡')}",
                'scope': scope,
                'detail': detail,
                'created_at': r.get('updated_at') or r.get('assigned_at') or r.get('created_at'),
                'href': f"#/teacher-templates/{r['id']}",
                'action_label': '一键进入制卡',
            })
        elif is_admin and r.get('status') == 'submitted':
            scope = ' · '.join(v for v in (r.get('target_project_name'), r.get('target_subject_name') or r.get('subject_name'), r.get('target_grade_name')) if v)
            items.append({
                'id': r['id'],
                'kind': 'submitted_template',
                'status': 'submitted',
                'title': f"教师推送题卡：{r.get('name', '未命名题卡')}",
                'scope': scope or f"制作教师：{r.get('owner_name', '')}",
                'detail': f"{r.get('owner_name', '教师')} 已推送题卡待审核，可编辑所有内容（含答案）后采用。",
                'created_at': r.get('submitted_at') or r.get('updated_at') or r.get('created_at'),
                'href': f"#/teacher-templates/{r['id']}",
                'action_label': '一键进入审核',
            })
    items.sort(key=lambda item: item.get('created_at') or 0, reverse=True)
    return items


@router.post('/teacher-templates/assign', status_code=201)
def assign_teacher_template(body: dict, current=Depends(admin)):
    teacher_id = body.get('teacher_id')
    group_id = body.get('group_id')
    description = str(body.get('description') or '').strip()
    if not isinstance(teacher_id, str) or not teacher_id:
        raise HTTPException(422, '请选择接收制卡任务的教师账号')
    if not isinstance(group_id, str) or not group_id:
        raise HTTPException(422, '请选择要制卡的考试题卡')
    if len(description) > 2000:
        raise HTTPException(422, '任务说明不能超过2000字')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        teacher = db.execute('SELECT id, username, name, role FROM users WHERE id=?', (teacher_id,)).fetchone()
        if not teacher:
            raise HTTPException(404, '教师账号不存在')
        group = require(db, group_id, 'groups')
        if group.get('frozen'):
            raise HTTPException(409, RESULTS_REVIEW_GUIDE)
        subject = require(db, group['subject_id'], 'subjects')
        project = require(db, subject['project_id'], 'projects')
        grade = get(db, group.get('grade_id'), 'grades') if group.get('grade_id') else None
        grade_name = grade['name'] if grade else ''
        card_label = f"{subject['name']}题卡" if (group.get('is_default') or group.get('name') == 'Default') else group['name']
        default_title = ' · '.join(v for v in (project['name'], grade_name, subject['name'], card_label) if v)[:100]
        name = str(body.get('name') or default_title).strip()[:100] or default_title
        existing_tpl = get(db, group.get('template_id'), 'templates') if group.get('template_id') else None
        if existing_tpl:
            definition = _clean_definition(existing_tpl, name)
            for q in definition.get('questions', []):
                q.pop('id', None)
            prepare_questions(definition)
        else:
            definition = _default_definition(name)
        now = time.time()
        record = {
            'id': str(uuid4()),
            'owner_id': teacher['id'],
            'owner_name': teacher['name'],
            'owner_username': teacher['username'],
            'assigned_by': current['id'],
            'assigned_by_name': current['name'],
            'assigned_at': now,
            'target_group_id': group['id'],
            'target_project_id': project['id'],
            'target_project_name': project['name'],
            'target_subject_name': subject['name'],
            'target_grade_name': grade_name,
            'target_group_name': card_label,
            'name': definition['name'],
            'subject_name': subject['name'],
            'description': description,
            'status': 'draft',
            'share_token': secrets.token_urlsafe(12),
            'review_note': '',
            'submitted_at': None,
            'created_at': now,
            'updated_at': now,
            'adopted_template_id': None,
            'adopted_group_id': None,
            'definition': definition,
        }
        return _serialize(put(db, 'teacher-templates', record, current['id']))


@router.get('/teacher-templates/by-link')
def lookup_by_link(link: str = Query(..., min_length=1, max_length=500), current=Depends(admin)):
    token = _extract_token(link)
    if not token:
        raise HTTPException(422, '内部链接或提取码不能为空')
    with connect() as db:
        rows = objects(db, 'teacher-templates')
        match = next((r for r in rows if r.get('share_token') == token or r.get('id') == token), None)
        if not match:
            raise HTTPException(404, '未找到对应的教师独立题卡，请核对内部链接是否正确')
        return _serialize(match)


@router.get('/teacher-templates/{identifier}')
def get_teacher_template(identifier: str, current=Depends(user)):
    with connect() as db:
        row = require(db, identifier, 'teacher-templates')
        _check_read_access(row, current)
        return _serialize(row)


@router.post('/teacher-templates', status_code=201)
def create_teacher_template(body: dict, current=Depends(user)):
    name = str(body.get('name', '未命名题卡') or '未命名题卡').strip()
    subject_name = str(body.get('subject_name', '') or '').strip()
    description = str(body.get('description', '') or '').strip()
    if not 1 <= len(name) <= 100 or len(subject_name) > 40 or len(description) > 2000:
        raise HTTPException(422, '请填写100字以内的题卡标题与有效说明')
    raw_def = body.get('definition')
    definition = _clean_definition(raw_def, name) if isinstance(raw_def, dict) else _default_definition(name)
    now = time.time()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            for aid in asset_ids(definition):
                require(db, aid, 'assets')
        except (ValueError, KeyError, TypeError) as err:
            raise HTTPException(422, str(err))
        record = {
            'id': str(uuid4()),
            'owner_id': current['id'],
            'owner_name': current['name'],
            'owner_username': current['username'],
            'name': definition['name'],
            'subject_name': subject_name,
            'description': description,
            'status': 'draft',
            'share_token': secrets.token_urlsafe(12),
            'review_note': '',
            'submitted_at': None,
            'created_at': now,
            'updated_at': now,
            'adopted_template_id': None,
            'adopted_group_id': None,
            'definition': definition,
        }
        return _serialize(put(db, 'teacher-templates', record, current['id']))


@router.put('/teacher-templates/{identifier}')
def update_teacher_template(identifier: str, body: dict, current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = require(db, identifier, 'teacher-templates')
        is_admin = current['role'] in ('admin', 'manager')
        if not is_admin:
            if row.get('owner_id') != current['id']:
                raise HTTPException(403, '无权修改他人的独立题卡')
            if row.get('status') not in ('draft', 'rejected'):
                raise HTTPException(409, '题卡已提交审核或已采用，如需修改请联系管理员或退回后再改')

        updated = dict(row)
        if 'subject_name' in body:
            subject_name = str(body.get('subject_name') or '').strip()
            if len(subject_name) > 40:
                raise HTTPException(422, '学科名称过长')
            updated['subject_name'] = subject_name
        if 'description' in body:
            description = str(body.get('description') or '').strip()
            if len(description) > 2000:
                raise HTTPException(422, '说明不能超过2000字')
            updated['description'] = description

        raw_def = body.get('definition')
        if isinstance(raw_def, dict):
            fallback = str(body.get('name') or row.get('name') or '未命名题卡')
            clean = _clean_definition(raw_def, fallback)
            try:
                for aid in asset_ids(clean):
                    require(db, aid, 'assets')
            except (ValueError, KeyError, TypeError) as err:
                raise HTTPException(422, str(err))
            updated['definition'] = clean
            updated['name'] = clean['name']
        elif 'name' in body:
            name = str(body.get('name') or '').strip()
            if not 1 <= len(name) <= 100:
                raise HTTPException(422, '请填写100字以内的题卡标题')
            updated['name'] = name
            updated['definition'] = {**(row.get('definition') or {}), 'name': name}

        if not is_admin and row.get('status') == 'rejected' and body.get('reopen'):
            updated['status'] = 'draft'
            updated['review_note'] = ''

        updated['updated_at'] = time.time()
        return _serialize(put(db, 'teacher-templates', updated, current['id']))


@router.delete('/teacher-templates/{identifier}')
def delete_teacher_template(identifier: str, current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = require(db, identifier, 'teacher-templates')
        _check_read_access(row, current)
        db.execute('UPDATE objects SET deleted=1 WHERE id=?', (identifier,))
        db.execute(
            'INSERT INTO audit(id,actor,action,object_id,body) SELECT ?,?,?,?,body FROM objects WHERE id=?',
            (str(uuid4()), current['id'], 'delete', identifier, identifier),
        )
        return {'status': 'deleted'}


@router.post('/teacher-templates/{identifier}/submit')
def submit_teacher_template(identifier: str, body: dict | None = None, current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = require(db, identifier, 'teacher-templates')
        if row.get('owner_id') != current['id'] and current['role'] not in ('admin', 'manager'):
            raise HTTPException(403, '无权提交他人的独立题卡')
        definition = row.get('definition') or {}
        errors = issues(definition, complete=True, require_answers=False)
        if errors:
            raise HTTPException(422, '提交审核前请完善以下内容：' + '；'.join(errors))
        try:
            for aid in asset_ids(definition):
                require(db, aid, 'assets')
        except (ValueError, KeyError, TypeError) as err:
            raise HTTPException(422, str(err))
        now = time.time()
        updated = {
            **row,
            'status': 'submitted',
            'submitted_at': now,
            'updated_at': now,
            'review_note': '',
        }
        return _serialize(put(db, 'teacher-templates', updated, current['id']))


@router.post('/teacher-templates/{identifier}/reject')
def reject_teacher_template(identifier: str, body: dict, current=Depends(admin)):
    reason = str((body or {}).get('reason') or '').strip()
    if len(reason) > 500:
        raise HTTPException(422, '退回原因不能超过500字')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = require(db, identifier, 'teacher-templates')
        updated = {
            **row,
            'status': 'rejected',
            'review_note': reason or '管理员退回修改',
            'reviewed_at': time.time(),
            'reviewed_by': current['id'],
            'updated_at': time.time(),
        }
        return _serialize(put(db, 'teacher-templates', updated, current['id']))


@router.post('/teacher-templates/{identifier}/adopt')
def adopt_teacher_template(identifier: str, body: dict, current=Depends(admin)):
    group_id = (body or {}).get('group_id')
    subject_id = (body or {}).get('subject_id')
    if not group_id and not subject_id:
        raise HTTPException(422, '请选择要导入的目标考试题卡或科目')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        entry = require(db, identifier, 'teacher-templates')
        group = require(db, group_id, 'groups') if group_id else default_group(db, subject_id, current['id'])
        if group.get('frozen'):
            raise HTTPException(409, RESULTS_REVIEW_GUIDE + '也可以选择其他题卡。')
        definition = deepcopy(entry.get('definition') or {})
        try:
            for aid in asset_ids(definition):
                require(db, aid, 'assets')
        except (ValueError, KeyError, TypeError) as err:
            raise HTTPException(422, str(err))
        for q in definition.get('questions', []):
            q.pop('id', None)
        name = str((body or {}).get('name') or entry.get('name') or definition.get('name') or '未命名题卡').strip()
        if not 1 <= len(name) <= 100:
            raise HTTPException(422, '请填写100字以内题卡标题')
        definition.update(
            id=str(uuid4()),
            name=name,
            group_id=group['id'],
            revision=0,
            status='draft',
            draft_version=1,
            layout_version=3,
            source_teacher_template_id=identifier,
        )
        definition.setdefault('notice_template', 'standard-v1')
        apply_sheet_defaults(definition)
        prepare_questions(definition)
        saved_template = put(db, 'templates', definition, current['id'])

        now = time.time()
        updated_entry = {
            **entry,
            'status': 'approved',
            'adopted_template_id': saved_template['id'],
            'adopted_group_id': group['id'],
            'reviewed_at': now,
            'reviewed_by': current['id'],
            'review_note': '',
            'updated_at': now,
        }
        saved_entry = put(db, 'teacher-templates', updated_entry, current['id'])
        return {'template': saved_template, 'teacher_template': _serialize(saved_entry)}


@router.get('/teacher-templates/{identifier}/pdf')
def print_teacher_template(identifier: str, current=Depends(user)):
    with connect() as db:
        entry = require(db, identifier, 'teacher-templates')
        _check_read_access(entry, current)
    definition = deepcopy(entry.get('definition') or {})
    definition.update(id=entry['id'], revision=0, layout_version=3)
    try:
        content = paper.pdf(definition)
    except ValueError as error:
        raise HTTPException(422, str(error))
    return Response(content, media_type='application/pdf', headers={'Content-Disposition': 'attachment; filename=teacher-sheet.pdf', 'Cache-Control': 'private, no-store'})
