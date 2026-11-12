import io
from uuid import uuid4
from PIL import Image
from fastapi.testclient import TestClient
from server import db
from server.main import app


def test_wrong_paper_freezes_batch_and_preserves_evidence(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'long-test-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        def create(kind,body):
            response=client.post('/api/v1/'+kind,json=body,headers=headers)
            assert response.status_code==200,response.text
            return response.json()
        project=create('projects',{'name':'测试'})
        subject=create('subjects',{'name':'数学','project_id':project['id']})
        group=create('groups',{'name':'一组','subject_id':subject['id']})
        template=create('templates',{'name':'数学卡','group_id':group['id'],'paper':'A4','sides':2,'questions':[{'number':1,'type':'single','options':4,'answer':['A'],'points':3,'regions':[{'page':1,'x':15,'y':105,'width':80,'height':20}]}]})
        assert client.post('/api/v1/templates/'+template['id']+'/publish',headers=headers).status_code==200
        # Existing published QR sheets continue to enforce their original binding.
        with db.connect() as connection:
            legacy=db.get(connection,template['id']);legacy['layout_version']=2;db.put(connection,'templates',legacy)
        batch=create('scan-batches',{'group_id':group['id'],'room':'01','back_order':'reverse'})
        output=io.BytesIO(); Image.new('L',(1000,1400),255).save(output,format='PNG')
        capture=str(uuid4())
        form={'capture_id':capture,'side':'front','sequence':'1'}
        response=client.post('/api/v1/scan-batches/'+batch['id']+'/pages',data=form,files={'file':('blank.png',output.getvalue(),'image/png')},headers=headers)
        assert response.status_code==409
        assert (tmp_path/'pages'/(capture+'.image')).exists()
        assert client.get('/api/v1/scan-batches/'+batch['id'],headers=headers).json()['status']=='frozen'
        assert client.post('/api/v1/scan-batches/'+batch['id']+'/pair',headers=headers).status_code==409
        retry=client.post('/api/v1/scan-batches/'+batch['id']+'/pages',data=form,files={'file':('blank.png',output.getvalue(),'image/png')},headers=headers)
        assert retry.status_code==409
        assert len(client.get('/api/v1/scan-batches/'+batch['id']+'/pages',headers=headers).json())==1
        assert client.post('/api/v1/scan-batches/'+batch['id']+'/resume',json={'reason':'继续扫描'},headers=headers).status_code==409
        assert client.put('/api/v1/pages/'+capture,json={'excluded':True,'reason':'混入其他考卷'},headers=headers).status_code==200
        assert client.post('/api/v1/scan-batches/'+batch['id']+'/resume',json={'reason':'已移出混卷'},headers=headers).status_code==200
        assert client.get('/api/v1/scan-batches/'+batch['id'],headers=headers).json()['status']=='front'
