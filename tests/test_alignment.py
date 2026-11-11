import shutil
import subprocess
from uuid import uuid4
import cv2
import pytest
from fastapi.testclient import TestClient
from server import db,paper
from server.main import app


def image_sheet(tmp_path,template):
    renderer=shutil.which('pdftoppm')
    if not renderer:pytest.skip('PDF rasterizer required')
    path=tmp_path/'sheet.pdf';path.write_bytes(paper.pdf(template))
    subprocess.run([renderer,'-r','150','-singlefile','-png',str(path),str(tmp_path/'sheet')],check=True,capture_output=True)
    image=cv2.imread(str(tmp_path/'sheet.png'),cv2.IMREAD_GRAYSCALE)
    width,height=paper.dimensions(template);sx=image.shape[1]/width;sy=image.shape[0]/height
    def fill(x,y):cv2.rectangle(image,(round((x-1.5)*sx),round((y-1)*sy)),(round((x+1.5)*sx),round((y+1)*sy)),0,-1)
    for i,digit in enumerate('123'):fill(18+i*6,57+int(digit)*3.5)
    _,x,y=paper.bubbles(template['questions'][0],template['questions'][0]['regions'][0])[1];fill(x,y)
    fill(paper.ABSENT_X,paper.ABSENT_Y)
    return image,sx,sy


@pytest.mark.parametrize('damage',['corners','qr','foreign'])
def test_manual_alignment_recovers_and_absence_can_be_corrected(tmp_path,monkeypatch,damage):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data');monkeypatch.setenv('OMP_TASK_MODE','inline')
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        logged=client.post('/api/v1/auth/login',json=account).json();headers={'Authorization':'Bearer '+logged['token']}
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'模拟考'})
            subject=db.put(connection,'subjects',{'name':'语文','project_id':project['id']})
            group=db.put(connection,'groups',{'name':'组','subject_id':subject['id']})
            objective={'id':str(uuid4()),'number':1,'type':'single','options':4,'answer':['B'],'points':3,'regions':[{'page':1,'x':15,'y':110,'width':90,'height':20}]}
            subjective={'id':str(uuid4()),'number':5,'type':'subjective','points':7,'review_mode':'single','regions':[{'page':1,'x':15,'y':150,'width':170,'height':50}]}
            template=db.put(connection,'templates',{'id':'030f8e09-6f5e-416f-a3d4-115ac8b012c2','name':'测试卷','group_id':group['id'],'paper':'A4','sides':1,'candidate_length':3,'revision':1,'layout_version':2,'status':'published','questions':[objective,subjective]})
            group['template_id']=template['id'];db.put(connection,'groups',group)
            student=db.put(connection,'students',{'name':'学生','candidate_number':'123','class_id':'class'})
            batch=db.put(connection,'scan-batches',{'group_id':group['id'],'template_id':template['id'],'status':'front'})
            db.put(connection,'assignments',{'template_id':template['id'],'question_id':subjective['id'],'user_ids':[logged['user']['id']]})
        printed={**template,'id':str(uuid4())} if damage=='foreign' else template
        image,sx,sy=image_sheet(tmp_path,printed)
        if damage=='corners':
            for x,y in ((7,7),(203,290)):cv2.rectangle(image,(round((x-3)*sx),round((y-3)*sy)),(round((x+3)*sx),round((y+3)*sy)),255,-1)
        elif damage=='qr':cv2.rectangle(image,(round(166*sx),round(9*sy)),(round(196*sx),round(38*sy)),255,-1)
        capture=str(uuid4());data=cv2.imencode('.png',image)[1].tobytes()
        response=client.post(f"/api/v1/scan-batches/{batch['id']}/pages",data={'capture_id':capture,'side':'front','sequence':'1'},files={'file':('scan.png',data,'image/png')},headers=headers)
        assert response.status_code==(200 if damage=='corners' else 409),response.text
        assert response.json()['status']==('needs_review' if damage=='corners' else 'quarantined')
        metadata=client.get(f'/api/v1/pages/{capture}/alignment',headers=headers).json()
        assert metadata['width']==image.shape[1] and metadata['qr_matches']==(damage=='corners')
        assert client.get(metadata['image_url'],headers=headers).headers['cache-control']=='private, no-store'
        corners=[{'x':x*sx,'y':y*sy} for x,y in ((7,7),(203,7),(203,290),(7,290))]
        body={'request_id':str(uuid4()),'corners':corners,'rotation':0,'reason':'核对定位框及题卡后人工恢复','confirm_template':True}
        if damage=='foreign':
            assert client.post(f'/api/v1/pages/{capture}/align',json=body,headers=headers).status_code==409
            assert not (db.ROOT/'pages'/(capture+'.png')).exists()
            return
        bad={**body,'corners':[corners[0]]*4}
        assert client.post(f'/api/v1/pages/{capture}/align',json=bad,headers=headers).status_code==422
        if damage=='qr':assert client.post(f'/api/v1/pages/{capture}/align',json={**body,'confirm_template':False},headers=headers).status_code==422
        aligned=client.post(f'/api/v1/pages/{capture}/align',json=body,headers=headers)
        assert aligned.status_code==200,aligned.text
        assert aligned.json()['candidate_number']=='123' and aligned.json()['absent_mark'] is True
        assert aligned.json()['selections'][objective['id']]==['B']
        assert client.post(f'/api/v1/pages/{capture}/align',json=body,headers=headers).status_code==200
        with db.connect() as connection:assert len(db.objects(connection,'page-alignments'))==1
        if damage=='corners':
            changed={**body,'request_id':str(uuid4()),'corners':[{**p,'x':p['x']+.5} for p in corners]}
            revised=client.post(f'/api/v1/pages/{capture}/align',json=changed,headers=headers)
            assert revised.status_code==200 and len(revised.json()['alignment_history'])==1
        else:assert client.post(f"/api/v1/scan-batches/{batch['id']}/resume",json={'reason':'已核对并恢复损坏二维码卷'},headers=headers).status_code==200
        assert client.get('/api/v1/exceptions',params={'status':'open'},headers=headers).json()==[]
        assert client.post(f"/api/v1/scan-batches/{batch['id']}/pair",headers=headers).status_code==200
        rows=client.get('/api/v1/results',params={'group_id':group['id']},headers=headers).json()
        assert rows[0]['status']=='absent' and rows[0]['total']==0
        claim={'template_id':template['id'],'question_id':subjective['id']}
        assert client.post('/api/v1/tasks/claim',json=claim,headers=headers).json() is None
        with db.connect() as connection:submission=db.objects(connection,'submissions')[0]
        path=f"/api/v1/submissions/{submission['id']}/attendance"
        assert client.put(path,json={'absent':False,'reason':'监考核实为误涂'},headers=headers).status_code==200
        task=client.post('/api/v1/tasks/claim',json=claim,headers=headers).json()
        assert client.post(f"/api/v1/tasks/{task['id']}/score",json={'score':6,'idempotency_key':str(uuid4())},headers=headers).status_code==200
        assert client.get('/api/v1/results',params={'group_id':group['id']},headers=headers).json()[0]['total']==9
        assert client.put(path,json={'absent':True,'reason':'重新核实缺考记录'},headers=headers).status_code==200
        with db.connect() as connection:assert db.get(connection,task['id'],'tasks')['status']=='invalidated'
        assert client.post('/api/v1/results/publish',json={'group_id':group['id']},headers=headers).status_code==200
        assert client.put(path,json={'absent':False,'reason':'复查'},headers=headers).status_code==409
