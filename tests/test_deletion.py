from workflow_helpers import close_scanning
import hashlib
import io
import json
import time
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from server import db, deletion, jobs, storage
from server.identifiers import IdentifierConflict
from server.main import app


def post(client, path, body, headers):
    response = client.post('/api/v1/' + path, json=body, headers=headers)
    if path.endswith('/confirm'):
        assert response.status_code == 202, response.text
        plan=response.json();jobs.execute(plan['job_id'])
        response=client.get('/api/v1/deletion-plans/'+plan['id'],headers=headers)
        assert response.json()['status']=='completed',client.get('/api/v1/jobs/'+plan['job_id'],headers=headers).text
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(autouse=True)
def durable_queue(monkeypatch):
    monkeypatch.setenv('OMP_TASK_MODE','celery')
    monkeypatch.setattr(jobs.run,'apply_async',lambda **kwargs:None)


def admin_login(client):
    account = {'username': 'admin', 'password': 'administrator-password', 'name': '管理员'}
    client.post('/api/v1/auth/bootstrap', json=account)
    logged = client.post('/api/v1/auth/login', json=account).json()
    return {'Authorization': 'Bearer ' + logged['token']}, logged['user']


@pytest.fixture
def populated(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setenv('OMP_TASK_MODE', 'celery')
    monkeypatch.setattr(jobs.run, 'apply_async', lambda **kwargs: None)
    with TestClient(app, raise_server_exceptions=False) as client:
        headers, owner = admin_login(client)
        project = post(client, 'projects', {'name': '期中考试'}, headers)
        subject = post(client, 'subjects', {'project_id': project['id'], 'name': '语文', 'group_mode': 'custom'}, headers)
        group = post(client, 'groups', {'subject_id': subject['id'], 'name': '一中'}, headers)
        cls = post(client, 'classes', {'name': '一班', 'grade': '10'}, headers)
        student = post(client, 'students', {'name': '学生', 'candidate_number': '123', 'class_id': cls['id']}, headers)
        teacher = post(client, 'users', {'username': 'teacher', 'password': 'teacher-password', 'name': '教师', 'role': 'teacher'}, headers)
        teacher_headers = {'Authorization': 'Bearer ' + client.post('/api/v1/auth/login', json={'username': 'teacher', 'password': 'teacher-password'}).json()['token']}
        output = io.BytesIO(); Image.new('RGB', (210, 297), 'white').save(output, format='PNG'); content = output.getvalue()
        digest = hashlib.sha256(content).hexdigest()
        (tmp_path / 'assets').mkdir(); (tmp_path / 'pages').mkdir()
        with db.connect() as connection:
            asset = db.put(connection, 'assets', {'name': '共用底图', 'width': 210, 'height': 297, 'sha256': digest})
        (tmp_path / 'assets' / (asset['id'] + '.png')).write_bytes(content)
        question = {'id': str(uuid4()), 'number': 1, 'type': 'subjective', 'points': 10, 'review_mode': 'single', 'threshold': 0, 'regions': [{'page': 1, 'x': 15, 'y': 110, 'width': 100, 'height': 30}]}
        template = post(client, 'templates', {'name': '语文卷', 'group_id': group['id'], 'paper': 'A4', 'sides': 1, 'candidate_length': 3, 'questions': [question], 'background_assets': {'1': asset['id']}}, headers)
        template = post(client, f"templates/{template['id']}/publish", None, headers)
        post(client, 'assignments', {'template_id': template['id'], 'question_id': question['id'], 'user_ids': [teacher['id']]}, headers)
        batch = post(client, 'scan-batches', {'group_id': group['id'], 'back_order': 'same'}, headers)
        with db.connect() as connection:
            page = db.put(connection, 'pages', {'batch_id': batch['id'], 'side': 'front', 'sequence': 1, 'candidate_number': '123', 'status': 'recognized', 'sha256': digest, 'normalized_sha256': digest, 'selections': {}})
        for suffix in ('.image', '.png'): (tmp_path / 'pages' / (page['id'] + suffix)).write_bytes(content)
        response = client.put(f"/api/v1/groups/{group['id']}/roster", json={'class_ids': [cls['id']], 'student_ids': []}, headers=headers)
        assert response.status_code == 200, response.text
        post(client, f"scan-batches/{batch['id']}/pair", None, headers)
        task = post(client, 'tasks/claim', {'template_id': template['id'], 'question_id': question['id']}, teacher_headers)
        post(client, f"tasks/{task['id']}/score", {'score': 8, 'idempotency_key': 'initial-score'}, teacher_headers)
        close_scanning(client,group['id'],headers)
        post(client, 'results/publish', {'group_id': group['id']}, headers)
        archive = post(client, f"projects/{project['id']}/archive", None, headers)
        release = post(client, f"projects/{project['id']}/release-preview", {'archive_id': archive['id'], 'mode': 'local'}, headers)
        post(client, f"groups/{group['id']}/reopen", {'reason': '复核'}, headers)
        post(client, f"tasks/{task['id']}/regrade-from", {'reason': '重新核对'}, teacher_headers)
        post(client, f"tasks/{task['id']}/report", {'kind': 'exception', 'reason': '待核查'}, teacher_headers)
        library = post(client, f"templates/{template['id']}/save-to-library", {'name': '共用版式'}, headers)
        with db.connect() as connection:
            alignment = db.put(connection, 'page-alignments', {'page_id': page['id'], 'reason': '历史定位'})
            config = db.put(connection, 'score-conversions', {'name': '共享赋分方案'})
            job = jobs.create_job(connection, 'process-page', {'page_id': page['id']})
        other = post(client, 'projects', {'name': '其他考试'}, headers)
        other_subject = post(client, 'subjects', {'project_id': other['id'], 'name': '数学', 'group_mode': 'default'}, headers)
        sibling = post(client, 'groups', {'subject_id': subject['id'], 'name': '二中'}, headers)
        yield dict(locals())


@pytest.mark.parametrize('kind', ['projects', 'subjects', 'groups'])
def test_archive_remove_scans_retire_owned_records_keep_shared_files_scores_and_ids(populated, kind):
    f = populated; client = f['client']; headers = f['headers']
    target = f[{'projects': 'project', 'subjects': 'subject', 'groups': 'group'}[kind]]
    with db.connect() as connection:
        audit_before = {r[0] for r in connection.execute('SELECT id FROM audit')}
    plan = post(client, f"{kind}/{target['id']}/deletion-preview", None, headers)
    assert plan['retained_score_history'] == plan['retained_score_results'] == 1
    assert plan['runtime_regrades'] == 1 and plan['cancel_pending_jobs'] == 1 and plan['question_count'] == 1
    exported = client.get(f"/api/v1/deletion-plans/{plan['id']}/manifest", headers=headers)
    assert exported.status_code == 200, exported.text
    owned = {item['id'] for item in exported.json()['records']}
    assert len(owned) == plan['record_count'] and f['alignment']['id'] in owned
    assert not {f['asset']['id'], f['library']['id'], f['config']['id'], f['student']['id'], f['cls']['id'], f['other']['id'], f['archive']['id']} & owned
    confirm = f"deletion-plans/{plan['id']}/confirm"
    completed = post(client, confirm, {'confirm': True, 'reason': '管理员清理本次考试'}, headers)
    assert completed['status'] == 'completed'
    assert post(client, confirm, {'confirm': True, 'reason': '重试'}, headers) == completed
    assert {item['id'] for item in client.get(f"/api/v1/deletion-plans/{plan['id']}/manifest", headers=headers).json()['records']} == owned
    with db.connect() as connection:
        assert all(db.get(connection, identifier) is None for identifier in owned)
        for identifier in (f['asset']['id'], f['library']['id'], f['config']['id'], f['student']['id'], f['cls']['id'], f['other']['id'], f['archive']['id']): assert db.get(connection, identifier)
        if kind != 'projects': assert db.get(connection, f['project']['id'])
        if kind == 'groups': assert db.get(connection, f['subject']['id']) and db.get(connection, f['sibling']['id'])
        assert connection.execute('SELECT score FROM scores').fetchone()[0] == 800
        assert connection.execute('SELECT final_cents FROM review_results').fetchone()[0] == 800
        assert connection.execute('SELECT COUNT(*) FROM regrade_queue').fetchone()[0] == 0
        assert connection.execute('SELECT COUNT(*) FROM review_allocations').fetchone()[0] == 0
        assert audit_before <= {r[0] for r in connection.execute('SELECT id FROM audit')}
        assert connection.execute("SELECT COUNT(*) FROM audit WHERE action='delete'").fetchone()[0] == len(owned)
        assert connection.execute('SELECT retired FROM identifiers WHERE id=?', (f['question']['id'],)).fetchone()[0] == 1
        for identifier in owned: assert connection.execute('SELECT retired FROM identifiers WHERE id=?', (identifier,)).fetchone()[0] == 1
        with pytest.raises(IdentifierConflict): db.put(connection, kind, {**target, 'name': '复用旧编号'})
        cancelled = db.get(connection, f['job']['id']); assert cancelled['status'] == 'failed' and cancelled['cancelled_by_deletion'] == plan['id']
        assert db.get(connection, f['release']['id'])['invalidated_by_deletion'] == plan['id']
    for suffix in ('.image', '.png'): assert not (f['tmp_path'] / 'pages' / (f['page']['id'] + suffix)).exists()
    from server.archive import verify
    latest,_,data=verify(completed['archive_id'])
    assert latest['id']!=f['archive']['id'] and len(data['score_history'])==1 and len(data['review_results'])==1
    assert (f['tmp_path'] / 'assets' / (f['asset']['id'] + '.png')).read_bytes() == f['content']
    archived = client.get(f"/api/v1/archives/{f['archive']['id']}/download", headers=headers)
    assert archived.status_code == 200 and archived.content
    if kind == 'projects':
        saved = client.get('/api/v1/archives', headers=headers).json()[0]
        assert saved['project_deleted'] and saved['project_name'] == target['name']
    assert client.post(f"/api/v1/tasks/{f['task']['id']}/score", json={'score': 9, 'idempotency_key': 'late-score'}, headers=f['teacher_headers']).status_code == 404
    assert client.get(f"/api/v1/scan-batches/{f['batch']['id']}", headers=headers).status_code == 404
    assert client.post(f"/api/v1/jobs/{f['job']['id']}/retry", headers=headers).status_code == 409
    assert client.post(f"/api/v1/projects/{f['project']['id']}/release", json={'plan_id': f['release']['id'], 'confirm': True}, headers=headers).status_code == 409
    jobs.execute(f['job']['id'])
    assert jobs.queue('process-page', {'page_id': f['page']['id']}) is None


def test_preview_rejects_wrong_owner_expiry_running_work_and_changed_scores(populated):
    f = populated; client = f['client']; headers = f['headers']; target = f['group']['id']
    plan = post(client, f'groups/{target}/deletion-preview', None, headers)
    assert client.post(f'/api/v1/groups/{target}/deletion-preview', headers=f['teacher_headers']).status_code == 403
    assert client.get(f"/api/v1/deletion-plans/{plan['id']}/manifest", headers=f['teacher_headers']).status_code == 403
    other = post(client, 'users', {'username': 'second-admin', 'password': 'second-admin-password', 'name': '其他管理员', 'role': 'admin'}, headers)
    second = client.post('/api/v1/auth/login', json={'username': other['username'], 'password': 'second-admin-password'}).json()
    response = client.post(f"/api/v1/deletion-plans/{plan['id']}/confirm", json={'confirm': True, 'reason': '核对'}, headers={'Authorization': 'Bearer ' + second['token']})
    assert response.status_code == 403
    post(client, f"tasks/{f['task']['id']}/score", {'score': 8.5, 'idempotency_key': 'changed-score'}, f['teacher_headers'])
    assert client.post(f"/api/v1/deletion-plans/{plan['id']}/confirm", json={'confirm': True, 'reason': '核对'}, headers=headers).status_code == 409
    assert client.get(f"/api/v1/deletion-plans/{plan['id']}/manifest", headers=headers).status_code == 409
    with db.connect() as connection:
        job = db.get(connection, f['job']['id']); job.update(status='running', lease_until=time.time() + 600, run_token='active'); db.put(connection, 'jobs', job)
    running = post(client, f'groups/{target}/deletion-preview', None, headers)
    assert running['blockers']
    assert client.post(f"/api/v1/deletion-plans/{running['id']}/confirm", json={'confirm': True, 'reason': '核对'}, headers=headers).status_code == 409
    with db.connect() as connection:
        job.update(status='pending'); db.put(connection, 'jobs', job)
    expired = post(client, f'groups/{target}/deletion-preview', None, headers)
    with db.connect() as connection:
        saved = db.get(connection, expired['id']); saved['expires_at'] = 0; db.put(connection, 'deletion-plans', saved)
    assert client.post(f"/api/v1/deletion-plans/{expired['id']}/confirm", json={'confirm': True, 'reason': '核对'}, headers=headers).status_code == 409


def test_delete_failure_rolls_back_records_audit_identifiers_and_runtime(populated, monkeypatch):
    f = populated; plan = post(f['client'], f"groups/{f['group']['id']}/deletion-preview", None, f['headers'])
    original = deletion.put
    def fail(connection, kind, body, actor=None):
        if kind == 'jobs': raise RuntimeError('simulated interruption')
        return original(connection, kind, body, actor)
    monkeypatch.setattr(deletion, 'put', fail)
    response = f['client'].post(f"/api/v1/deletion-plans/{plan['id']}/confirm", json={'confirm': True, 'reason': '核对'}, headers=f['headers'])
    assert response.status_code == 500
    with db.connect() as connection:
        assert db.get(connection, f['group']['id']) and db.get(connection, f['task']['id'])
        assert connection.execute('SELECT COUNT(*) FROM objects WHERE deleted=1').fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM audit WHERE action='delete'").fetchone()[0] == 0
        assert connection.execute('SELECT COUNT(*) FROM identifiers WHERE retired=1').fetchone()[0] == 0
        assert connection.execute('SELECT COUNT(*) FROM regrade_queue').fetchone()[0] == 1
        assert db.get(connection, plan['id'])['status'] == 'preview'
        assert db.get(connection, f['job']['id'])['status'] == 'pending'


def test_empty_default_group_can_be_recreated_with_new_permanent_ids(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        headers, _ = admin_login(client)
        project = post(client, 'projects', {'name': '空考试'}, headers)
        subject = post(client, 'subjects', {'project_id': project['id'], 'name': '语文', 'group_mode': 'default'}, headers)
        old_id = subject['default_group_id']
        plan = post(client, f'groups/{old_id}/deletion-preview', None, headers)
        assert plan['record_count'] == 1
        post(client, f"deletion-plans/{plan['id']}/confirm", {'confirm': True, 'reason': '重新配置'}, headers)
        with db.connect() as connection: assert 'default_group_id' not in db.get(connection, subject['id'])
        new = post(client, f"subjects/{subject['id']}/default-group", None, headers)
        assert new['id'] != old_id


def test_large_scope_manifest_and_delete_are_not_limited_by_sql_parameter_count(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        headers, _ = admin_login(client)
        project = post(client, 'projects', {'name': '1205人考试'}, headers)
        subject = post(client, 'subjects', {'project_id': project['id'], 'name': '语文', 'group_mode': 'custom'}, headers)
        group = post(client, 'groups', {'subject_id': subject['id'], 'name': '全体'}, headers)
        with db.connect() as connection:
            cls = db.put(connection, 'classes', {'name': '班级', 'grade': 10})
            for index in range(1205):
                student = db.put(connection, 'students', {'class_id': cls['id'], 'name': f'学生{index}', 'candidate_number': str(10000 + index)})
                db.put(connection, 'submissions', {'group_id': group['id'], 'student_id': student['id'], 'status': 'absent', 'pages': []})
        plan = post(client, f"projects/{project['id']}/deletion-preview", None, headers)
        assert plan['record_count'] == 1208
        response = client.get(f"/api/v1/deletion-plans/{plan['id']}/manifest", headers=headers)
        assert response.status_code == 200 and len(response.json()['records']) == 1208
        post(client, f"deletion-plans/{plan['id']}/confirm", {'confirm': True, 'reason': '清理整场'}, headers)
        with db.connect() as connection:
            assert len(db.objects(connection, 'students')) == 1205
            assert not db.objects(connection, 'submissions')


def queued_delete(f):
    plan=post(f['client'],f"groups/{f['group']['id']}/deletion-preview",None,f['headers'])
    response=f['client'].post(f"/api/v1/deletion-plans/{plan['id']}/confirm",json={'confirm':True,'reason':'归档后清理'},headers=f['headers'])
    assert response.status_code==202,response.text
    return response.json()


def retry_delete(f,plan):
    response=f['client'].post(f"/api/v1/jobs/{plan['job_id']}/retry",headers=f['headers'])
    assert response.status_code==200,response.text
    jobs.execute(plan['job_id'])


def test_remote_partial_failure_fences_writes_preserves_sibling_and_resumes(populated,monkeypatch):
    f=populated;deleted=[];failing=True
    monkeypatch.setenv('OMP_STORAGE','ros')
    with db.connect() as connection:
        # A sibling's bytes and a shared background must survive scoped cleanup.
        sibling_batch=db.put(connection,'scan-batches',{'group_id':f['sibling']['id'],'template_id':f['template']['id']})
        sibling_page=db.put(connection,'pages',{'batch_id':sibling_batch['id'],'status':'received','sha256':f['digest']})
        sibling_path=f['tmp_path']/'pages'/(sibling_page['id']+'.image');sibling_path.write_bytes(f['content'])
        for suffix in ('.image','.png'):
            relative='pages/'+f['page']['id']+suffix
            db.put(connection,'storage-assets',{'relative':relative,'key':'projects/'+f['project']['id']+'/'+relative,'project_id':f['project']['id'],'backend':'ros','location':storage.location(),'status':'stored'})
    def remote_delete(self,key):
        if key.endswith('.png') and failing:raise OSError('remote unavailable')
        deleted.append(key)
    monkeypatch.setattr(storage.Storage,'delete',remote_delete)
    plan=queued_delete(f);jobs.execute(plan['job_id'])
    with db.connect() as connection:
        job=db.get(connection,plan['job_id']);assert job['status']=='pending'
        assert db.get(connection,f['group']['id']) and db.get(connection,f['task']['id'])
        assert connection.execute('SELECT COUNT(*) FROM deletion_files WHERE plan_id=? AND done=1',(plan['id'],)).fetchone()[0]==1
        assert connection.execute('SELECT COUNT(*) FROM deletion_locks').fetchone()[0]==1
    assert not (f['tmp_path']/'pages'/(f['page']['id']+'.image')).exists()
    assert (f['tmp_path']/'pages'/(f['page']['id']+'.png')).exists()
    assert f['client'].post(f"/api/v1/tasks/{f['task']['id']}/score",json={'score':9,'idempotency_key':'during-delete'},headers=f['teacher_headers']).status_code==409
    assert f['client'].post('/api/v1/groups',json={'subject_id':f['subject']['id'],'name':'迟到组'},headers=f['headers']).status_code==409
    assert f['client'].post(f"/api/v1/archives/{plan['archive_id']}/restore",headers=f['headers']).status_code==409
    assert f['client'].get(f"/api/v1/pages/{f['page']['id']}/image",headers=f['headers']).status_code==409
    assert post(f['client'],f"projects/{f['project']['id']}/deletion-preview",None,f['headers'])['id']==plan['id']
    # The job survives a process recovery and resumes the already confirmed plan.
    failing=False;retry_delete(f,plan)
    with db.connect() as connection:
        assert db.get(connection,plan['id'])['status']=='completed'
        assert connection.execute('SELECT COUNT(*) FROM deletion_locks').fetchone()[0]==0
        assert db.get(connection,sibling_page['id'])
        assert all(r['status']=='archived' for r in db.objects(connection,'storage-assets'))
    assert len(deleted)==2 and sibling_path.read_bytes()==f['content']
    assert (f['tmp_path']/'assets'/(f['asset']['id']+'.png')).exists()


def test_corrupt_archive_and_remote_location_fail_before_any_file_removal(populated,monkeypatch):
    f=populated;plan=queued_delete(f)
    from server import archive
    original_create=archive.create;valid=[]
    def corrupt(*args,**kwargs):
        result=original_create(*args,**kwargs);path=archive.package_path(result['id'])
        valid.append(path.read_bytes());path.write_bytes(valid[0]+b'corrupt')
        return result
    monkeypatch.setattr(archive,'create',corrupt)
    jobs.execute(plan['job_id'])
    assert all((f['tmp_path']/'pages'/(f['page']['id']+s)).exists() for s in ('.image','.png'))
    with db.connect() as connection:
        assert db.get(connection,f['group']['id']) and not connection.execute('SELECT COUNT(*) FROM deletion_files').fetchone()[0]
        relative='pages/'+f['page']['id']+'.image'
        reference=db.put(connection,'storage-assets',{'relative':relative,'key':'projects/'+f['project']['id']+'/'+relative,'project_id':f['project']['id'],'backend':'ros','location':'other-location','status':'stored'})
    archive.package_path(plan['archive_id']).write_bytes(valid[0])
    monkeypatch.setattr(archive,'create',original_create);retry_delete(f,plan)
    with db.connect() as connection:
        assert db.get(connection,plan['job_id'])['status']=='failed'
        assert db.get(connection,f['group']['id'])
        reference['status']='archived';db.put(connection,'storage-assets',reference)
    assert all((f['tmp_path']/'pages'/(f['page']['id']+s)).exists() for s in ('.image','.png'))
    retry_delete(f,plan)
    with db.connect() as connection:assert db.get(connection,plan['id'])['status']=='completed'


def test_retirement_transaction_failure_can_resume_after_files_removed(populated,monkeypatch):
    f=populated;plan=queued_delete(f);original=deletion.put
    def fail(connection,kind,body,actor=None):
        if kind=='subjects' and 'default_group_id' not in body:raise RuntimeError('interrupted retirement')
        if kind=='deletion-plans' and body.get('status')=='completed':raise RuntimeError('interrupted retirement')
        return original(connection,kind,body,actor)
    monkeypatch.setattr(deletion,'put',fail);jobs.execute(plan['job_id'])
    with db.connect() as connection:
        assert db.get(connection,f['task']['id']) and db.get(connection,f['group']['id'])
        assert connection.execute("SELECT COUNT(*) FROM audit WHERE action='delete'").fetchone()[0]==0
        assert connection.execute('SELECT COUNT(*) FROM identifiers WHERE retired=1').fetchone()[0]==0
        assert connection.execute('SELECT COUNT(*) FROM deletion_locks').fetchone()[0]==1
    assert not (f['tmp_path']/'pages'/(f['page']['id']+'.image')).exists()
    monkeypatch.setattr(deletion,'put',original);retry_delete(f,plan)
    with db.connect() as connection:assert db.get(connection,plan['id'])['status']=='completed'


def test_backup_during_partial_deletion_restores_and_resumes_same_plan(populated,monkeypatch):
    f=populated;monkeypatch.setenv('OMP_STORAGE','ros');failing=True
    with db.connect() as connection:
        task=db.get(connection,f['task']['id']);task.update(status='claimed',expires_at=time.time()+300);db.put(connection,'tasks',task)
        for suffix in ('.image','.png'):
            relative='pages/'+f['page']['id']+suffix
            db.put(connection,'storage-assets',{'relative':relative,'key':'projects/'+f['project']['id']+'/'+relative,'project_id':f['project']['id'],'backend':'ros','location':storage.location(),'status':'stored'})
    def remote_delete(self,key):
        if failing and key.endswith('.png'):raise OSError('interrupted')
    monkeypatch.setattr(storage.Storage,'delete',remote_delete)
    plan=queued_delete(f);jobs.execute(plan['job_id'])
    assert not (f['tmp_path']/'pages'/(f['page']['id']+'.image')).exists()
    from server import backups,recovery
    snapshot=backups.create(f['owner']['id']);destination=f['tmp_path'].parent/(f['tmp_path'].name+'-restored')
    report=recovery.restore(f['tmp_path']/'backups'/(snapshot['id']+'.sqlite3'),destination,files_from=f['tmp_path'],expected_sha256=snapshot['sha256'])
    assert report['runtime_reset']['deletion_files_reset']==1
    assert (destination/'pages'/(f['page']['id']+'.image')).exists()
    monkeypatch.setattr(db,'ROOT',destination);failing=False
    with db.connect() as connection:
        assert db.get(connection,f['task']['id'])['status']=='claimed'
        job=db.get(connection,plan['job_id']);assert job['status']=='failed'
    logged=f['client'].post('/api/v1/auth/login',json={'username':'admin','password':'administrator-password'}).json()
    f['headers']={'Authorization':'Bearer '+logged['token']}
    retry_delete(f,plan)
    with db.connect() as connection:
        assert db.get(connection,plan['id'])['status']=='completed'
        assert not connection.execute('SELECT 1 FROM deletion_locks').fetchone()
    assert not any((destination/'pages'/(f['page']['id']+s)).exists() for s in ('.image','.png'))
