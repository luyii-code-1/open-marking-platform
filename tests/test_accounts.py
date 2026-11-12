import base64
import hashlib
import json
import os
import cbor2
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from fastapi.testclient import TestClient
from server import db
from server.main import app


def login_admin(client):
    account={'username':'admin','name':'管理员','password':'administrator-password'}
    client.post('/api/v1/auth/bootstrap',json=account)
    token=client.post('/api/v1/auth/login',json=account).json()['token']
    return {'Authorization':'Bearer '+token}


def test_recovery_codes_are_single_use_and_change_password_revokes_sessions(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers=login_admin(client)
        codes=client.post('/api/v1/auth/recovery-codes',json={'password':'administrator-password'},headers=headers)
        assert codes.status_code==200
        code=codes.json()['codes'][0]
        with db.connect() as connection:
            assert all(code not in row['body'] for row in connection.execute('SELECT body FROM objects'))
        payload={'username':'admin','code':code,'new_password':'changed-password-123'}
        assert client.post('/api/v1/auth/recovery-reset',json={**payload,'new_password':'short'}).status_code==422
        assert client.post('/api/v1/auth/recovery-reset',json={**payload,'code':'incorrect-code'}).status_code==401
        assert client.get('/api/v1/auth/me',headers=headers).status_code==200
        reset=client.post('/api/v1/auth/recovery-reset',json=payload)
        assert reset.status_code==200 and 'token' not in reset.json()
        assert client.post('/api/v1/auth/recovery-reset',json=payload).status_code==401
        assert client.get('/api/v1/auth/me',headers=headers).status_code==401
        assert client.post('/api/v1/auth/login',json={'username':'admin','password':'administrator-password'}).status_code==401
        login=client.post('/api/v1/auth/login',json={'username':'admin','password':'changed-password-123'})
        assert login.status_code==200
        headers={'Authorization':'Bearer '+login.json()['token']}
        assert client.post('/api/v1/auth/password',json={'password':'changed-password-123','new_password':'another-password-123'},headers=headers).status_code==200
        assert client.get('/api/v1/auth/me',headers=headers).status_code==401
        with db.connect() as connection:
            assert all(payload['new_password'] not in row['body'] and code not in row['body'] for row in connection.execute('SELECT body FROM objects'))


def test_login_portal_permissions_do_not_issue_admin_session_to_teacher(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers=login_admin(client)
        teacher={'username':'teacher','name':'教师','password':'teacher-password-123','role':'teacher'}
        assert client.post('/api/v1/users',json=teacher,headers=headers).status_code==200
        with db.connect() as connection:before=connection.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
        assert client.post('/api/v1/auth/login',json={**teacher,'portal':'admin'}).status_code==403
        assert client.post('/api/v1/auth/login',json={**teacher,'portal':'invalid'}).status_code==422
        assert client.post('/api/v1/auth/passkeys/login/options',json={'username':'teacher','portal':'admin'}).status_code==403
        with db.connect() as connection:assert connection.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]==before
        response=client.post('/api/v1/auth/login',json={**teacher,'portal':'marking'})
        assert response.status_code==200 and response.json()['user']['role']=='teacher'
        assert client.get('/api/v1/users',headers={'Authorization':'Bearer '+response.json()['token']}).status_code==403
        for portal in ('admin','marking'):
            assert client.post('/api/v1/auth/login',json={'username':'admin','password':'administrator-password','portal':portal}).status_code==200


def test_recovery_reset_code_cannot_be_used_twice_concurrently(tmp_path,monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers=login_admin(client)
        code=client.post('/api/v1/auth/recovery-codes',json={'password':'administrator-password'},headers=headers).json()['codes'][0]
        def reset(index):
            password=f'recovered-password-{index}'
            response=client.post('/api/v1/auth/recovery-reset',json={'username':'admin','code':code,'new_password':password})
            return response.status_code,password
        with ThreadPoolExecutor(max_workers=2) as pool:responses=list(pool.map(reset,range(2)))
        assert sorted(status for status,_ in responses)==[200,401]
        for status,password in responses:
            assert client.post('/api/v1/auth/login',json={'username':'admin','password':password}).status_code==(200 if status==200 else 401)


def test_real_webauthn_signature_origin_and_replay_validation(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);monkeypatch.setenv('OMP_RP_ID','localhost');monkeypatch.setenv('OMP_WEBAUTHN_ORIGINS','https://localhost')
    def encoded(value):return base64.urlsafe_b64encode(value).rstrip(b'=').decode()
    key=ec.generate_private_key(ec.SECP256R1());public=key.public_key().public_numbers();credential_id=os.urandom(32)
    cose=cbor2.dumps({1:2,3:-7,-1:1,-2:public.x.to_bytes(32,'big'),-3:public.y.to_bytes(32,'big')})
    rp_hash=hashlib.sha256(b'localhost').digest()
    with TestClient(app) as client:
        headers=login_admin(client)
        options=client.post('/api/v1/auth/passkeys/register/options',json={'password':'administrator-password'},headers=headers).json()
        client_data=json.dumps({'type':'webauthn.create','challenge':options['options']['challenge'],'origin':'https://localhost'}).encode()
        auth_data=rp_hash+b'\x45'+bytes(4)+bytes(16)+len(credential_id).to_bytes(2,'big')+credential_id+cose
        credential={'id':encoded(credential_id),'rawId':encoded(credential_id),'type':'public-key','response':{'clientDataJSON':encoded(client_data),'attestationObject':encoded(cbor2.dumps({'fmt':'none','attStmt':{},'authData':auth_data}))}}
        registered=client.post('/api/v1/auth/passkeys/register/verify',json={'challenge_id':options['challenge_id'],'credential':credential,'name':'测试密钥'},headers=headers)
        assert registered.status_code==200,registered.text
        options=client.post('/api/v1/auth/passkeys/login/options',json={'username':'admin','portal':'admin'}).json()
        auth_data=rp_hash+b'\x05'+(1).to_bytes(4,'big')
        def assertion(origin):
            data=json.dumps({'type':'webauthn.get','challenge':options['options']['challenge'],'origin':origin}).encode()
            signature=key.sign(auth_data+hashlib.sha256(data).digest(),ec.ECDSA(hashes.SHA256()))
            return {'id':encoded(credential_id),'rawId':encoded(credential_id),'type':'public-key','response':{'clientDataJSON':encoded(data),'authenticatorData':encoded(auth_data),'signature':encoded(signature)}}
        path='/api/v1/auth/passkeys/login/verify'
        assert client.post(path,json={'challenge_id':options['challenge_id'],'credential':assertion('https://other.example')}).status_code==401
        payload={'challenge_id':options['challenge_id'],'credential':assertion('https://localhost')}
        response=client.post(path,json=payload)
        assert response.status_code==200,response.text
        assert client.get('/api/v1/auth/me',headers={'Authorization':'Bearer '+response.json()['token']}).status_code==200
        assert client.post(path,json=payload).status_code==401
