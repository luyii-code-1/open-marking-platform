"""Configuration and aggregation for anonymous statistics projects."""
import base64
from string import ascii_uppercase
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from . import paper, statistics_sheet
from .db import connect, find, get, put
from .dependencies import admin, require
from .export_tables import ExportTable, FileFormat, table_response
from .lifecycle import writable
from .templates import render_preview, require_replaceable

router = APIRouter(prefix='/api/v1/projects')


def create_group(db, project, actor):
    subject = put(db, 'subjects', {'project_id': project['id'], 'name': '统计题卡', 'group_mode': 'default'}, actor)
    group = put(db, 'groups', {'subject_id': subject['id'], 'name': project['name'], 'statistics_group': True,
                               'roster_mode': 'open', 'template_id': None}, actor)
    put(db, 'subjects', {**subject, 'default_group_id': group['id']}, actor)
    return put(db, 'projects', {**project, 'statistics_group_id': group['id']}, actor)


def context(db, identifier):
    project = require(db, identifier, 'projects')
    if project.get('category') != 'statistics':
        raise HTTPException(404, '请选择统计项目')
    group = require(db, project.get('statistics_group_id'), 'groups')
    template = get(db, group.get('template_id'), 'templates')
    return project, group, template


def design(data):
    if not isinstance(data, list) or not data or len(data) > 32:
        raise ValueError('请设置 1 至 32 道统计题')
    questions = []
    for index, item in enumerate(data, 1):
        if not isinstance(item, dict):
            raise ValueError('题目配置无效')
        kind, count, title = item.get('type'), item.get('options'), item.get('title', '')
        if (kind not in ('single', 'multiple') or type(count) is not int or not 2 <= count <= 26
                or not isinstance(title, str) or len(title) > 64 or any(ord(c) < 32 for c in title)):
            raise ValueError(f'第 {index} 题需设置单选或多选、2 至 26 个选项及 64 字以内的题目说明')
        questions.append({'id': str(uuid4()), 'number': index, 'type': kind, 'options': count,
                          'title': title.strip(), 'choice_style': 'statistics'})
    return statistics_sheet.layout(questions)


@router.get('/{identifier}/statistics')
def get_statistics(identifier: str, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN')
        project, group, template = context(db, identifier)
        locked = bool(db.execute('SELECT 1 FROM scanned_groups WHERE group_id=?', (group['id'],)).fetchone())
        return {'group_id': group['id'], 'template': template, 'draft': None if locked else group.get('statistics_draft'),
                'external_draft': None if locked else get(db, group.get('statistics_external_draft_id'), 'templates'),
                'draft_version': group.get('statistics_draft_version', 0), 'locked': locked,
                'closed': bool(group.get('frozen')), 'scans_purged': bool(project.get('scans_purged'))}


@router.put('/{identifier}/statistics')
def save_statistics(identifier: str, body: dict, current=Depends(admin)):
    publish = body.get('publish', False)
    if type(publish) is not bool:
        raise HTTPException(422, '发布参数无效')
    try:
        questions, sides = design(body.get('questions'))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        project, group, template = context(db, identifier)
        writable(db, 'projects', project)
        require_replaceable(db, group['id'])
        version = group.get('statistics_draft_version', 0)
        if body.get('draft_version') != version:
            raise HTTPException(409, '统计题卡已在其他窗口更新，请重新载入')
        group.update(statistics_draft=questions, statistics_draft_version=version + 1)
        if publish:
            revision = (template or {}).get('revision', 0) + 1
            if template:
                put(db, 'templates', {**template, 'status': 'superseded'}, current['id'])
            template = put(db, 'templates', {'group_id': group['id'], 'name': project['name'], 'status': 'published',
                                             'paper': 'A4', 'sides': sides, 'layout_version': 2, 'revision': revision,
                                             'statistics_sheet': True, 'questions': questions}, current['id'])
            group.update(template_id=template['id'], statistics_draft=None)
        put(db, 'groups', group, current['id'])
        return {'group_id': group['id'], 'template': template, 'draft': group['statistics_draft'],
                'draft_version': version + 1, 'locked': False, 'closed': False, 'scans_purged': False}


@router.put('/{identifier}/statistics/collection')
def set_collection(identifier: str, body: dict, current=Depends(admin)):
    closed = body.get('closed')
    if type(closed) is not bool:
        raise HTTPException(422, '请选择收集状态')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        project, group, template = context(db, identifier)
        writable(db, 'projects', project)
        if bool(group.get('frozen')) == closed:
            return {'closed': closed}
        if closed:
            if not template or not find(db, 'statistics-responses', group_id=group['id']):
                raise HTTPException(409, '请先确认至少一份统计答卷')
            batches = [batch for batch in find(db, 'scan-batches', group_id=group['id']) if batch['status'] != 'paired']
            if any(not page.get('excluded') for batch in batches for page in find(db, 'pages', batch_id=batch['id'])):
                raise HTTPException(409, '请先处理尚未确认的扫描批次')
        put(db, 'groups', {**group, 'frozen': closed}, current['id'])
        return {'closed': closed}


def confirm(db, batch, template, page_sets, actor):
    for pages in page_sets:
        selections = {}
        for page in pages:
            selections.update(page.get('selections', {}))
        put(db, 'statistics-responses', {'id': str(uuid4()), 'group_id': batch['group_id'],
                                        'template_id': template['id'], 'batch_id': batch['id'],
                                        'pages': [page['id'] for page in pages], 'selections': selections,
                                        'room_tags': batch.get('room_tags', [])}, actor)


def aggregate(template, responses):
    questions = (template or {}).get('questions', [])
    total = len(responses)
    rows = []
    for q in sorted(questions, key=lambda q: q['number']):
        counts = dict.fromkeys(ascii_uppercase[:q['options']], 0)
        blank = invalid = 0
        for response in responses:
            selected = set(response['selections'].get(q['id'], []))
            if not selected:
                blank += 1
            elif not selected <= counts.keys() or (q['type'] == 'single' and len(selected) > 1):
                invalid += 1
            else:
                for letter in selected:
                    counts[letter] += 1
        rows.append({'number': q['number'], 'title': q.get('title', ''), 'type': q['type'], 'counts': counts,
                     'blank': blank, 'invalid': invalid})
    return {'total': total, 'rows': rows}


def results(db, identifier):
    _, group, template = context(db, identifier)
    return aggregate(template, find(db, 'statistics-responses', group_id=group['id']))


@router.get('/{identifier}/statistics/results')
def statistics_results(identifier: str, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN')
        return results(db, identifier)


@router.get('/{identifier}/statistics/preview')
def statistics_preview(identifier: str, current=Depends(admin)):
    with connect() as db:
        project, group, template = context(db, identifier)
        locked = db.execute('SELECT 1 FROM scanned_groups WHERE group_id=?', (group['id'],)).fetchone()
        questions = None if locked else group.get('statistics_draft')
    if questions:
        template = {'id': group['id'], 'revision': 0, 'name': project['name'], 'questions': questions,
                    'sides': questions[-1]['regions'][0]['page'], 'status': 'draft'}
    if not template:
        raise HTTPException(404, '请先保存题卡草稿')
    try:
        content = paper.pdf(template) if template.get('external_sheet') else statistics_sheet.pdf(template)
    except ValueError as error:
        raise HTTPException(422,str(error)) from error
    return Response(content, media_type='application/pdf',
                    headers={'Content-Disposition':'attachment; filename=statistics-card.pdf','Cache-Control':'private, no-store'})


@router.post('/{identifier}/statistics/paper-preview')
def statistics_paper_preview(identifier: str, body: dict, page: int = 1, current=Depends(admin)):
    with connect() as db:
        project, group, published = context(db, identifier)
    if body.get('published') is True:
        if not published:
            raise HTTPException(404, '请先发布题卡')
        template = published
    else:
        try:
            questions, sides = design(body.get('questions'))
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        # Keep geometry-based preview cache keys stable across equivalent requests.
        questions = [{k: value for k, value in q.items() if k != 'id'} for q in questions]
        template = {'id': group['id'], 'revision': 0, 'name': project['name'], 'questions': questions,
                    'paper': 'A4', 'sides': sides, 'status': 'draft', 'statistics_sheet': True}
    page = max(1, min(page, template['sides']))
    image = render_preview(template, page)
    src = f'data:{image.media_type};base64,' + base64.b64encode(image.body).decode('ascii')
    return {'image': src, 'page': page, 'sides': template['sides']}


@router.get('/{identifier}/statistics/export')
def statistics_export(identifier: str, format: FileFormat = 'xlsx', current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN')
        data = results(db, identifier)
    total = data['total']
    letters = ascii_uppercase[:max((len(row['counts']) for row in data['rows']), default=0)]
    columns = ['题号', '题目', '题型', '确认份数', '空白份数', '无效份数']
    for letter in letters:
        columns.extend([f'{letter} 份数', f'{letter} 占比'])
    rows = []
    for row in data['rows']:
        values = [row['number'], row['title'], '单选' if row['type'] == 'single' else '多选', total, row['blank'], row['invalid']]
        for letter in letters:
            count = row['counts'].get(letter)
            values.extend([count, '' if count is None else f'{100 * count / total:.1f}%' if total else '0.0%'])
        rows.append(values)
    return table_response(ExportTable('选项统计', columns, rows), 'option-statistics', format)
