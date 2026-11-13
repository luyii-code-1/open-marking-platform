from workflow_helpers import close_scanning
import copy
import hashlib
import json
import shutil
import subprocess
from uuid import uuid4
import cv2
import pytest
from fastapi.testclient import TestClient
from scanner_engine.main import process
from server import db, jobs, paper, storage
from server.main import app
from server.scanner_pipeline import configuration


@pytest.fixture
def pipeline(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'server');monkeypatch.setenv('OMP_TASK_MODE','celery');monkeypatch.setattr(jobs.run,'apply_async',lambda **kw:None)
    with TestClient(app) as client:
        def post(path,body=None,status=200):
            response=client.post('/api/v1/'+path,json=body,headers=headers)
            assert response.status_code==status,response.text
            return response.json()
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account);logged=client.post('/api/v1/auth/login',json=account).json();headers={'Authorization':'Bearer '+logged['token']}
        project=post('projects',{'name':'本地识读考试'});subject=post('subjects',{'project_id':project['id'],'name':'语文','group_mode':'default'});group_id=subject['default_group_id']
        cls=post('classes',{'name':'一班','grade':'10'});student=post('students',{'name':'学生','candidate_number':'123','class_id':cls['id']})
        questions=[{'number':1,'type':'single','options':4,'points':3,'answer':['B'],'regions':[{'page':1,'x':15,'y':110,'width':90,'height':20}]},
                   {'number':2,'type':'subjective','points':2,'review_mode':'single','regions':[{'page':1,'x':15,'y':150,'width':80,'height':30},{'page':2,'x':15,'y':110,'width':100,'height':30}]}]
        template=post('templates',{'group_id':group_id,'name':'双面题卡','paper':'A4','sides':2,'candidate_length':3,'questions':questions});template=post(f"templates/{template['id']}/publish")
        post('assignments',{'template_id':template['id'],'question_id':template['questions'][1]['id'],'user_ids':[logged['user']['id']]})
        response=client.put('/api/v1/groups/'+group_id+'/roster',json={'class_ids':[cls['id']],'student_ids':[]},headers=headers);assert response.status_code==200
        package=client.get(f"/api/v1/scanner/projects/{project['id']}/package",headers=headers).json();config=package['groups'][0];batch_id=str(uuid4())
        registration={'group_id':group_id,'template_id':template['id'],'template_revision':template['revision'],'config_sha256':config['config_sha256'],'capture_mode':'duplex','back_order':'same','room':'本机'}
        post('scanner/batches/'+batch_id,registration)
        renderer=shutil.which('pdftoppm')
        if not renderer:pytest.skip('Poppler required')
        pdf=tmp_path/'sheet.pdf';pdf.write_bytes(paper.pdf(template));subprocess.run([renderer,'-r','150','-png',str(pdf),str(tmp_path/'sheet')],check=True,capture_output=True)
        root=tmp_path/'client';folder=root/'pages'/batch_id;folder.mkdir(parents=True);pages=[]
        for index,side in enumerate(('front','back')):
            image=cv2.imread(str(tmp_path/f'sheet-{index+1}.png'),cv2.IMREAD_GRAYSCALE);sx=image.shape[1]/210;sy=image.shape[0]/297
            if side=='front':
                def fill(x,y):cv2.rectangle(image,(round((x-1.5)*sx),round((y-1)*sy)),(round((x+1.5)*sx),round((y+1)*sy)),0,-1)
                for col,digit in enumerate('123'):fill(18+col*6,57+int(digit)*3.5)
                _,x,y=paper.bubbles(template['questions'][0],template['questions'][0]['regions'][0])[1];fill(x,y)
            capture_id=str(uuid4());content=cv2.imencode('.jpg',image)[1].tobytes();(folder/(capture_id+'.jpg')).write_bytes(content)
            result=process(root,{'batch_id':batch_id,'capture_id':capture_id,'side':side,'template':config['template'],'config_sha256':config['config_sha256'],'source_sha256':hashlib.sha256(content).hexdigest()})
            pages.append({'id':capture_id,'side':side,'original':content,'result':result})
        def upload(page,result=None):
            derived=root/'processed'/page['id']
            return client.post('/api/v1/scanner/batches/'+batch_id+'/pages',headers=headers,
                               data={'capture_id':page['id'],'side':page['side'],'sequence':'1','manifest':json.dumps(result or page['result'])},
                               files={'file':('raw.jpg',page['original'],'image/jpeg'),'normalized':('normalized.png',(derived/'normalized.png').read_bytes(),'image/png'),'cuts':('cuts.zip',(derived/'cuts.zip').read_bytes(),'application/zip')})
        yield dict(locals())


def test_local_pipeline_grading_cuts_archive_release_and_deletion(pipeline,monkeypatch):
    f=pipeline;client=f['client'];headers=f['headers'];post=f['post'];pages=f['pages']
    assert 'answer' not in f['config']['template']['questions'][0] and 'points' not in f['config']['template']['questions'][0]
    for page in pages:
        response=f['upload'](page);assert response.status_code==200,response.text
        assert response.json()['recognition_source']=='device'
        assert f['upload'](page).json()['id']==page['id']
    with db.connect() as connection:assert not any(j['kind']=='process-page' for j in db.objects(connection,'jobs'))
    local=[{'candidate_number':'123','pages':[p['id'] for p in pages]}]
    post('scan-batches/'+f['batch_id']+'/pair',{'local_pairs':list(reversed(local[0]['pages']))},status=409)
    post('scan-batches/'+f['batch_id']+'/pair',{'local_pairs':local})
    question=f['template']['questions'][1];task=post('tasks/claim',{'template_id':f['template']['id'],'question_id':question['id']})
    original=storage.materialize
    def require_local_cut(relative):
        assert not relative.endswith('.png'),'server should use uploaded cuts'
        return original(relative)
    with monkeypatch.context() as patch:
        patch.setattr(storage,'materialize',require_local_cut)
        response=client.get('/api/v1/tasks/'+task['id']+'/image',headers=headers)
        assert response.status_code==200,response.text
        import numpy as np
        image=cv2.imdecode(np.frombuffer(response.content,np.uint8),cv2.IMREAD_GRAYSCALE)
        assert image.shape==(252,400)
    post('tasks/'+task['id']+'/score',{'score':2,'idempotency_key':'local-graded'})
    result=client.get('/api/v1/results',params={'group_id':f['group_id']},headers=headers).json();assert result[0]['total']==5
    close_scanning(client,f['group_id'],headers)
    post('results/publish',{'group_id':f['group_id']})
    archived=post('projects/'+f['project']['id']+'/archive')
    from server.archive import verify
    _,manifest,_=verify(archived['id']);assert sum(e['path'].endswith('.cuts.zip') for e in manifest)==2
    release=post('projects/'+f['project']['id']+'/release-preview',{'archive_id':archived['id'],'mode':'local'});assert release['file_count']==6
    post('projects/'+f['project']['id']+'/release',{'plan_id':release['id'],'confirm':True})
    with monkeypatch.context() as patch:
        patch.setattr(storage,'materialize',require_local_cut)
        assert client.get('/api/v1/tasks/'+task['id']+'/image',headers=headers).status_code==200
    plan=post('projects/'+f['project']['id']+'/deletion-preview')
    queued=post('deletion-plans/'+plan['id']+'/confirm',{'confirm':True,'reason':'本地识读链路验收'},status=202);jobs.execute(queued['job_id'])
    with db.connect() as connection:assert db.get(connection,plan['id'])['status']=='completed'
    assert not any((db.ROOT/'pages'/(p['id']+suffix)).exists() for p in pages for suffix in ('.image','.png','.cuts.zip'))


def test_local_pipeline_rejects_changed_config_and_malformed_result(pipeline):
    f=pipeline;post=f['post'];page=f['pages'][0]
    changed={**f['registration'],'config_sha256':'changed'}
    post('scanner/batches/'+str(uuid4()),changed,status=409)
    for key,value in (('source_sha256','0'*64),('candidate_number','x'),('engine_version','unknown'),('selections',{})):
        result=copy.deepcopy(page['result']);result[key]=value;response=f['upload'](page,result)
        assert response.status_code in (409,422),response.text
    with db.connect() as connection:assert not db.objects(connection,'pages')
    response=f['upload'](page);assert response.status_code==200,response.text


def test_project_storage_schedules_all_local_recognition_outputs(pipeline,monkeypatch):
    from pathlib import Path
    f=pipeline;monkeypatch.setenv('OMP_STORAGE','local')
    remote={}
    class S3:
        def upload_file(self,source,bucket,key):remote[(bucket,key)]=Path(source).read_bytes()
    monkeypatch.setattr(storage.Storage,'s3',lambda self:S3())
    connection=f['post']('storage-connections',{'name':'考试专用桶','kind':'ros','endpoint':'https://s3.example.test','bucket':'exam-bucket','prefix':'exam','access_key':'fake-access','secret_key':'fake-secret'},status=201)
    response=f['client'].put('/api/v1/projects/'+f['project']['id']+'/storage',json={'connection_id':connection['id']},headers=f['headers']);assert response.status_code==200
    page=f['pages'][0];response=f['upload'](page);assert response.status_code==200,response.text
    with db.connect() as conn:queued=db.find(conn,'jobs',project_id=f['project']['id'])
    assert len(queued)==3 and {j['payload']['relative'] for j in queued}=={'pages/'+page['id']+suffix for suffix in ('.image','.png','.cuts.zip')}
    for job in queued:jobs.execute(job['id'])
    assert len(remote)==3 and all(bucket=='exam-bucket' for bucket,key in remote)
    with db.connect() as conn:
        refs=db.objects(conn,'storage-assets');assert len(refs)==3 and all(r['connection_id']==connection['id'] for r in refs)
    assert f['upload'](page).status_code==200
    with db.connect() as conn:assert len(db.find(conn,'jobs',project_id=f['project']['id']))==3
    bad=copy.deepcopy(page['result']);bad['cuts'][0]['region']['x']+=1
    assert f['upload'](page,bad).status_code==422


def test_local_pipeline_batch_ownership_and_project_freeze(pipeline):
    f=pipeline;client=f['client'];headers=f['headers']
    # Existing identifier cannot be reassigned to another metadata snapshot.
    changed={**f['registration'],'template_revision':99}
    f['post']('scanner/batches/'+f['batch_id'],changed,status=409)
    with db.connect() as connection:
        group=db.get(connection,f['group_id']);group['frozen']=True;db.put(connection,'groups',group)
    assert f['upload'](f['pages'][0]).status_code==409
    with db.connect() as connection:assert not db.objects(connection,'pages')
