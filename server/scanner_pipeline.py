"""Versioned metadata and ingestion for pages recognized on a registered device."""
import hashlib
import io
import json
import zipfile
from string import ascii_uppercase
from uuid import UUID
import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from .lifecycle import RESULTS_REVIEW_GUIDE
from .db import connect, find, get, objects, put
from .dependencies import require, scan_admin, scan_batch
from .lifecycle import writable
from .omr import ENGINE_VERSION, dimensions
from . import compatible_omr, statistics_sheet
from .storage import local_path
from .exam_status import ExamStatusFilter, STATUS_FIELDS, project_views, filter_projects

router = APIRouter(prefix='/api/v1/scanner')
LIMIT = 30 * 1024 * 1024


def checksum(content): return hashlib.sha256(content).hexdigest()


def configuration(template):
    fields = ('id', 'name', 'paper', 'sides', 'revision', 'layout_version', 'candidate_length', 'sheet_columns')
    result = {k: template[k] for k in fields if k in template}
    result['questions'] = [{k: q[k] for k in ('id', 'number', 'type', 'options', 'regions', 'choice_style') if k in q} for q in template['questions']]
    if statistics_sheet.enabled(template):
        result['statistics_sheet'] = True
    if compatible_omr.profile(template):
        result['external_sheet'] = template['external_sheet']
        for question, configured in zip(template['questions'], result['questions']):
            if 'external_options' in question:
                configured['external_options'] = question['external_options']
    return result


def config_hash(template):
    return checksum(json.dumps(configuration(template), sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode())


@router.get('/catalog')
def catalog(exam_status: ExamStatusFilter='all', current=Depends(scan_admin)):
    with connect() as db:
        db.execute('BEGIN')
        subjects=objects(db,'subjects');groups=objects(db,'groups')
        projects=filter_projects(project_views(db,objects(db,'projects'),subjects,groups),exam_status)
        if exam_status!='all':
            project_ids={p['id'] for p in projects}
            subjects=[s for s in subjects if s.get('project_id') in project_ids]
            subject_ids={s['id'] for s in subjects}
            groups=[g for g in groups if g.get('subject_id') in subject_ids]
        values={'projects':projects,'subjects':subjects,'groups':groups}
        return {kind: [{k: value[k] for k in fields if k in value} for value in values[kind]] for kind, fields in (
            ('projects', ('id', 'name', 'status', 'category', *STATUS_FIELDS)), ('subjects', ('id', 'name', 'project_id', 'default_group_id')),
            ('groups', ('id', 'name', 'subject_id', 'template_id', 'frozen', 'grade_id')))}


@router.get('/projects/{identifier}/package')
def project_package(identifier: str, capability: str = '', current=Depends(scan_admin)):
    with connect() as db:
        db.execute('BEGIN'); project = require(db, identifier, 'projects'); writable(db, 'projects', project)
        project=project_views(db,[project])[0]
        subjects = find(db, 'subjects', project_id=identifier); subject_ids = {s['id'] for s in subjects}
        groups = [g for g in objects(db, 'groups') if g.get('subject_id') in subject_ids]
        packaged = []
        for group in groups:
            template = get(db, group.get('template_id'), 'templates')
            if not template or template['status'] != 'published': continue
            capabilities = capability.split(',')
            if compatible_omr.profile(template) and compatible_omr.CAPABILITY not in capabilities: continue
            if statistics_sheet.enabled(template):
                if statistics_sheet.CAPABILITY not in capabilities: continue
                if compatible_omr.profile(template) and statistics_sheet.EXTERNAL_CAPABILITY not in capabilities:
                    project['required_scanner_capability'] = statistics_sheet.EXTERNAL_CAPABILITY
                    continue
                confirmed = find(db, 'statistics-responses', group_id=group['id'])
                packaged.append({'id': group['id'], 'name': group['name'], 'subject_id': group['subject_id'],
                                 'frozen': bool(group.get('frozen')), 'roster_mode': 'open', 'roster': [],
                                 'template': configuration(template), 'config_sha256': config_hash(template),
                                 'confirmed_candidates': [], 'confirmed_students': 0, 'confirmed_sheets': len(confirmed),
                                 'unassigned_sheets': sum(not response.get('room_tags') for response in confirmed)})
                continue
            from .school import group_students
            roster = group_students(db,group)
            is_open_roster = group.get('roster_mode') == 'open' or not roster
            scanner_roster = objects(db, 'students') if is_open_roster else roster
            confirmed=find(db,'submissions',group_id=group['id'])
            valid=[s for s in confirmed if s.get('pages') or s.get('status')=='absent']
            packaged.append({'id': group['id'], 'name': group['name'], 'subject_id': group['subject_id'], 'frozen': bool(group.get('frozen')), 'grade_id':group.get('grade_id'), 'grade_name':(get(db,group.get('grade_id'),'grades') or {}).get('name',''),
                             'roster_mode': 'open' if is_open_roster else (group.get('roster_mode') or ('grade' if group.get('grade_id') else 'selected')),
                             'template': {**configuration(template), 'notice_layout':template.get('notice_layout',1), 'notice_template':template.get('notice_template')}, 'config_sha256': config_hash(template),
                             'confirmed_candidates':sorted({s['candidate_number'] for s in valid}),
                             'confirmed_students':len({s['student_id'] for s in valid}),
                             'confirmed_sheets':sum(bool(s.get('pages')) for s in valid),
                             'unassigned_sheets':sum(bool(s.get('pages')) and not s.get('room_tags') for s in valid),
                             'roster': [{'id':s['id'],'candidate_number': s['candidate_number'], 'name': s['name']} for s in scanner_roster] if scanner_roster is not None else None})
        from .room_tags import view,progress
        rooms=[{**view(db,[t])[0],**progress(db,t)} for t in find(db,'room-tags',project_id=identifier)]
        return {'protocol': 'omp-scanner-4', 'engine_version': ENGINE_VERSION,
                'room_tags':rooms,
                'project': {k: project[k] for k in ('id', 'name', 'status', 'category', 'required_scanner_capability', *STATUS_FIELDS) if k in project},
                'subjects': [{k: s[k] for k in ('id', 'name', 'default_group_id') if k in s} for s in subjects], 'groups': packaged}


def batch_context(db, identifier, current):
    batch = scan_batch(db, identifier, current); group = require(db, batch['group_id'], 'groups')
    writable(db, 'scan-batches', batch)
    if group.get('frozen'): raise HTTPException(409, RESULTS_REVIEW_GUIDE)
    template = require(db, batch['template_id'], 'templates')
    if (group.get('template_id') != template['id'] and template.get('status')!='superseded') or template['revision'] != batch['template_revision']: raise HTTPException(409, '题卡版本已变化，请下载项目配置并重新建立批次')
    return batch, group, template


@router.post('/batches/{identifier}')
def register_batch(identifier: str, body: dict, current=Depends(scan_admin)):
    try: identifier = str(UUID(identifier))
    except ValueError: raise HTTPException(422, '批次编号无效')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE'); existing = get(db, identifier, 'scan-batches')
        if existing:
            batch, _, template = batch_context(db, identifier, current)
            if any(body.get(k) != batch.get(k) for k in ('group_id', 'template_id', 'template_revision', 'config_sha256', 'back_order', 'capture_mode')): raise HTTPException(409, '本地批次与服务器记录不一致')
            if sorted(body.get('room_tag_ids',[]))!=sorted(t['id'] for t in batch.get('room_tags',[])):raise HTTPException(409,'本地考场标签与批次记录不一致')
            return batch
        group = require(db, body.get('group_id'), 'groups'); writable(db, 'groups', group)
        if group.get('frozen'): raise HTTPException(409, RESULTS_REVIEW_GUIDE)
        template = require(db, group.get('template_id'), 'templates')
        if template['status'] != 'published' or template['id'] != body.get('template_id') or template['revision'] != body.get('template_revision') or config_hash(template) != body.get('config_sha256'): raise HTTPException(409, '题卡配置已变化，请重新下载项目配置')
        from .room_tags import snapshot,project_for_group
        labels=snapshot(db,project_for_group(db,group['id']),body.get('room_tag_ids',[]),group=group)
        mode = body.get('capture_mode', 'separate'); order = body.get('back_order', 'same'); room = body.get('room', '')
        if mode not in ('duplex', 'separate') or order not in ('same', 'reverse') or (mode == 'duplex' and (template['sides'] != 2 or order != 'same')) or not isinstance(room, str) or len(room) > 100: raise HTTPException(422, '采集方式、背面顺序或备注无效')
        return put(db, 'scan-batches', {'id': identifier, 'group_id': group['id'], 'template_id': template['id'], 'template_revision': template['revision'],
                                      'config_sha256': body['config_sha256'], 'grade_id':group.get('grade_id'), 'room_tags':labels, 'room': room,
                                      'capture_mode': mode, 'back_order': order,
                                      'status': 'front', **({'scanner_device_id': current['id']} if current['role'] == 'scanner' else {})}, current['id'])


def image_bytes(file, expected_shape=None, image_format='PNG'):
    content = file.file.read(LIMIT + 1)
    if len(content) > LIMIT: raise HTTPException(413, '单个扫描文件超过30MB')
    # Inspect dimensions before allocating a decoded image.
    from PIL import Image
    try:
        with Image.open(io.BytesIO(content)) as probe:
            if probe.width * probe.height > 40_000_000: raise ValueError('图片像素过多')
            if expected_shape and probe.size != expected_shape: raise ValueError('校正图尺寸与题卡不一致')
            if expected_shape and probe.format != image_format: raise ValueError('校正图需要'+image_format+'格式')
            if expected_shape and image_format == 'JPEG' and probe.mode != 'L': raise ValueError('校正JPEG需要灰度格式')
            probe.verify()
    except (ValueError, OSError, Image.DecompressionBombError) as error: raise HTTPException(422, str(error))
    return content


def verified_absence(template, side, result, normalized):
    # Recheck moved marks on the corrected image supplied by existing scanner engines.
    if side=='front' and 'operator_correction' in result:return result['absent_mark']
    if compatible_omr.profile(template):
        if side != 'front' or not compatible_omr.page_profile(template, side).get('absent'):
            return False
        return result['absent_mark']
    from . import sheet_notices
    if template.get('notice_layout',1)==2 and sheet_notices.enabled(template):
        from .omr import absent_mark
        image=cv2.imdecode(np.frombuffer(normalized,np.uint8),cv2.IMREAD_GRAYSCALE)
        if image is None:raise HTTPException(422,'校正图无法解码')
        return absent_mark(image,side,template)
    return result['absent_mark']


def verify_result(template, side, result, original, normalized, cuts):
    supported={ENGINE_VERSION} if template.get('layout_version',2)>=3 or any(q.get('choice_style')=='compact' for q in template['questions']) else {ENGINE_VERSION,'omp-omr-2'} if any(q.get('choice_style')=='bracket' for q in template['questions']) else {ENGINE_VERSION,'omp-omr-2','omp-omr-1'}
    if compatible_omr.profile(template):
        supported = {compatible_omr.ENGINE_VERSION}
    anonymous = statistics_sheet.enabled(template)
    if anonymous:
        supported = {statistics_sheet.ENGINE_VERSION}
    if result.get('engine_version') not in supported or result.get('template_id') != template['id'] or result.get('template_revision') != template['revision'] or result.get('config_sha256') != config_hash(template): raise HTTPException(409, '本地识读引擎或题卡版本不匹配，请更新扫描端并下载配置')
    checks = (('normalized_sha256', normalized),) if result.get('upload_format') == 'jpeg-sheet-1' else (('source_sha256', original), ('normalized_sha256', normalized), ('local_cuts_sha256', cuts))
    if any(result.get(key) != checksum(data) for key, data in checks): raise HTTPException(422, '上传文件与本地识读校验值不一致')
    candidate = result.get('candidate_number')
    if side == 'front' and not anonymous and (not isinstance(candidate, str) or len(candidate) != template.get('candidate_length', 8) or any(c not in '0123456789?' for c in candidate)): raise HTTPException(422, '本地考号识读结果无效')
    if (side == 'back' or anonymous) and candidate is not None: raise HTTPException(422, '扫描面不接受考号')
    if not isinstance(result.get('absent_mark'), bool): raise HTTPException(422, '缺考识读结果无效')
    if anonymous and result['absent_mark']: raise HTTPException(422, '统计答卷不接受缺考标记')
    page = 1 if side == 'front' else 2
    questions = {q['id']: q for q in template['questions'] if q['type'] != 'subjective' and any(r['page'] == page for r in q['regions'])}
    selected = result.get('selections')
    if not isinstance(selected, dict) or set(selected) != set(questions): raise HTTPException(422, '客观题识读范围与题卡不一致')
    for qid, values in selected.items():
        letters = (ascii_uppercase if anonymous else 'ABCDEFG')[:questions[qid].get('options', 4)]
        if not isinstance(values, list) or len(values) > len(letters) or len(set(str(v) for v in values)) != len(values) or any(not isinstance(v, str) or len(v) != 1 or v not in letters for v in values): raise HTTPException(422, '客观题选项无效')
    if result.get('upload_format') == 'jpeg-sheet-1':
        if not isinstance(result.get('source_sha256'),str) or len(result['source_sha256'])!=64 or any(c not in '0123456789abcdef' for c in result['source_sha256']): raise HTTPException(422,'扫描原图校验值无效')
        return
    expected = {q['id'] + '.' + str(i) + '.png': (q['id'], i, r) for q in template['questions'] for i, r in enumerate(q['regions']) if r['page'] == page}
    entries = result.get('cuts', [])
    if not isinstance(entries, list) or len(entries) != len(expected) or {e.get('entry') for e in entries if isinstance(e, dict)} != set(expected): raise HTTPException(422, '切题清单不完整')
    try:
        with zipfile.ZipFile(io.BytesIO(cuts)) as package:
            if len(package.namelist()) != len(expected) or set(package.namelist()) != set(expected): raise ValueError('切题包内容与题卡不一致')
            for entry in entries:
                qid, index, region = expected[entry['entry']]
                x, y, w, h = (region[k] * 4 for k in ('x', 'y', 'width', 'height'))
                width, height = int(x + w) - int(x), int(y + h) - int(y)
                if entry.get('question_id') != qid or entry.get('region_index') != index or entry.get('region') != region or entry.get('width') != width or entry.get('height') != height: raise ValueError('切题区域不一致')
                info = package.getinfo(entry['entry'])
                if info.file_size > min(LIMIT, width * height * 4 + 65536) or info.file_size != entry.get('size'): raise ValueError('切题文件大小无效')
                data = package.read(entry['entry'])
                if checksum(data) != entry.get('sha256'): raise ValueError('切题文件校验失败')
                decoded = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
                if decoded is None or decoded.shape != (height, width): raise ValueError('切题图尺寸无效')
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, RuntimeError) as error: raise HTTPException(422, str(error))


@router.post('/batches/{identifier}/pages')
def upload_processed(identifier: str, normalized: UploadFile = File(), file: UploadFile | None = File(default=None), cuts: UploadFile | None = File(default=None),
                     capture_id: str = Form(), side: str = Form(), sequence: int = Form(), manifest: str = Form(), current=Depends(scan_admin)):
    try:
        capture_id = str(UUID(capture_id))
        if len(manifest) > 2 * 1024 * 1024: raise ValueError('识读清单过大')
        result = json.loads(manifest)
        if not isinstance(result, dict): raise ValueError('识读结果无效')
    except (ValueError, TypeError): raise HTTPException(422, '捕获编号或识读清单无效')
    if side not in ('front', 'back') or sequence < 1: raise HTTPException(422, '扫描面或顺序无效')
    jobs = []; written = []
    try:
        with connect() as db:
            db.execute('BEGIN IMMEDIATE'); batch, group, template = batch_context(db, identifier, current)
            width, height = dimensions(template)
            if side == 'back' and template['sides'] != 2: raise HTTPException(422, '单面题卡不接受背面')
            sheet_only = result.get('upload_format') == 'jpeg-sheet-1'
            if result.get('upload_format') not in (None,'jpeg-sheet-1'): raise HTTPException(422,'上传图片格式版本无效')
            if sheet_only and (file is not None or cuts is not None): raise HTTPException(422,'整页JPEG上传只接受校正图')
            if not sheet_only and (file is None or cuts is None): raise HTTPException(422,'扫描上传缺少原图或切题包，请更新扫描端')
            original = None if sheet_only else image_bytes(file)
            corrected = image_bytes(normalized, (width * 4, height * 4), 'JPEG' if sheet_only else 'PNG')
            packed = b'' if sheet_only else cuts.file.read(LIMIT + 1)
            if len(packed) > LIMIT: raise HTTPException(413, '切题包超过30MB')
            try: verify_result(template, side, result, original, corrected, packed)
            except (TypeError, KeyError, cv2.error): raise HTTPException(422, '本地识读清单结构无效')
            existing = get(db, capture_id, 'pages')
            correction=result.get('operator_correction')
            if 'operator_correction' in result:
                if statistics_sheet.enabled(template):raise HTTPException(422,'统计答卷使用匿名识读')
                if side!='front' or not isinstance(correction,dict) or not isinstance(correction.get('original_number'),str) or len(correction['original_number'])>11 or type(correction.get('original_absent')) is not bool:
                    raise HTTPException(422,'人工更正记录无效')
                correction={k:correction[k] for k in ('original_number','original_absent')}
                if existing and (existing.get('candidate_number')!=result['candidate_number'] or existing.get('absent_mark')!=result['absent_mark'] or existing.get('operator_correction')!=correction):
                    raise HTTPException(409,'页面已上传，请在管理后台核查')
                if not existing:
                    from .school import group_students
                    roster_members = group_students(db,group) or []
                    is_open_roster = group.get('roster_mode') == 'open' or not roster_members
                    allowed_students = objects(db, 'students') if is_open_roster else roster_members
                    if not any(s['candidate_number']==result['candidate_number'] for s in allowed_students):
                        raise HTTPException(422,'更正的准考证号不在当前题卡名单中')
                    if any(s.get('pages') or s.get('status')=='absent' for s in find(db,'submissions',group_id=group['id'],candidate_number=result['candidate_number'])):
                        raise HTTPException(409,'此考生已有答卷')
            if existing:
                fields = [('batch_id', identifier), ('side', side), ('sequence', sequence), ('sha256', result['source_sha256']), ('normalized_sha256', result['normalized_sha256']), ('upload_format', result.get('upload_format'))]
                if not sheet_only: fields.append(('local_cuts_sha256', result['local_cuts_sha256']))
                if any(existing.get(k) != value for k, value in fields): raise HTTPException(409, '捕获编号已用于其他页面内容')
                return existing
            if group.get('template_id')!=template['id']:raise HTTPException(409,'本批次题卡已更换，请使用当前正式题卡新建批次')
            if batch['status'] in ('paired', 'frozen'): raise HTTPException(409, '批次已确认或冻结')
            if any(p['side'] == side and p['sequence'] == sequence and not p.get('excluded') for p in find(db, 'pages', batch_id=identifier)): raise HTTPException(409, '该顺序已有页面，请先排除原页面')
            from .scan_files import write_atomic
            outputs = (('.jpg', corrected),) if sheet_only else (('.image', original), ('.png', corrected), ('.cuts.zip', packed))
            for suffix, content in outputs:
                relative = 'pages/' + capture_id + suffix; path = local_path(relative)
                write_atomic(path, content); written.append(path)
            page = put(db, 'pages', {'id': capture_id, 'batch_id': identifier, 'side': side, 'sequence': sequence, 'status': 'recognized',
                                   'sha256': result['source_sha256'], 'normalized_sha256': result['normalized_sha256'],
                                   **({'upload_format':'jpeg-sheet-1'} if sheet_only else {'local_cuts_sha256': result['local_cuts_sha256'], 'local_cuts_normalized_sha256': result['normalized_sha256'], 'local_cuts':result['cuts']}),
                                   **({'operator_correction':correction,'corrected_by':current['id']} if correction else {}),
                                   'candidate_number': result['candidate_number'], 'selections': result['selections'],
                                   'absent_mark': verified_absence(template,side,result,corrected), 'recognition_engine': result['engine_version'], 'recognition_source': 'device',
                                   'image_url': f'/api/v1/pages/{capture_id}/image'}, current['id'])
            from .anomalies import check_candidate
            check_candidate(db, page, current['id'])
            # Auto-enroll matched school students into the group's open roster on scan upload.
            if side == 'front' and result.get('candidate_number') and '?' not in result['candidate_number']:
                from .school import group_students, student_view
                from .candidate_numbers import by_number
                roster_members = group_students(db, group) or []
                is_open_roster = group.get('roster_mode') == 'open' or not roster_members
                if is_open_roster:
                    matched_student = by_number(objects(db, 'students')).get(result['candidate_number'])
                    if matched_student is not None:
                        existing_map = {s['id']: s for s in roster_members}
                        if matched_student['id'] not in existing_map:
                            existing_map[matched_student['id']] = student_view(db, matched_student)
                            merged_ids = list(existing_map.keys())
                            old_roster = get(db, group.get('roster_id'), 'rosters') or {}
                            roster_body = {
                                'group_id': group['id'],
                                'source': old_roster.get('source', 'scan'),
                                'class_ids': [],
                                'students': list(existing_map.values()),
                                'student_ids': merged_ids,
                                'supplemental_ids': old_roster.get('supplemental_ids', []),
                            }
                            if group.get('roster_id'):
                                roster_body['id'] = group['roster_id']
                            saved_roster = put(db, 'rosters', roster_body, current['id'])
                            group = put(db, 'groups', {**group, 'roster_mode': 'open', 'roster_id': saved_roster['id'], 'expected_students': len(merged_ids)}, current['id'])
            from .jobs import create_job
            from .storage import Storage
            subject = require(db, group['subject_id'], 'subjects')
            if Storage(project_id=subject['project_id']).kind != 'local':
                for path in written: jobs.append(create_job(db, 'mirror', {'relative': 'pages/' + path.name, 'project_id': subject['project_id']}, subject['project_id'], current['id']))
    except BaseException:
        for path in written: path.unlink(missing_ok=True)
        raise
    from .jobs import dispatch
    for job in jobs: dispatch(job['id'], background=True)
    return page


@router.post('/batches/{identifier}/exclude')
def exclude(identifier: str, body: dict, current=Depends(scan_admin)):
    ids = body.get('page_ids', []); reason = body.get('reason', '')
    if not isinstance(ids, list) or not 1 <= len(ids) <= 2 or not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 1000: raise HTTPException(422, '请提供整张纸的页面和排除原因')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE'); batch, _, _ = batch_context(db, identifier, current)
        if batch['status'] == 'paired': raise HTTPException(409, '批次已配页，请在管理端补扫替换')
        for value in ids:
            page = get(db, value, 'pages')
            if page is None: continue
            if page['batch_id'] != identifier or page.get('linked_submission_id'): raise HTTPException(409, '页面已关联其他业务记录')
            page.update(excluded=True, exclusion_reason=reason.strip()); put(db, 'pages', page, current['id'])
    return {'excluded': ids}


def local_piece(page_id, question_id, region, normalized_sha256=None):
    with connect() as db: page = get(db, page_id, 'pages')
    if not page or not page.get('local_cuts_sha256'): return None
    expected = normalized_sha256 or page.get('normalized_sha256')
    if expected != page.get('local_cuts_normalized_sha256'): return None
    entry = next((e for e in page['local_cuts'] if e['question_id'] == question_id and e['region'] == region), None)
    if not entry: return None
    from .storage import materialize
    with zipfile.ZipFile(materialize('pages/' + page_id + '.cuts.zip')) as package: content = package.read(entry['entry'])
    if checksum(content) != entry['sha256']: raise HTTPException(409, '本地切题图校验失败，请核查扫描归档')
    return content
