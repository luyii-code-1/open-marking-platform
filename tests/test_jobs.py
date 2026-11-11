from server import db,jobs,storage
import pytest


def test_failed_job_stale_delivery_requires_explicit_retry(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);db.initialize()
    with db.connect() as connection:
        job=jobs.create_job(connection,'mirror',{'relative':'assets/example.png'})
        job['status']='failed';db.put(connection,'jobs',job)
    calls=[];monkeypatch.setattr(storage,'mirror',lambda *args:calls.append(args))
    jobs.execute(job['id'])
    assert calls==[]
    with db.connect() as connection:
        job['status']='pending';db.put(connection,'jobs',job)
    jobs.execute(job['id'])
    assert len(calls)==1


def test_broker_failure_is_durable_and_recoverable(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);db.initialize()
    monkeypatch.setenv('OMP_TASK_MODE','celery')
    def unavailable(*args,**kwargs):raise ConnectionError('offline')
    monkeypatch.setattr(jobs.run,'apply_async',unavailable)
    task=jobs.queue('mirror',{'relative':'assets/example.png'})
    with db.connect() as connection:assert db.get(connection,task['id'],'jobs')['status']=='pending'
    calls=[]
    monkeypatch.setattr(storage,'mirror',lambda *args:calls.append(args))
    jobs.execute(task['id']);jobs.execute(task['id'])
    assert len(calls)==1
    with db.connect() as connection:assert db.get(connection,task['id'],'jobs')['status']=='completed'


def test_failed_storage_job_retries_from_persistent_state(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);db.initialize()
    monkeypatch.setenv('OMP_TASK_MODE','inline')
    def fail(*args):raise OSError('temporary failure')
    monkeypatch.setattr(storage,'mirror',fail)
    task=jobs.queue('mirror',{'relative':'assets/example.png'})
    with db.connect() as connection:
        saved=db.get(connection,task['id'],'jobs');assert saved['status']=='pending' and saved['attempts']==1
        saved['available_at']=0;db.put(connection,'jobs',saved)
    monkeypatch.setattr(storage,'mirror',lambda *args:None)
    jobs.execute(task['id'])
    with db.connect() as connection:assert db.get(connection,task['id'],'jobs')['status']=='completed'


def test_storage_keys_and_s3_presign(monkeypatch,tmp_path):
    for value in ('../private','/absolute','assets/../../private','assets\\private','C:/private','C:private','assets/invalid\x00'):
        with pytest.raises(ValueError):storage.safe_key(value)
    monkeypatch.setenv('OMP_STORAGE','s3');monkeypatch.setenv('OMP_S3_BUCKET','test')
    calls=[]
    class Client:
        def upload_file(self,*args):calls.append(args)
        def generate_presigned_url(self,*args,**kwargs):return kwargs
    monkeypatch.setattr(storage.Storage,'s3',lambda self:Client())
    provider=storage.Storage();source=tmp_path/'file';source.write_bytes(b'evidence')
    provider.upload(source,'projects/p/pages/id.png')
    assert calls==[(str(source),'test','omp/projects/p/pages/id.png')]
    assert provider.signed_url('assets/id.png')['ExpiresIn']==120


def test_job_lease_renewal_and_ownership_fence(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);db.initialize()
    with db.connect() as connection:
        job=jobs.create_job(connection,'mirror',{'relative':'assets/example.png'})
        job.update(status='running',run_token='first',lease_until=0);db.put(connection,'jobs',job)
    execution=jobs.Execution(job['id'],'first')
    execution.progress(0,1,'测试阶段')
    with db.connect() as connection:
        current=db.get(connection,job['id'],'jobs');assert current['lease_until']>0
        current['run_token']='replacement';db.put(connection,'jobs',current)
    with pytest.raises(jobs.LostLease):execution.progress(1,1,'完成阶段')
    with db.connect() as connection:assert db.get(connection,job['id'],'jobs')['run_token']=='replacement'
