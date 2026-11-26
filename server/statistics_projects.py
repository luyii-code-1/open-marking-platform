"""Configuration, collection, and aggregation for statistics projects."""
import base64
from string import ascii_uppercase
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from . import paper, statistics_sheet
from .db import connect, find, get, objects, put
from .dependencies import admin, require
from .export_tables import ExportTable, FileFormat, table_response
from .lifecycle import writable
from .templates import render_preview, require_replaceable

router = APIRouter(prefix='/api/v1/projects')


def is_statistics_group(db, group):
    subject = get(db, group.get('subject_id'), 'subjects') or {}
    project = get(db, subject.get('project_id'), 'projects') or {}
    return project.get('category') == 'statistics'


def restore_empty_project_workspaces():
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        for project in find(db, 'projects', category='statistics'):
            group = get(db, project.get('statistics_group_id'), 'groups')
            if project.get('scans_purged') or not group or not group.get('statistics_group'):
                continue
            if db.execute('SELECT 1 FROM deletion_locks WHERE project_id=?', (project['id'],)).fetchone():
                continue
            if group.get('statistics_draft') or any(
                find(db, kind, group_id=group['id'])
                for kind in ('templates', 'scan-batches', 'statistics-responses')
            ):
                continue
            group.pop('statistics_group')
            project.pop('statistics_group_id')
            put(db, 'groups', group)
            put(db, 'projects', project)


def set_template_mode(db, group, value):
    value.pop('statistics_sheet', None)
    value.pop('statistics_mode', None)
    if not is_statistics_group(db, group):
        value.pop('candidate_enabled', None)
        value.pop('statistics_layout', None)
        return
    value['statistics_mode'] = True
    value['statistics_layout'] = 1
    if type(value.setdefault('candidate_enabled', True)) is not bool:
        raise HTTPException(422, '请选择是否启用准考证号')
    profile = value.get('external_sheet')
    if isinstance(profile, dict) and isinstance(profile.get('pages'), dict):
        for face in profile['pages'].values():
            if isinstance(face, dict):
                face.pop('absent', None)
    value['notice_template'] = 'none'
    value['uniform_subjective'] = False
    value['auto_subjective_layout'] = False
    for q in value['questions']:
        q.update(points=0, answer=[], rule={'mode': 'exact'}, review_mode='single', threshold=0)


def context(db, identifier, group_id=None):
    project = require(db, identifier, 'projects')
    if project.get('category') != 'statistics':
        raise HTTPException(404, '请选择统计项目')
    group = require(db, group_id or project.get('statistics_group_id'), 'groups')
    subject = get(db, group.get('subject_id'), 'subjects') or {}
    if subject.get('project_id') != identifier:
        raise HTTPException(404, '题卡不属于该统计项目')
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
def set_collection(identifier: str, body: dict, group_id: str | None = None, current=Depends(admin)):
    closed = body.get('closed')
    if type(closed) is not bool:
        raise HTTPException(422, '请选择收集状态')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        project, group, template = context(db, identifier, group_id)
        writable(db, 'projects', project)
        if bool(group.get('frozen')) == closed:
            return {'closed': closed}
        if closed:
            if not template or not responses_for(db, group, template):
                raise HTTPException(409, '请先确认至少一份统计答卷')
            batches = [batch for batch in find(db, 'scan-batches', group_id=group['id']) if batch['status'] != 'paired']
            if any(not page.get('excluded') for batch in batches for page in find(db, 'pages', batch_id=batch['id'])):
                raise HTTPException(409, '请先处理尚未确认的扫描批次')
            if template.get('statistics_mode'):
                from .workflow import overview
                if overview(db, group, current)['open_exceptions']:
                    raise HTTPException(409, '请先处理待核查的答卷异常')
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
    questions = sorted((template or {}).get('questions', []), key=lambda q: q['number'])
    total = len(responses)
    rows = []
    for q in questions:
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
        rows.append({
            'number': q['number'],
            'title': q.get('title', ''),
            'type': q['type'],
            'options': q['options'],
            'counts': counts,
            'blank': blank,
            'invalid': invalid,
            'valid': max(0, total - blank - invalid),
        })
    return {'total': total, 'rows': rows}


def _detailed_responses(db, group, template):
    if not template:
        return []
    from .review import objective_selections
    if not statistics_sheet.uses_candidate_number(template):
        responses = sorted(
            find(db, 'statistics-responses', group_id=group['id'], template_id=template['id']),
            key=lambda item: item['id'],
        )
        items = []
        for idx, response in enumerate(responses, 1):
            selections = response.get('selections', {}) if statistics_sheet.enabled(template) else objective_selections(db, response)
            items.append({
                'id': response['id'],
                'index': idx,
                'candidate_number': '',
                'student_name': '',
                'class_id': '',
                'class_name': '',
                'grade_name': '',
                'tags': [],
                'selections': selections,
            })
        return items

    students = {s['id']: s for s in objects(db, 'students')}
    classes = {c['id']: c for c in objects(db, 'classes')}
    grades = {g['id']: g for g in objects(db, 'grades')}
    submissions = [
        sub for sub in find(db, 'submissions', group_id=group['id'])
        if sub['template_id'] == template['id'] and sub['status'] != 'absent' and sub.get('pages')
    ]
    items = []
    for sub in submissions:
        student = students.get(sub.get('student_id'), {})
        cls = classes.get(student.get('class_id'), {})
        grade = grades.get(cls.get('grade_id'), {})
        items.append({
            'id': sub['id'],
            'candidate_number': str(student.get('candidate_number') or sub.get('candidate_number') or ''),
            'student_name': str(student.get('name') or ''),
            'class_id': str(cls.get('id') or ''),
            'class_name': str(cls.get('name') or '未分班'),
            'grade_name': str(grade.get('name') or ''),
            'tags': list(cls.get('tags') or []),
            'selections': objective_selections(db, sub),
        })
    items.sort(key=lambda item: (item['grade_name'], item['class_name'], item['candidate_number'], item['student_name'], item['id']))
    for idx, item in enumerate(items, 1):
        item['index'] = idx
    return items


def responses_for(db, group, template):
    return [{'selections': item['selections']} for item in _detailed_responses(db, group, template)]


def _parse_csv(raw: str | None) -> set[str]:
    if not raw:
        return set()
    return {part.strip() for part in raw.split(',') if part.strip()}


def _classify_answer(question, selected_values):
    valid_keys = set(ascii_uppercase[:question['options']])
    chosen = sorted(set(selected_values))
    if not chosen:
        return 'blank', ''
    if not set(chosen) <= valid_keys or (question['type'] == 'single' and len(chosen) > 1):
        return 'invalid', ''.join(chosen)
    return 'valid', ''.join(chosen)


def _filter_detailed(items, template, class_ids=None, class_tags=None, q='', question_number=None, option=None):
    wanted_classes = _parse_csv(class_ids)
    wanted_tags = _parse_csv(class_tags)
    term = (q or '').strip().casefold()
    target_q = None
    if question_number is not None and template:
        target_q = next((item for item in template.get('questions', []) if item['number'] == question_number), None)
    wanted_opt = (option or '').strip()
    filtered = []
    for item in items:
        if wanted_classes and item['class_id'] not in wanted_classes:
            continue
        if wanted_tags and not (set(item['tags']) & wanted_tags):
            continue
        if term and not any(term in str(item.get(k, '')).casefold() for k in ('student_name', 'candidate_number', 'class_name', 'grade_name')):
            continue
        if target_q is not None and wanted_opt:
            state, joined = _classify_answer(target_q, item['selections'].get(target_q['id'], []))
            if wanted_opt == 'blank':
                if state != 'blank':
                    continue
            elif wanted_opt == 'invalid':
                if state != 'invalid':
                    continue
            else:
                if state != 'valid' or wanted_opt.upper() not in set(joined):
                    continue
        filtered.append(item)
    return filtered


def results(db, identifier, group_id=None, class_ids=None, class_tags=None, q='', question_number=None, option=None):
    _, group, template = context(db, identifier, group_id)
    uses_candidate = bool(template and statistics_sheet.uses_candidate_number(template))
    all_items = _detailed_responses(db, group, template)
    filtered_items = _filter_detailed(all_items, template, class_ids, class_tags, q, question_number, option)
    summary = aggregate(template, filtered_items)

    questions = sorted((template or {}).get('questions', []), key=lambda item: item['number'])
    class_options_map = {}
    all_tags = set()
    for item in all_items:
        for tag in item['tags']:
            all_tags.add(tag)
        if uses_candidate:
            cid = item['class_id'] or '__none__'
            entry = class_options_map.setdefault(cid, {
                'id': item['class_id'],
                'name': (f"{item['grade_name']} · {item['class_name']}" if item['grade_name'] else item['class_name']),
                'class_name': item['class_name'],
                'grade_name': item['grade_name'],
                'tags': item['tags'],
                'count': 0,
            })
            entry['count'] += 1

    by_class = []
    if uses_candidate:
        grouped: dict[str, list] = {}
        for item in filtered_items:
            grouped.setdefault(item['class_id'] or '__none__', []).append(item)
        for cid, bucket in sorted(grouped.items(), key=lambda kv: (kv[1][0]['grade_name'], kv[1][0]['class_name'])):
            first = bucket[0]
            agg = aggregate(template, bucket)
            by_class.append({
                'class_id': first['class_id'],
                'class_name': first['class_name'],
                'grade_name': first['grade_name'],
                'tags': first['tags'],
                'total': agg['total'],
                'rows': agg['rows'],
            })

    records = []
    for item in filtered_items:
        answers = {}
        has_blank = False
        has_invalid = False
        for question in questions:
            state, text = _classify_answer(question, item['selections'].get(question['id'], []))
            if state == 'blank':
                has_blank = True
                answers[str(question['number'])] = ''
            elif state == 'invalid':
                has_invalid = True
                answers[str(question['number'])] = f'无效({text})'
            else:
                answers[str(question['number'])] = text
        records.append({
            'id': item['id'],
            'index': item['index'],
            'candidate_number': item['candidate_number'],
            'student_name': item['student_name'],
            'class_id': item['class_id'],
            'class_name': item['class_name'],
            'grade_name': item['grade_name'],
            'tags': item['tags'],
            'status': '含无效' if has_invalid else ('含空白' if has_blank else '完整有效'),
            'answers': answers,
        })

    return {
        **summary,
        'unfiltered_total': len(all_items),
        'uses_candidate': uses_candidate,
        'classes': sorted(class_options_map.values(), key=lambda c: (c['grade_name'], c['class_name'])),
        'class_tags': sorted(all_tags),
        'by_class': by_class,
        'records': records,
    }


@router.get('/{identifier}/statistics/overview')
def statistics_overview(identifier: str, subject_id: str | None = None, grade_id: str | None = None, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN')
        project = require(db, identifier, 'projects')
        if project.get('category') != 'statistics':
            raise HTTPException(404, '请选择统计项目')
        subjects = {s['id']: s for s in find(db, 'subjects', project_id=identifier) if not subject_id or s['id'] == subject_id}
        grades = {g['id']: g for g in objects(db, 'grades')}
        groups = [
            g for g in objects(db, 'groups')
            if g.get('subject_id') in subjects and (not grade_id or g.get('grade_id') == grade_id)
        ]
        groups.sort(key=lambda g: (subjects[g['subject_id']]['name'], grades.get(g.get('grade_id'), {}).get('name', ''), g['name']))
        from .workflow import overview as group_workflow
        cards = []
        total_received = 0
        for group in groups:
            template = get(db, group.get('template_id'), 'templates')
            uses_candidate = bool(template and statistics_sheet.uses_candidate_number(template))
            items = _detailed_responses(db, group, template) if template else []
            wf = group_workflow(db, group, current) if template else None
            total_received += len(items)
            cards.append({
                'group_id': group['id'],
                'group_name': group['name'],
                'subject_id': group['subject_id'],
                'subject_name': subjects[group['subject_id']]['name'],
                'grade_id': group.get('grade_id') or '',
                'grade_name': grades.get(group.get('grade_id'), {}).get('name', '未设年级'),
                'template_id': template['id'] if template else None,
                'template_name': template['name'] if template else '',
                'uses_candidate': uses_candidate,
                'question_count': len(template.get('questions', [])) if template else 0,
                'closed': bool(group.get('frozen')),
                'received': len(items),
                'expected': wf['scan']['expected'] if wf and uses_candidate else None,
                'open_exceptions': wf['open_exceptions'] if wf else 0,
            })
        return {
            'project_id': project['id'],
            'project_name': project['name'],
            'card_count': len(cards),
            'published_count': sum(1 for c in cards if c['template_id']),
            'closed_count': sum(1 for c in cards if c['closed']),
            'total_received': total_received,
            'cards': cards,
        }


@router.get('/{identifier}/statistics/results')
def statistics_results(
    identifier: str,
    group_id: str | None = None,
    class_ids: str | None = None,
    class_tags: str | None = None,
    q: str = '',
    question_number: int | None = None,
    option: str | None = None,
    current=Depends(admin),
):
    with connect() as db:
        db.execute('BEGIN')
        return results(db, identifier, group_id, class_ids=class_ids, class_tags=class_tags, q=q, question_number=question_number, option=option)


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
def statistics_export(
    identifier: str,
    format: FileFormat = 'xlsx',
    group_id: str | None = None,
    view: str = 'summary',
    class_ids: str | None = None,
    class_tags: str | None = None,
    q: str = '',
    question_number: int | None = None,
    option: str | None = None,
    current=Depends(admin),
):
    if view not in ('summary', 'records', 'classes'):
        raise HTTPException(422, '导出视图无效')
    with connect() as db:
        db.execute('BEGIN')
        data = results(db, identifier, group_id, class_ids=class_ids, class_tags=class_tags, q=q, question_number=question_number, option=option)
    total = data['total']
    letters = ascii_uppercase[:max((len(row['counts']) for row in data['rows']), default=0)]
    if view == 'records':
        q_nums = [row['number'] for row in data['rows']]
        if data['uses_candidate']:
            columns = ['序号', '准考证号', '姓名', '年级', '班级', '标签', '状态', *[f'第 {n} 题' for n in q_nums]]
            rows = [
                [
                    rec['index'], rec['candidate_number'], rec['student_name'], rec['grade_name'],
                    rec['class_name'], '、'.join(rec['tags']), rec['status'],
                    *[rec['answers'].get(str(n), '') for n in q_nums],
                ]
                for rec in data['records']
            ]
        else:
            columns = ['序号', '状态', *[f'第 {n} 题' for n in q_nums]]
            rows = [
                [rec['index'], rec['status'], *[rec['answers'].get(str(n), '') for n in q_nums]]
                for rec in data['records']
            ]
        return table_response(ExportTable('作答明细', columns, rows), 'statistics-records', format)
    if view == 'classes':
        columns = ['年级', '班级', '标签', '题号', '题目', '题型', '入库份数', '有效份数', '空白份数', '无效份数']
        for letter in letters:
            columns.extend([f'{letter} 份数', f'{letter} 占比'])
        rows = []
        for cls in data['by_class']:
            cls_total = cls['total']
            for row in cls['rows']:
                values = [
                    cls['grade_name'], cls['class_name'], '、'.join(cls['tags']),
                    row['number'], row['title'], '单选' if row['type'] == 'single' else '多选',
                    cls_total, row['valid'], row['blank'], row['invalid'],
                ]
                for letter in letters:
                    count = row['counts'].get(letter)
                    values.extend([count, '' if count is None else f'{100 * count / cls_total:.1f}%' if cls_total else '0.0%'])
                rows.append(values)
        return table_response(ExportTable('分班统计', columns, rows), 'statistics-by-class', format)
    columns = ['题号', '题目', '题型', '确认份数', '有效份数', '空白份数', '无效份数']
    for letter in letters:
        columns.extend([f'{letter} 份数', f'{letter} 占比'])
    rows = []
    for row in data['rows']:
        values = [row['number'], row['title'], '单选' if row['type'] == 'single' else '多选', total, row['valid'], row['blank'], row['invalid']]
        for letter in letters:
            count = row['counts'].get(letter)
            values.extend([count, '' if count is None else f'{100 * count / total:.1f}%' if total else '0.0%'])
        rows.append(values)
    return table_response(ExportTable('选项统计', columns, rows), 'option-statistics', format)
