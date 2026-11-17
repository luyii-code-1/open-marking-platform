import io
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from server import db,jobs,storage
from server.main import app
from test_archive_release import seed


def test_direct_scan_purge_keeps_scores_without_archive_and_blocks_images(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers,project,page,task,template,asset,content=seed(client,tmp_path)
        base=f"/api/v1/projects/{project['id']}"
        before=client.get('/api/v1/results',params={'group_id':template['group_id']},headers=headers).json()
        plan=client.post(base+'/release-preview',json={'action':'purge'},headers=headers).json()
        assert plan['action']=='purge' and plan['archive_id'] is None and plan['file_count']==2
        assert client.get('/api/v1/archives',headers=headers).json()==[]
        body={'plan_id':plan['id'],'confirm':True}
        assert client.post(base+'/release',json={**body,'confirm':False},headers=headers).status_code==422
        path=tmp_path/'pages'/(page['id']+'.image');path.write_bytes(b'changed')
        assert client.post(base+'/release',json=body,headers=headers).status_code==409
        path.write_bytes(content)
        person={'username':'teacher','password':'teacher-password','name':'教师'}
        client.post('/api/v1/users',headers=headers,json=person)
        teacher={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=person).json()['token']}
        assert client.post(base+'/release',json=body,headers=teacher).status_code==403
        done=client.post(base+'/release',json=body,headers=headers)
        assert done.status_code==200,done.text
        assert done.json()['status']=='completed' and done.json()['released_files']==2
        assert not path.exists() and not path.with_suffix('.png').exists()
        assert (tmp_path/'assets'/(asset['id']+'.png')).exists()
        assert client.get('/api/v1/results',params={'group_id':template['group_id']},headers=headers).json()==before
        assert client.get('/api/v1/results/export',params={'group_id':template['group_id']},headers=headers).status_code==200
        assert client.get(f"/api/v1/tasks/{task['id']}/image",headers=headers).status_code==410
        assert client.post(f"/api/v1/groups/{template['group_id']}/reopen",json={'reason':'复核'},headers=headers).status_code==410
        assert client.post(base+'/release',json=body,headers=headers).json()['status']=='completed'
        assert client.post(base+'/release-preview',json={'action':'purge'},headers=headers).status_code==410
        with db.connect() as connection:
            assert db.get(connection,task['id'],'tasks')['score_cents']==800
            assert db.get(connection,project['id'],'projects')['scans_purged']['plan_id']==plan['id']


def test_purge_jobs_remote_partial_retry(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);monkeypatch.setenv('OMP_TASK_MODE','celery')
    monkeypatch.setenv('OMP_STORAGE','s3');monkeypatch.setenv('OMP_S3_BUCKET','test')
    monkeypatch.setattr(jobs.run,'apply_async',lambda *args,**kwargs:None)
    remote={};failures=set()
    class S3:
        def upload_file(self,path,bucket,key):remote[key]=open(path,'rb').read()
        def delete_object(self,**kwargs):
            if kwargs['Key'] in failures:failures.remove(kwargs['Key']);raise OSError('temporary')
            remote.pop(kwargs['Key'],None)
    monkeypatch.setattr(storage.Storage,'s3',lambda self:S3())
    with TestClient(app) as client:
        headers,project,page,*_=seed(client,tmp_path)
        base=f"/api/v1/projects/{project['id']}"
        for suffix in ('.image','.png'):storage.mirror('pages/'+page['id']+suffix,project['id'])
        failures.add(next(iter(remote)))
        preview=client.post(base+'/release-preview-jobs',json={'action':'purge','mode':'all'},headers=headers).json()
        jobs.execute(preview['id'])
        plan=client.get(f"/api/v1/jobs/{preview['id']}",headers=headers).json()['result']
        assert plan['action']=='purge' and plan['remote_files']==2
        first=client.post(base+'/release-jobs',json={'plan_id':plan['id'],'confirm':True},headers=headers).json()
        jobs.execute(first['id'])
        assert client.get(f"/api/v1/jobs/{first['id']}",headers=headers).json()['result']['status']=='partial'
        retry=client.post(base+'/release-jobs',json={'plan_id':plan['id'],'confirm':True},headers=headers)
        assert retry.status_code==202,retry.text
        jobs.execute(retry.json()['id'])
        result=client.get(f"/api/v1/jobs/{retry.json()['id']}",headers=headers).json()
        assert result['result']['status']=='completed' and not remote


def test_result_overview_uses_completed_papers_and_preserves_visibility(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers,project,page,task,template,*_=seed(client,tmp_path)
        with db.connect() as connection:
            group=db.get(connection,template['group_id'],'groups')
            student=db.put(connection,'students',{'name':'待评学生','candidate_number':'002','class_id':'class'})
            db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':student['id'],'candidate_number':'002','pages':[page['id']],'status':'ready'})
        rows=client.get('/api/v1/analysis/overview',headers=headers).json()['scopes']
        subject=next(row for row in rows if row['kind']=='subject')
        assert subject['average']==8 and subject['analyzed']==1 and subject['pending']==1 and subject['records']==2
        assert subject['score_rate']==80 and {row['kind'] for row in rows}=={'card','subject','grade','class'}
        response=client.get('/api/v1/analysis/overview/export',params={'scope_ids':subject['id'],'format':'xlsx'},headers=headers)
        assert response.status_code==200 and load_workbook(io.BytesIO(response.content)).active.max_row==2
        person={'username':'teacher','password':'teacher-password','name':'教师'}
        client.post('/api/v1/users',headers=headers,json=person)
        teacher={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=person).json()['token']}
        assert client.get('/api/v1/analysis/overview',headers=teacher).json()['scopes']==[]
        assert client.get('/api/v1/analysis/overview/export',params={'scope_ids':subject['id']},headers=teacher).status_code==403
