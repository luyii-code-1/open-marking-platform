import base64
import hashlib
import io
import time
from uuid import uuid4
from PIL import Image
from fastapi.testclient import TestClient
from cryptography.hazmat.primitives import serialization,hashes
from cryptography.hazmat.primitives.asymmetric import ec
from server import db
from server.main import app


def b64(value):return base64.urlsafe_b64encode(value).decode().rstrip('=')
def signed(key,challenge):
    content=f"OMP-SCANNER-1\n{challenge['id']}\n{challenge['nonce']}\n{challenge['device_id']}".encode()
    return b64(key.sign(content,ec.ECDSA(hashes.SHA256())))


def initialize(client):
    account={'username':'admin','password':'administrator-password','name':'管理员'}
    client.post('/api/v1/auth/bootstrap',json=account)
    logged=client.post('/api/v1/auth/login',json=account).json()
    return {'Authorization':'Bearer '+logged['token']},logged['user']['id']


def enroll(client,admin):
    key=ec.generate_private_key(ec.SECP256R1())
    public=b64(key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo))
    body={'label':'扫描工作台','public_key':public,'password':'administrator-password'}
    response=client.post('/api/v1/scanner/devices',json=body,headers=admin)
    assert response.status_code==200,response.text
    return key,response.json(),body


def connect(client,key,device):
    challenge=client.post('/api/v1/scanner/challenge',json={'device_id':device['id']}).json()
    response=client.post('/api/v1/scanner/authenticate',json={'challenge_id':challenge['id'],'signature':signed(key,challenge)})
    assert response.status_code==200,response.text
    return {'Authorization':'Bearer '+response.json()['token']},challenge


def test_device_scope_ownership_revocation_and_challenge_replay(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        admin,owner=initialize(client)
        key,device,registration=enroll(client,admin)
        assert 'public_key' not in device and device['algorithm']=='ES256'
        assert client.post('/api/v1/scanner/devices',json={**registration,'password':'wrong'},headers=admin).status_code==403
        assert client.post('/api/v1/scanner/devices',json=registration,headers=admin).json()['id']==device['id']
        headers,challenge=connect(client,key,device)
        assert client.post('/api/v1/scanner/authenticate',json={'challenge_id':challenge['id'],'signature':signed(key,challenge)}).status_code==409
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'考试','private_note':'不应给设备'})
            subject=db.put(connection,'subjects',{'name':'语文','project_id':project['id']})
            group=db.put(connection,'groups',{'name':'组','subject_id':subject['id'],'reopen_reason':'私有核查记录'})
            template=db.put(connection,'templates',{'name':'卡','group_id':group['id'],'status':'published','revision':1,'paper':'A4','sides':1,'questions':[{'id':str(uuid4()),'answer':['A']} ]})
            group['template_id']=template['id'];db.put(connection,'groups',group)
        assert client.get('/api/v1/projects',headers=headers).json()[0]=={'id':project['id'],'name':'考试'}
        assert 'questions' not in client.get('/api/v1/templates',headers=headers).json()[0]
        assert 'reopen_reason' not in client.get('/api/v1/groups',headers=headers).json()[0]
        for route in ('users','students','classes','assignments','scanner/devices','auth/me'):
            assert client.get('/api/v1/'+route,headers=headers).status_code==401
        assert client.post('/api/v1/projects',json={'name':'越权'},headers=headers).status_code==401
        batch=client.post('/api/v1/scan-batches',json={'group_id':group['id'],'scanner_device_id':'spoof','project_id':'spoof'},headers=headers).json()
        assert batch['scanner_device_id']==device['id'] and 'project_id' not in batch
        key2,device2,_=enroll(client,admin);other,_=connect(client,key2,device2)
        for route in (f"scan-batches/{batch['id']}",f"scan-batches/{batch['id']}/pages"):
            assert client.get('/api/v1/'+route,headers=other).status_code==403
        assert client.post(f"/api/v1/scan-batches/{batch['id']}/pair",headers=other).status_code==403
        image=io.BytesIO();Image.new('L',(1000,1400),255).save(image,format='PNG')
        assert client.post(f"/api/v1/scan-batches/{batch['id']}/pages",data={'capture_id':str(uuid4()),'side':'front','sequence':'1'},files={'file':('page.png',image.getvalue(),'image/png')},headers=other).status_code==403
        legacy=client.post('/api/v1/scan-batches',json={'group_id':group['id']},headers=admin).json()
        assert client.get(f"/api/v1/scan-batches/{legacy['id']}",headers=headers).status_code==403
        assert client.post(f"/api/v1/scanner/devices/{device['id']}/adopt-batches",json={'batch_ids':[legacy['id']]},headers=admin).status_code==200
        assert client.get(f"/api/v1/scan-batches/{legacy['id']}",headers=headers).status_code==200
        assert client.post(f"/api/v1/scanner/devices/{device2['id']}/adopt-batches",json={'batch_ids':[legacy['id']]},headers=admin).status_code==409
        status=f"/api/v1/scanner/devices/{device['id']}/status"
        assert client.post(status,json={'enabled':False,'reason':'停用测试'},headers=admin).status_code==200
        assert client.get('/api/v1/projects',headers=headers).status_code==403
        assert client.post(f"/api/v1/scanner/devices/{device2['id']}/adopt-batches",json={'batch_ids':[legacy['id']],'migrate_revoked':True,'reason':'旧设备停用后迁移'},headers=admin).status_code==200
        assert client.post('/api/v1/scanner/devices',json=registration,headers=admin).status_code==403
        assert client.post(status,json={'enabled':True,'reason':'核对设备','password':'administrator-password'},headers=admin).status_code==200
        assert client.get('/api/v1/projects',headers=headers).status_code==401
        renewed,_=connect(client,key,device)
        assert client.get('/api/v1/projects',headers=renewed).status_code==200
        with db.connect() as connection:
            sessions=db.objects(connection,'scanner-sessions')
            assert all('token' not in s and 'token_hash' in s for s in sessions)


def test_bad_signature_consumes_challenge_expiry_rate_limit_and_owner_role(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        admin,owner=initialize(client);key,device,_=enroll(client,admin)
        challenge=client.post('/api/v1/scanner/challenge',json={'device_id':device['id']}).json()
        wrong=ec.generate_private_key(ec.SECP256R1())
        assert client.post('/api/v1/scanner/authenticate',json={'challenge_id':challenge['id'],'signature':signed(wrong,challenge)}).status_code==403
        assert client.post('/api/v1/scanner/authenticate',json={'challenge_id':challenge['id'],'signature':signed(key,challenge)}).status_code==409
        expired=client.post('/api/v1/scanner/challenge',json={'device_id':device['id']}).json()
        with db.connect() as connection:
            value=db.get(connection,expired['id'],'scanner-challenges');value['expires_at']=0;db.put(connection,'scanner-challenges',value)
        assert client.post('/api/v1/scanner/authenticate',json={'challenge_id':expired['id'],'signature':signed(key,expired)}).status_code==409
        headers,_=connect(client,key,device)
        with db.connect() as connection:connection.execute("UPDATE users SET role='teacher' WHERE id=?",(owner,))
        assert client.get('/api/v1/projects',headers=headers).status_code==403
        with db.connect() as connection:connection.execute("UPDATE users SET role='admin' WHERE id=?",(owner,))
        _,limited,_=enroll(client,admin)
        for _ in range(5):assert client.post('/api/v1/scanner/challenge',json={'device_id':limited['id']}).status_code==200
        assert client.post('/api/v1/scanner/challenge',json={'device_id':limited['id']}).status_code==429
