"""Preview and atomically retire an exam hierarchy while retaining its evidence."""
import hashlib
import json
from pathlib import Path
import tempfile
import time
from typing import Literal
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from .db import connect, get, put
from .dependencies import admin, require

router = APIRouter(prefix='/api/v1')
Hierarchy = Literal['projects', 'subjects', 'groups']
LABELS = {
    'projects': '考试项目', 'subjects': '科目', 'groups': '题卡组', 'templates': '题卡',
    'scan-batches': '扫描批次', 'pages': '扫描页面', 'rosters': '应考名单',
    'submissions': '答卷', 'assignments': '教师分配', 'tasks': '阅卷任务',
    'answer-slices': '答题图版本', 'exceptions': '异常与优秀卷记录',
    'page-alignments': '页面定位记录', 'publication-events': '成绩发布记录', 'regrade-events': '重阅记录',
}
# Follow ownership only. Shared students, accounts, assets, libraries and archives
# must not be pulled into the hierarchy just because a record references them.
CHILDREN = (
    ('subjects', ('project_id',)), ('groups', ('subject_id',)),
    ('templates', ('group_id',)), ('scan-batches', ('group_id',)), ('rosters', ('group_id',)),
    ('pages', ('batch_id',)), ('submissions', ('group_id',)),
    ('assignments', ('template_id',)), ('tasks', ('template_id', 'submission_id')),
    ('answer-slices', ('group_id', 'template_id', 'submission_id')),
    ('exceptions', ('group_id', 'batch_id', 'page_id', 'submission_id', 'task_id')),
    ('page-alignments', ('page_id',)), ('publication-events', ('group_id',)),
    ('regrade-events', ('template_id', 'task_id')),
)
FILE_JOBS = ('archive-project', 'preview-release', 'release-project', 'restore-archive')


def scope(db, kind, identifier):
    target = require(db, identifier, kind)
    subject = require(db, target['subject_id'], 'subjects') if kind == 'groups' else target if kind == 'subjects' else None
    project = require(db, subject['project_id'], 'projects') if subject else target
    path = [project['name']] + ([subject['name']] if subject else []) + ([target['name']] if kind == 'groups' else [])
    statements = '''
        DROP TABLE IF EXISTS temp.deletion_scope;
        DROP TABLE IF EXISTS temp.deletion_questions;
        DROP TABLE IF EXISTS temp.deletion_jobs;
        CREATE TEMP TABLE deletion_scope(id TEXT PRIMARY KEY,kind TEXT NOT NULL);
        CREATE TEMP TABLE deletion_questions(id TEXT PRIMARY KEY);
        CREATE TEMP TABLE deletion_jobs(id TEXT PRIMARY KEY);
    '''
    for statement in statements.split(';'):
        if statement.strip(): db.execute(statement)
    db.execute('INSERT INTO deletion_scope VALUES(?,?)', (identifier, kind))
    for child, fields in CHILDREN:
        condition = ' OR '.join("json_extract(body,'$." + field + "') IN (SELECT id FROM deletion_scope)" for field in fields)
        db.execute('INSERT OR IGNORE INTO deletion_scope SELECT id,kind FROM objects WHERE deleted=0 AND kind=? AND (' + condition + ')', (child,))
    db.execute("INSERT OR IGNORE INTO deletion_questions SELECT json_extract(q.value,'$.id') FROM objects t JOIN deletion_scope s ON s.id=t.id,json_each(t.body,'$.questions') q WHERE t.kind='templates'")
    db.execute('''INSERT INTO deletion_jobs
        SELECT id FROM objects WHERE kind='jobs' AND deleted=0
        AND json_extract(body,'$.status') IN ('pending','running') AND (
          json_extract(body,'$.payload.page_id') IN (SELECT id FROM deletion_scope)
          OR (substr(json_extract(body,'$.payload.relative'),1,6)='pages/' AND substr(json_extract(body,'$.payload.relative'),7,36) IN (SELECT id FROM deletion_scope))
          OR ((json_extract(body,'$.project_id')=? OR json_extract(body,'$.payload.project_id')=?) AND (?='projects' OR json_extract(body,'$.kind') IN ('archive-project','preview-release','release-project','restore-archive')))
        )''', (project['id'], project['id'], kind))
    return target, project, subject, path


def information(db, kind, identifier):
    target, project, subject, path = scope(db, kind, identifier)
    digest = hashlib.sha256()
    counts = {row['kind']: row['n'] for row in db.execute('SELECT kind,COUNT(*) AS n FROM deletion_scope GROUP BY kind')}
    tables = (
        ('objects', 'SELECT o.id,o.kind,o.body FROM objects o JOIN deletion_scope s ON s.id=o.id ORDER BY o.id'),
        ('scores', 'SELECT * FROM scores WHERE task_id IN (SELECT id FROM deletion_scope) ORDER BY id'),
        ('review_results', 'SELECT * FROM review_results WHERE submission_id IN (SELECT id FROM deletion_scope) ORDER BY submission_id,question_id'),
        ('review_allocations', 'SELECT * FROM review_allocations WHERE template_id IN (SELECT id FROM deletion_scope) ORDER BY submission_id,question_id,round'),
        ('allocation_state', 'SELECT * FROM allocation_state WHERE question_id IN (SELECT id FROM deletion_questions) ORDER BY question_id'),
        ('regrade_queue', 'SELECT * FROM regrade_queue WHERE template_id IN (SELECT id FROM deletion_scope) ORDER BY task_id'),
        ('jobs', 'SELECT o.id,o.body FROM objects o JOIN deletion_jobs s ON s.id=o.id ORDER BY o.id'),
    )
    totals = {}
    for name, sql in tables:
        digest.update(name.encode()); count = 0
        for row in db.execute(sql):
            digest.update(json.dumps(dict(row), ensure_ascii=False, separators=(',', ':')).encode()); digest.update(b'\n'); count += 1
        totals[name] = count
    release_plans = []
    for row in db.execute("SELECT body FROM objects WHERE kind='release-plans' AND deleted=0 AND json_extract(body,'$.project_id')=? AND json_extract(body,'$.status')!='completed' AND json_extract(body,'$.invalidated_by_deletion') IS NULL ORDER BY id", (project['id'],)):
        release_plans.append(json.loads(row['body']))
        digest.update(row['body'].encode())
    blockers = []
    for row in db.execute("SELECT o.id,o.body FROM objects o JOIN deletion_jobs s ON s.id=o.id WHERE json_extract(o.body,'$.status')='running'"):
        job = json.loads(row['body']); blockers.append({'id': row['id'], 'reason': f"后台任务正在执行：{job['kind']}"})
    if project.get('storage_operation', {}).get('until', 0) > time.time():
        blockers.append({'id': project['id'], 'reason': '项目正在释放扫描文件，请等待操作结束'})
    # Ancestor storage leases are outside a subgroup's owned records.
    digest.update(json.dumps(project.get('storage_operation', {}), sort_keys=True).encode())
    return {
        'target': {'id': identifier, 'kind': kind, 'name': target['name']}, 'project_id': project['id'], 'path': path,
        'counts': [{'kind': key, 'label': label, 'count': counts[key]} for key, label in LABELS.items() if counts.get(key)],
        'record_count': totals['objects'], 'question_count': db.execute('SELECT COUNT(*) FROM deletion_questions').fetchone()[0],
        'retained_score_history': totals['scores'], 'retained_score_results': totals['review_results'],
        'runtime_allocations': totals['review_allocations'], 'runtime_regrades': totals['regrade_queue'],
        'retained_archives': db.execute("SELECT COUNT(*) FROM objects WHERE kind='archives' AND deleted=0 AND json_extract(body,'$.project_id')=?", (project['id'],)).fetchone()[0],
        'cancel_pending_jobs': totals['jobs'] - len([b for b in blockers if b['id'] != project['id']]),
        'invalidate_release_plans': len(release_plans), 'blockers': blockers, 'fingerprint': digest.hexdigest(),
    }, release_plans, subject


def public(plan):
    return {key: value for key, value in plan.items() if key != 'fingerprint'}


@router.post('/{kind}/{identifier}/deletion-preview')
def preview(kind: Hierarchy, identifier: str, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        value, _, _ = information(db, kind, identifier)
        plan = put(db, 'deletion-plans', {**value, 'actor': current['id'], 'status': 'preview', 'created_at': time.time(), 'expires_at': time.time() + 600}, current['id'])
    return public(plan)


@router.get('/deletion-plans/{identifier}')
def details(identifier: str, current=Depends(admin)):
    with connect() as db: return public(require(db, identifier, 'deletion-plans'))


@router.get('/deletion-plans/{identifier}/manifest')
def manifest(identifier: str, current=Depends(admin)):
    # Write a consistent read snapshot before sending response headers. Large
    # manifests stay out of both the plan/audit rows and API process memory.
    path = None
    try:
        with connect() as db:
            db.execute('BEGIN')
            plan = require(db, identifier, 'deletion-plans')
            if plan['status'] == 'completed':
                sql = "SELECT id,kind,json_extract(body,'$.name') AS name FROM objects WHERE deleted=1 AND json_extract(body,'$.deletion_plan_id')=? ORDER BY kind,id"
                rows = db.execute(sql, (identifier,))
            else:
                value, _, _ = information(db, plan['target']['kind'], plan['target']['id'])
                if value['fingerprint'] != plan['fingerprint']: raise HTTPException(409, '数据已变化，请重新预览删除范围')
                rows = db.execute("SELECT o.id,o.kind,json_extract(o.body,'$.name') AS name FROM objects o JOIN deletion_scope s ON s.id=o.id ORDER BY o.kind,o.id")
            with tempfile.NamedTemporaryFile(prefix='omp-deletion-', suffix='.json', mode='w', encoding='utf-8', delete=False) as output:
                path = Path(output.name)
                output.write('{"summary":' + json.dumps(public(plan), ensure_ascii=False) + ',"target":' + json.dumps(plan['target'], ensure_ascii=False) + ',"records":[')
                separator = ''
                for row in rows:
                    output.write(separator + json.dumps(dict(row), ensure_ascii=False)); separator = ','
                output.write(']')
                def append_rows(name, cursor):
                    output.write(',"' + name + '":['); separator = ''
                    for row in cursor:
                        output.write(separator + json.dumps(dict(row), ensure_ascii=False)); separator = ','
                    output.write(']')
                if plan['status'] == 'completed':
                    append_rows('questions', db.execute("SELECT json_extract(q.value,'$.id') AS id,t.id AS template_id FROM objects t,json_each(t.body,'$.questions') q WHERE t.kind='templates' AND t.deleted=1 AND json_extract(t.body,'$.deletion_plan_id')=? ORDER BY t.id,1", (identifier,)))
                    append_rows('background_tasks', db.execute("SELECT id,json_extract(body,'$.kind') AS kind FROM objects WHERE kind='jobs' AND json_extract(body,'$.cancelled_by_deletion')=? ORDER BY id", (identifier,)))
                    append_rows('release_plans', db.execute("SELECT id FROM objects WHERE kind='release-plans' AND json_extract(body,'$.invalidated_by_deletion')=? ORDER BY id", (identifier,)))
                else:
                    append_rows('questions', db.execute("SELECT json_extract(q.value,'$.id') AS id,t.id AS template_id FROM objects t JOIN deletion_scope s ON s.id=t.id,json_each(t.body,'$.questions') q WHERE t.kind='templates' ORDER BY t.id,1"))
                    append_rows('background_tasks', db.execute("SELECT o.id,json_extract(o.body,'$.kind') AS kind FROM objects o JOIN deletion_jobs j ON j.id=o.id ORDER BY o.id"))
                    append_rows('release_plans', db.execute("SELECT id FROM objects WHERE kind='release-plans' AND deleted=0 AND json_extract(body,'$.project_id')=? AND json_extract(body,'$.status')!='completed' AND json_extract(body,'$.invalidated_by_deletion') IS NULL ORDER BY id", (plan['project_id'],)))
                output.write('}')
        return FileResponse(path, media_type='application/json', filename='deletion-manifest.json', headers={'Cache-Control': 'no-store'}, background=BackgroundTask(path.unlink, missing_ok=True))
    except BaseException:
        if path: path.unlink(missing_ok=True)
        raise


@router.post('/deletion-plans/{identifier}/confirm')
def confirm(identifier: str, body: dict, current=Depends(admin)):
    if body.get('confirm') is not True: raise HTTPException(422, '请核对影响范围并确认删除')
    reason = body.get('reason', '')
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 1000: raise HTTPException(422, '请填写1000字以内删除原因')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        plan = require(db, identifier, 'deletion-plans')
        if plan['actor'] != current['id']: raise HTTPException(403, '请由生成预览的管理员确认删除')
        if plan['status'] == 'completed': return public(plan)
        if plan['expires_at'] < time.time(): raise HTTPException(409, '删除预览已过期，请重新预览')
        value, release_plans, subject = information(db, plan['target']['kind'], plan['target']['id'])
        if value['blockers']: raise HTTPException(409, value['blockers'][0]['reason'])
        if value['fingerprint'] != plan['fingerprint']: raise HTTPException(409, '扫描、评分或关联记录已变化，请重新预览删除范围')
        deleted_at = time.time()
        db.create_function('deletion_uuid', 0, lambda: str(uuid4()))
        patch = "json_set(body,'$.deletion_plan_id',?,'$.deleted_at',?,'$.deletion_reason',?)"
        parameters = (identifier, deleted_at, reason.strip())
        db.execute('INSERT INTO audit(id,actor,action,object_id,body) SELECT deletion_uuid(),?,\'delete\',id,' + patch + ' FROM objects WHERE id IN (SELECT id FROM deletion_scope)', (current['id'], *parameters))
        db.execute('UPDATE objects SET deleted=1,body=' + patch + ' WHERE id IN (SELECT id FROM deletion_scope)', parameters)
        db.execute('DELETE FROM regrade_queue WHERE template_id IN (SELECT id FROM deletion_scope)')
        db.execute('DELETE FROM review_allocations WHERE template_id IN (SELECT id FROM deletion_scope)')
        db.execute('DELETE FROM allocation_state WHERE question_id IN (SELECT id FROM deletion_questions)')
        for row in db.execute('SELECT body FROM objects WHERE id IN (SELECT id FROM deletion_jobs)').fetchall():
            job = json.loads(row['body'])
            job.update(status='failed', lease_until=0, cancelled_by_deletion=identifier, error='hierarchy_deleted', error_detail='考试层级已删除或变更，请在有效考试中重新提交任务')
            job.pop('run_token', None); put(db, 'jobs', job, current['id'])
        for item in release_plans:
            item.update(expires_at=0, invalidated_by_deletion=identifier)
            put(db, 'release-plans', item, current['id'])
        if plan['target']['kind'] == 'projects':
            for row in db.execute("SELECT body FROM objects WHERE kind='archives' AND deleted=0 AND json_extract(body,'$.project_id')=?", (plan['project_id'],)).fetchall():
                archive = json.loads(row['body'])
                archive.update(project_deleted=True, project_name=plan['target']['name'])
                put(db, 'archives', archive, current['id'])
        if subject and subject.get('default_group_id') == plan['target']['id']:
            subject.pop('default_group_id'); put(db, 'subjects', subject, current['id'])
        plan.update(status='completed', completed_at=deleted_at, reason=reason.strip())
        return public(put(db, 'deletion-plans', plan, current['id']))
