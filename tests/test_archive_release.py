import hashlib
import io
import json
import time
import zipfile
from uuid import uuid4
from PIL import Image
from fastapi.testclient import TestClient
from server import db,storage,jobs
from server.main import app


def seed(client,tmp_path):
    account={'username':'admin','password':'administrator-password','name':'管理员'}
    client.post('/api/v1/auth/bootstrap',json=account)
    logged=client.post('/api/v1/auth/login',json=account).json()
    headers={'Authorization':'Bearer '+logged['token']}
    buffer=io.BytesIO();Image.new('L',(840,1188),255).save(buffer,format='PNG');content=buffer.getvalue()
    (tmp_path/'pages').mkdir();(tmp_path/'assets').mkdir()
    with db.connect() as connection:
        project=db.put(connection,'projects',{'name':'考试'})
        subject=db.put(connection,'subjects',{'project_id':project['id'],'name':'语文'})
        group=db.put(connection,'groups',{'subject_id':subject['id'],'name':'组','frozen':True})
        asset=db.put(connection,'assets',{})
        (tmp_path/'assets'/(asset['id']+'.png')).write_bytes(content)
        q={'id':str(uuid4()),'number':1,'type':'subjective','points':10,'review_mode':'single','regions':[{'page':1,'x':10,'y':110,'width':100,'height':30}]}
        template=db.put(connection,'templates',{'name':'语文卷','group_id':group['id'],'paper':'A4','sides':1,'revision':1,'status':'published','questions':[q],'background_assets':{'1':asset['id']}})
        group['template_id']=template['id'];db.put(connection,'groups',group)
        student=db.put(connection,'students',{'name':'学生','candidate_number':'001','class_id':'class'})
        batch=db.put(connection,'scan-batches',{'group_id':group['id'],'template_id':template['id'],'status':'paired'})
        page=db.put(connection,'pages',{'batch_id':batch['id'],'side':'front','sequence':1,'status':'recognized','candidate_number':'001','sha256':hashlib.sha256(content).hexdigest()})
        for suffix in ('.image','.png'):(tmp_path/'pages'/(page['id']+suffix)).write_bytes(content)
        submission=db.put(connection,'submissions',{'template_id':template['id'],'group_id':group['id'],'student_id':student['id'],'candidate_number':'001','pages':[page['id']],'status':'ready'})
        task=db.put(connection,'tasks',{'template_id':template['id'],'question_id':q['id'],'submission_id':submission['id'],'user_id':logged['user']['id'],'status':'completed','score_cents':800,'created_at':time.time()})
    return headers,project,page,task,template,asset,content


def test_archive_pdf_assets_release_guards_lazy_access_and_restore(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers,project,page,task,template,asset,content=seed(client,tmp_path)
        other=tmp_path/'pages'/(str(uuid4())+'.image');other.write_bytes(b'unrelated')
        archive=client.post(f"/api/v1/projects/{project['id']}/archive",headers=headers)
        assert archive.status_code==200,archive.text
        archive=archive.json();path=tmp_path/'archives'/(archive['id']+'.zip');original_zip=path.read_bytes()
        # The browser receives a short-lived streaming URL, not a giant JS blob.
        link=client.post(f"/api/v1/archives/{archive['id']}/download-link",headers=headers).json()['url']
        streamed=client.get(link)
        assert streamed.status_code==200 and streamed.content==original_zip and streamed.headers['cache-control']=='private, no-store'
        assert client.get('/api/v1/archive-download/invalid-ticket').status_code==403
        with db.connect() as connection:
            ticket=db.objects(connection,'download-tickets')[0]
            assert 'token' not in ticket and 'token_hash' in ticket
            ticket['expires_at']=0;db.put(connection,'download-tickets',ticket)
        assert client.get(link).status_code==403
        with zipfile.ZipFile(path) as package:
            names=set(package.namelist())
            assert {'templates/'+template['id']+'.pdf','assets/'+asset['id']+'.png','pages/'+page['id']+'.image','pages/'+page['id']+'.png','data.json'}<=names
            for item in json.loads(package.read('manifest.json')):assert hashlib.sha256(package.read(item['path'])).hexdigest()==item['sha256']
            assert all('password' not in person for person in json.loads(package.read('data.json'))['people'])
        base=f"/api/v1/projects/{project['id']}"
        preview=client.post(base+'/release-preview',json={'archive_id':archive['id'],'mode':'local'},headers=headers)
        assert preview.status_code==200,preview.text
        plan=preview.json();assert plan['file_count']==2 and plan['remote_files']==0
        body={'plan_id':plan['id'],'confirm':True}
        assert client.post(base+'/release',json={**body,'confirm':False},headers=headers).status_code==422
        # Corrupt archive or changed current bytes prevents deleting any scan.
        path.write_bytes(original_zip+b'corrupt')
        assert client.post(base+'/release',json=body,headers=headers).status_code==409
        path.write_bytes(original_zip)
        original=tmp_path/'pages'/(page['id']+'.image');original.write_bytes(b'changed')
        assert client.post(base+'/release',json=body,headers=headers).status_code==409
        assert (tmp_path/'pages'/(page['id']+'.png')).exists()
        original.write_bytes(content)
        released=client.post(base+'/release',json=body,headers=headers)
        assert released.status_code==200 and released.json()['status']=='completed'
        assert not original.exists() and not (tmp_path/'pages'/(page['id']+'.png')).exists() and other.read_bytes()==b'unrelated'
        # Cropping transparently retrieves the indexed archive entry.
        assert client.get(f"/api/v1/tasks/{task['id']}/image",headers=headers).status_code==200
        assert (tmp_path/'pages'/(page['id']+'.png')).exists() and not original.exists()
        restored=client.post(f"/api/v1/archives/{archive['id']}/restore",headers=headers)
        assert restored.status_code==200 and restored.json()['restored_files']==1
        assert original.read_bytes()==content
        assert client.post(base+'/release',json=body,headers=headers).json()['status']=='completed' and original.exists()
        with db.connect() as connection:assert db.get(connection,task['id'],'tasks')['score_cents']==800


def test_remote_release_partial_retry_and_archive_fallback(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    monkeypatch.setenv('OMP_STORAGE','s3');monkeypatch.setenv('OMP_S3_BUCKET','test')
    remote={};failures=set();deleted=[]
    class S3:
        def upload_file(self,path,bucket,key):remote[key]=open(path,'rb').read()
        def delete_object(self,**kwargs):
            key=kwargs['Key']
            if key in failures:failures.remove(key);raise OSError('temporary failure')
            remote.pop(key,None);deleted.append(key)
        def download_file(self,bucket,key,target):
            from pathlib import Path
            Path(target).write_bytes(remote[key])
    monkeypatch.setattr(storage.Storage,'s3',lambda self:S3())
    with TestClient(app) as client:
        headers,project,page,task,template,asset,content=seed(client,tmp_path)
        for suffix in ('.image','.png'):storage.mirror('pages/'+page['id']+suffix,project['id'])
        failures.add(next(iter(remote)))
        archive=client.post(f"/api/v1/projects/{project['id']}/archive",headers=headers).json()
        base=f"/api/v1/projects/{project['id']}"
        plan=client.post(base+'/release-preview',json={'archive_id':archive['id'],'mode':'all'},headers=headers).json()
        assert plan['remote_files']==2
        body={'plan_id':plan['id'],'confirm':True}
        partial=client.post(base+'/release',json=body,headers=headers)
        assert partial.status_code==200 and partial.json()['status']=='partial' and len(partial.json()['failed'])==1
        retry=client.post(base+'/release',json=body,headers=headers)
        assert retry.json()['status']=='completed' and not remote
        assert storage.materialize('pages/'+page['id']+'.image').read_bytes()==content
        assert len(deleted)==2


def test_durable_storage_jobs_deduplicate_and_recover_without_duplicate_archive(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);monkeypatch.setenv('OMP_TASK_MODE','celery')
    submitted=[]
    monkeypatch.setattr(jobs.run,'apply_async',lambda *args,**kwargs:submitted.append(kwargs))
    with TestClient(app) as client:
        headers,project,page,task,template,asset,content=seed(client,tmp_path)
        base=f"/api/v1/projects/{project['id']}"
        response=client.post(base+'/archive-jobs',headers=headers)
        assert response.status_code==202
        first=response.json()
        assert client.post(base+'/archive-jobs',headers=headers).json()['id']==first['id']
        assert len(submitted)==1
        jobs.execute(first['id'])
        completed=client.get(f"/api/v1/jobs/{first['id']}",headers=headers).json()
        assert completed['status']=='completed' and completed['phase']=='已完成'
        archive=completed['result'];assert archive['id']==first['payload']['new_archive_id']
        # Recover after the archive committed but before a task result was saved.
        with db.connect() as connection:
            interrupted=db.get(connection,first['id'],'jobs');interrupted.update(status='pending',result=None);db.put(connection,'jobs',interrupted)
        jobs.execute(first['id'])
        assert len(client.get('/api/v1/archives',headers=headers).json())==1
        preview=client.post(base+'/release-preview-jobs',json={'archive_id':archive['id'],'mode':'local'},headers=headers).json()
        jobs.execute(preview['id'])
        plan=client.get(f"/api/v1/jobs/{preview['id']}",headers=headers).json()['result']
        assert plan['file_count']==2
        assert client.post(base+'/release-jobs',json={'plan_id':plan['id'],'confirm':False},headers=headers).status_code==422
        release=client.post(base+'/release-jobs',json={'plan_id':plan['id'],'confirm':True},headers=headers).json()
        with db.connect() as connection:
            confirmed=db.get(connection,plan['id'],'release-plans');confirmed['expires_at']=0;db.put(connection,'release-plans',confirmed)
        jobs.execute(release['id'])
        result=client.get(f"/api/v1/jobs/{release['id']}",headers=headers).json()
        assert result['status']=='completed' and result['result']['released_files']==2
        restored=client.post(f"/api/v1/archives/{archive['id']}/restore-jobs",headers=headers).json()
        jobs.execute(restored['id'])
        assert client.get(f"/api/v1/jobs/{restored['id']}",headers=headers).json()['result']['restored_files']==2
        assert len(client.get('/api/v1/jobs',params={'project_id':project['id']},headers=headers).json())==4


def test_queued_storage_job_requires_current_admin_authority(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);monkeypatch.setenv('OMP_TASK_MODE','celery')
    monkeypatch.setattr(jobs.run,'apply_async',lambda *args,**kwargs:None)
    with TestClient(app) as client:
        headers,project,*_=seed(client,tmp_path)
        job=client.post(f"/api/v1/projects/{project['id']}/archive-jobs",headers=headers).json()
        with db.connect() as connection:connection.execute("UPDATE users SET role='teacher' WHERE id=?",(job['actor'],))
        jobs.execute(job['id'])
        with db.connect() as connection:
            result=db.get(connection,job['id'],'jobs')
            assert result['status']=='failed' and '权限' in result['error_detail']
            assert db.objects(connection,'archives')==[]


def test_local_restart_recovers_a_persisted_file_job(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);monkeypatch.setenv('OMP_TASK_MODE','celery')
    monkeypatch.setattr(jobs.run,'apply_async',lambda *args,**kwargs:None)
    with TestClient(app) as client:
        headers,project,*_=seed(client,tmp_path)
        queued=client.post(f"/api/v1/projects/{project['id']}/archive-jobs",headers=headers).json()
    monkeypatch.setenv('OMP_TASK_MODE','inline')
    with TestClient(app) as client:
        deadline=time.monotonic()+5;result=None
        while time.monotonic()<deadline:
            result=client.get(f"/api/v1/jobs/{queued['id']}",headers=headers).json()
            if result['status'] in ('completed','failed'):break
            time.sleep(.02)
        assert result['status']=='completed',result
        assert result['result']['id']==queued['payload']['new_archive_id']


def test_archive_commit_is_fenced_after_worker_ownership_changes(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);monkeypatch.setenv('OMP_TASK_MODE','celery')
    monkeypatch.setattr(jobs.run,'apply_async',lambda *args,**kwargs:None)
    from server import archive
    original=archive.checksum
    with TestClient(app) as client:
        headers,project,*_=seed(client,tmp_path)
        queued=client.post(f"/api/v1/projects/{project['id']}/archive-jobs",headers=headers).json()
        def replace_owner(path):
            digest=original(path)
            if path.suffix=='.tmp':
                with db.connect() as connection:
                    job=db.get(connection,queued['id'],'jobs');job['run_token']='new-worker';db.put(connection,'jobs',job)
            return digest
        monkeypatch.setattr(archive,'checksum',replace_owner)
        jobs.execute(queued['id'])
        with db.connect() as connection:
            assert db.objects(connection,'archives')==[]
            assert db.get(connection,queued['id'],'jobs')['run_token']=='new-worker'
        assert not (tmp_path/'archives'/(queued['payload']['new_archive_id']+'.zip')).exists()
