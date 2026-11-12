"""Archive, verify, remove scoped scans, then retire an exam hierarchy."""
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
FILE_JOBS = ('archive-project', 'preview-release', 'release-project', 'restore-archive', 'delete-hierarchy')
POLICY = 'archive-and-remove-scans-v1'


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
        AND json_extract(body,'$.kind')!='delete-hierarchy'
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
    lock = db.execute('SELECT plan_id FROM deletion_locks WHERE project_id=?', (project['id'],)).fetchone()
    if lock: blockers.append({'id': lock['plan_id'], 'reason': '本考试已有删除任务，请等待完成或重试原任务'})
    from .jobs import job_project
    for row in db.execute("SELECT body FROM objects WHERE kind='jobs' AND deleted=0 AND json_extract(body,'$.status')='running' AND json_extract(body,'$.kind')!='delete-hierarchy'"):
        job = json.loads(row['body'])
        if job_project(db,job)==project['id'] and job['id'] not in {b['id'] for b in blockers}:
            blockers.append({'id':job['id'],'reason':f"本考试后台任务正在执行：{job['kind']}"})
    # Ancestor storage leases are outside a subgroup's owned records.
    digest.update(json.dumps(project.get('storage_operation', {}), sort_keys=True).encode())
    return {
        'target': {'id': identifier, 'kind': kind, 'name': target['name']}, 'project_id': project['id'], 'path': path,
        'counts': [{'kind': key, 'label': label, 'count': counts[key]} for key, label in LABELS.items() if counts.get(key)],
        'record_count': totals['objects'], 'question_count': db.execute('SELECT COUNT(*) FROM deletion_questions').fetchone()[0],
        'retained_score_history': totals['scores'], 'retained_score_results': totals['review_results'],
        'runtime_allocations': totals['review_allocations'], 'runtime_regrades': totals['regrade_queue'],
        'retained_archives': db.execute("SELECT COUNT(*) FROM objects WHERE kind='archives' AND deleted=0 AND json_extract(body,'$.project_id')=?", (project['id'],)).fetchone()[0],
        'scan_pages': counts.get('pages',0),
        'cancel_pending_jobs': totals['jobs'] - db.execute("SELECT COUNT(*) FROM deletion_jobs j JOIN objects o ON o.id=j.id WHERE json_extract(o.body,'$.status')='running'").fetchone()[0],
        'invalidate_release_plans': len(release_plans), 'blockers': blockers, 'fingerprint': digest.hexdigest(),
    }, release_plans, subject


def public(plan):
    return {key: value for key, value in plan.items() if key not in ('fingerprint','locked_fingerprint')}


@router.post('/{kind}/{identifier}/deletion-preview')
def preview(kind: Hierarchy, identifier: str, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        value, _, _ = information(db, kind, identifier)
        lock=db.execute('SELECT plan_id FROM deletion_locks WHERE project_id=?',(value['project_id'],)).fetchone()
        if lock:return public(require(db,lock['plan_id'],'deletion-plans'))
        plan = put(db, 'deletion-plans', {**value, 'policy':POLICY,'actor': current['id'], 'status': 'preview', 'created_at': time.time(), 'expires_at': time.time() + 600}, current['id'])
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
                if value['fingerprint'] != plan.get('locked_fingerprint',plan['fingerprint']): raise HTTPException(409, '数据已变化，请重新预览删除范围')
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


def cancel_related(db, identifier, actor, release_plans):
    for row in db.execute('SELECT body FROM objects WHERE id IN (SELECT id FROM deletion_jobs)').fetchall():
        job = json.loads(row['body'])
        job.update(status='failed', lease_until=0, cancelled_by_deletion=identifier, error='hierarchy_deleted', error_detail='考试层级正在删除，原任务已取消')
        job.pop('run_token', None); put(db, 'jobs', job, actor)
    for item in release_plans:
        item.update(expires_at=0, invalidated_by_deletion=identifier)
        put(db, 'release-plans', item, actor)


@router.post('/deletion-plans/{identifier}/confirm',status_code=202)
def confirm(identifier: str, body: dict, current=Depends(admin)):
    if body.get('confirm') is not True: raise HTTPException(422, '请核对影响范围并确认删除')
    reason = body.get('reason', '')
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 1000: raise HTTPException(422, '请填写1000字以内删除原因')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        plan = require(db, identifier, 'deletion-plans')
        if plan['actor'] != current['id']: raise HTTPException(403, '请由生成预览的管理员确认删除')
        if plan.get('policy') != POLICY: raise HTTPException(409,'删除策略已更新，请重新预览并核对扫描文件清理范围')
        if plan['status'] != 'preview': return public(plan)
        if plan['expires_at'] < time.time(): raise HTTPException(409, '删除预览已过期，请重新预览')
        value, release_plans, subject = information(db, plan['target']['kind'], plan['target']['id'])
        if value['blockers']: raise HTTPException(409, value['blockers'][0]['reason'])
        if value['fingerprint'] != plan['fingerprint']: raise HTTPException(409, '扫描、评分或关联记录已变化，请重新预览删除范围')
        db.execute('INSERT INTO deletion_locks VALUES(?,?,?)',(plan['project_id'],identifier,time.time()))
        cancel_related(db,identifier,current['id'],release_plans)
        from .jobs import create_job
        job=create_job(db,'delete-hierarchy',{'plan_id':identifier},plan['project_id'],current['id'])
        value,_,_=information(db,plan['target']['kind'],plan['target']['id'])
        plan.update(status='queued',reason=reason.strip(),confirmed_at=time.time(),locked_fingerprint=value['fingerprint'],job_id=job['id'],archive_id=str(uuid4()))
        put(db,'deletion-plans',plan,current['id'])
    from .jobs import dispatch
    dispatch(job['id'],background=True)
    return public(plan)


def validate_archive(db,plan,data):
    """Prove the archive includes the final owned records and scoring evidence."""
    archived={r['data']['id']:r for r in data['records']}
    for row in db.execute('SELECT o.id,o.kind,o.body FROM objects o JOIN deletion_scope s ON s.id=o.id'):
        item=archived.get(row['id'])
        if not item or item['kind']!=row['kind'] or item['data']!=json.loads(row['body']):
            raise HTTPException(409,'归档未覆盖当前业务记录：'+row['id'])
    for name,key,sql in (
        ('score_history','id','SELECT * FROM scores WHERE task_id IN (SELECT id FROM deletion_scope)'),
        ('review_results',None,'SELECT * FROM review_results WHERE submission_id IN (SELECT id FROM deletion_scope)'),
    ):
        evidence={r[key] if key else (r['submission_id'],r['question_id']):r for r in data.get(name,[])}
        for row in db.execute(sql):
            record=dict(row);identifier=record[key] if key else (record['submission_id'],record['question_id'])
            if evidence.get(identifier)!=record:raise HTTPException(409,'归档未覆盖当前评分记录')


def unchanged(db,plan,ownership):
    from .jobs import guard
    guard(db,ownership)
    value,_,subject=information(db,plan['target']['kind'],plan['target']['id'])
    if value['fingerprint']!=plan['locked_fingerprint']:raise HTTPException(409,'删除期间业务快照已变化，请核查原任务')
    lock=db.execute('SELECT plan_id FROM deletion_locks WHERE project_id=?',(plan['project_id'],)).fetchone()
    if not lock or lock['plan_id']!=plan['id']:raise HTTPException(409,'删除任务锁已失效')
    return subject


def prepare_files(db,plan,manifest):
    from .storage import backend,location,local_path
    entries={e['path']:e for e in manifest}
    files=[]
    for row in db.execute("SELECT o.body FROM objects o JOIN deletion_scope s ON s.id=o.id WHERE o.kind='pages'"):
        page=json.loads(row['body'])
        from .scan_files import page_suffixes
        for suffix in page_suffixes(page):
            relative='pages/'+page['id']+suffix;entry=entries.get(relative);path=local_path(relative)
            refs=[json.loads(r['body']) for r in db.execute("SELECT body FROM objects WHERE kind='storage-assets' AND deleted=0 AND json_extract(body,'$.relative')=? AND json_extract(body,'$.status')='stored'",(relative,))]
            if entry is None:
                if suffix=='.image' or path.exists() or refs or page.get('normalized_sha256'):raise HTTPException(409,'归档缺少扫描文件：'+relative)
                continue
            if any(r['backend']!=backend() or r.get('location')!=location() for r in refs):raise HTTPException(409,'远端扫描文件位置与当前配置不一致，请恢复相应存储配置后重试')
            # Remote keys must be scoped to this exact project and scan file.
            if any(r['key'] not in (relative,'projects/'+plan['project_id']+'/'+relative) or r.get('project_id') not in (None,plan['project_id']) for r in refs):raise HTTPException(409,'远端扫描文件归属不一致')
            files.append((plan['id'],relative,entry['sha256'],entry['size'],json.dumps(refs,ensure_ascii=False)))
    db.executemany('INSERT INTO deletion_files(plan_id,relative,sha256,size,remote_refs) VALUES(?,?,?,?,?)',files)
    plan.update(files_prepared=True,file_count=len(files),remote_files=sum(bool(json.loads(f[4])) for f in files))
    put(db,'deletion-plans',plan,plan['actor'])


def preflight_files(files,manifest):
    from .archive import checksum
    from .storage import local_path,backend,location
    entries={e['path']:e for e in manifest}
    for item in files:
        entry=entries.get(item['relative'])
        if not entry or entry['sha256']!=item['sha256'] or entry['size']!=item['size']:raise HTTPException(409,'归档扫描清单校验失败')
        path=local_path(item['relative'])
        if path.exists() and (path.stat().st_size!=item['size'] or checksum(path)!=item['sha256']):raise HTTPException(409,'本地扫描文件与归档不一致：'+item['relative'])
        for remote in json.loads(item['remote_refs']):
            if remote['backend']!=backend() or remote.get('location')!=location():raise HTTPException(409,'远端存储配置已变化，请恢复原配置后重试')


def retire(db,plan,subject):
    identifier=plan['id'];actor=plan['actor'];reason=plan['reason']
    deleted_at = time.time()
    db.create_function('deletion_uuid', 0, lambda: str(uuid4()))
    patch = "json_set(body,'$.deletion_plan_id',?,'$.deleted_at',?,'$.deletion_reason',?)"
    parameters = (identifier, deleted_at, reason)
    db.execute('INSERT INTO audit(id,actor,action,object_id,body) SELECT deletion_uuid(),?,\'delete\',id,' + patch + ' FROM objects WHERE id IN (SELECT id FROM deletion_scope)', (actor, *parameters))
    db.execute('UPDATE objects SET deleted=1,body=' + patch + ' WHERE id IN (SELECT id FROM deletion_scope)', parameters)
    db.execute('DELETE FROM regrade_queue WHERE template_id IN (SELECT id FROM deletion_scope)')
    db.execute('DELETE FROM review_allocations WHERE template_id IN (SELECT id FROM deletion_scope)')
    db.execute('DELETE FROM allocation_state WHERE question_id IN (SELECT id FROM deletion_questions)')
    if plan['target']['kind'] == 'projects':
        for row in db.execute("SELECT body FROM objects WHERE kind='archives' AND deleted=0 AND json_extract(body,'$.project_id')=?", (plan['project_id'],)).fetchall():
            archive = json.loads(row['body'])
            archive.update(project_deleted=True, project_name=plan['target']['name'])
            put(db, 'archives', archive, actor)
    if subject and subject.get('default_group_id') == plan['target']['id']:
        subject.pop('default_group_id'); put(db, 'subjects', subject, actor)
    db.execute('DELETE FROM deletion_locks WHERE project_id=? AND plan_id=?',(plan['project_id'],identifier))
    plan.update(status='completed', completed_at=deleted_at,phase='已完成')
    return public(put(db, 'deletion-plans', plan, actor))

def perform(job,progress):
    from .archive import create,verify
    from .lifecycle import operation
    from .storage import Storage,local_path
    ownership=(job['id'],job['run_token']);identifier=job['payload']['plan_id']
    with operation(identifier,ownership):
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');plan=require(db,identifier,'deletion-plans')
            if plan['status']=='completed':return public(plan)
            unchanged(db,plan,ownership)
            plan.update(status='running',phase='生成并校验归档');put(db,'deletion-plans',plan,job['actor'])
        create(plan['project_id'],plan['actor'],progress,plan['archive_id'],ownership,preserve_status=True)
        archive,manifest,data=verify(plan['archive_id'],progress)
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');unchanged(db,plan,ownership);validate_archive(db,plan,data)
            if not plan.get('files_prepared'):prepare_files(db,plan,manifest)
            files=[dict(r) for r in db.execute('SELECT * FROM deletion_files WHERE plan_id=? ORDER BY relative',(identifier,))]
        # Validate every file and location before the first destructive call.
        preflight_files(files,manifest)
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');unchanged(db,plan,ownership)
            plan.update(phase='清理本地及远端扫描图片');put(db,'deletion-plans',plan,plan['actor'])
        for index,item in enumerate(files):
            if progress:progress(index,len(files),'清理本地及远端扫描图片')
            if item['done']:continue
            with connect() as db:
                from .jobs import guard
                guard(db,ownership)
            # Repeating DELETE after a crash is safe; adapters accept missing keys.
            for remote in json.loads(item['remote_refs']):Storage().delete(remote['key'])
            local_path(item['relative']).unlink(missing_ok=True)
            with connect() as db:
                db.execute('BEGIN IMMEDIATE');guard(db,ownership)
                for remote in json.loads(item['remote_refs']):
                    saved=require(db,remote['id'],'storage-assets')
                    saved.update(status='archived',archive_id=archive['id'],deletion_plan_id=identifier)
                    put(db,'storage-assets',saved,plan['actor'])
                db.execute('UPDATE deletion_files SET done=1 WHERE plan_id=? AND relative=?',(identifier,item['relative']))
        if progress:progress(len(files),len(files),'移除业务记录')
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');subject=unchanged(db,plan,ownership)
            return retire(db,plan,subject)
