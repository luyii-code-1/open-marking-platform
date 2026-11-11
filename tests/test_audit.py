import json
from fastapi.testclient import TestClient
from server import db
from server.main import app


def test_admin_audit_cursor_redaction_and_access_metadata_without_credentials(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        logged=client.post('/api/v1/auth/login',json=account).json();headers={'Authorization':'Bearer '+logged['token']}
        teacher={'username':'teacher','password':'teacher-password','name':'教师'}
        person=client.post('/api/v1/users',json=teacher,headers=headers).json()
        token=client.post('/api/v1/auth/login',json=teacher).json()['token'];other={'Authorization':'Bearer '+token}
        assert client.get('/api/v1/system/audit',headers=other).status_code==403
        assert client.get('/api/v1/system/requests',headers=other).status_code==403
        assert client.post('/api/v1/auth/login',json={**account,'password':'wrong-secret-password'}).status_code==401
        assert client.get('/api/v1/no-such-route?token=query-secret').status_code==404
        assert client.get('/api/v1/archive-download/private-download-ticket').status_code==403
        created=client.post('/api/v1/projects',json={'name':'项目','secret':'audit-secret','nested':{'password':'nested-secret'}},headers=headers).json()
        audit=client.get('/api/v1/system/audit',params={'object_id':created['id']},headers=headers).json()
        assert len(audit['items'])==1 and audit['items'][0]['actor']==logged['user']['id']
        assert audit['items'][0]['body']['secret']=='[已隐藏]' and audit['items'][0]['body']['nested']['password']=='[已隐藏]'
        first=client.get('/api/v1/system/audit?limit=1',headers=headers).json()
        second=client.get('/api/v1/system/audit',params={'limit':1,'before':first['next_before']},headers=headers).json()
        assert first['items'][0]['id']!=second['items'][0]['id']
        assert client.get('/api/v1/system/audit?kind=none%27%20OR%201=1',headers=headers).json()['items']==[]
        requests=client.get('/api/v1/system/requests?limit=200',headers=headers).json()
        assert requests['writer_errors']==0
        serialized=json.dumps(requests)
        for secret in (account['password'],teacher['password'],'wrong-secret-password','query-secret','private-download-ticket',logged['token'],token,'nested-secret'):assert secret not in serialized
        denied=client.get('/api/v1/system/requests',params={'actor':person['id'],'status':403},headers=headers).json()['items']
        assert {r['route'] for r in denied}=={'/api/v1/system/audit','/api/v1/system/requests'}
        assert all(r['method']=='GET' and r['duration_ms']>=0 for r in denied)
        assert any(r['route']=='/api/v1/archive-download/{token}' for r in requests['items'])
    # The journal drains before application shutdown and remains available in backup data.
    with db.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM request_log WHERE status=401').fetchone()[0]>=1
        assert connection.execute('SELECT COUNT(*) FROM request_log WHERE actor=?',(logged['user']['id'],)).fetchone()[0]>0
