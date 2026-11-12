import time
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from server import db
from server.main import app
from tests.test_archive_release import seed


@pytest.fixture
def review(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers,project,page,task,template,asset,content=seed(client,tmp_path)
        with db.connect() as connection:
            group=db.get(connection,template['group_id']);group['frozen']=False;db.put(connection,'groups',group)
            task.update(status='claimed',score=None,expires_at=time.time()+900);db.put(connection,'tasks',task)
        yield client,headers,task,template


def operation(score=5,revision=0):
    return {'score':score,'idempotency_key':str(uuid4()),'offline_protocol':1,'base_score_revision':revision}


def test_offline_score_receipt_after_response_loss_and_revision_conflict(review):
    client,headers,task,template=review
    assert client.get('/api/v1/review/offline-capabilities',headers=headers).json()['protocols']==[1]
    url='/api/v1/tasks/'+task['id']+'/score';first=operation()
    response=client.post(url,headers=headers,json=first)
    assert response.status_code==200,response.text
    assert response.json()['score_revision']==1
    assert response.json()['accepted_operation']=={'id':first['idempotency_key'],'score':5}
    assert client.post(url,headers=headers,json=operation(6,0)).status_code==409
    second=operation(7,1)
    assert client.post(url,headers=headers,json=second).status_code==200
    # A late retry acknowledges precisely the first operation, without overwriting the newer score.
    late=client.post(url,headers=headers,json=first).json()
    assert late['score']==7 and late['accepted_operation']['score']==5
    with db.connect() as connection:assert connection.execute('SELECT COUNT(*) FROM scores').fetchone()[0]==2
    assert client.post(url,headers=headers,json={**first,'score':9}).status_code==409


@pytest.mark.parametrize('condition',['expired','invalidated','frozen','deleted','step','protocol','missing_revision'])
def test_offline_conflicts_preserve_server_result(review,condition):
    client,headers,task,template=review;payload=operation()
    with db.connect() as connection:
        if condition=='expired':task['expires_at']=time.time()-1
        if condition=='invalidated':task['status']='invalidated'
        if condition=='frozen':
            group=db.get(connection,template['group_id']);group['frozen']=True;db.put(connection,'groups',group)
        if condition=='deleted':connection.execute('UPDATE objects SET deleted=1 WHERE id=?',(task['id'],))
        else:db.put(connection,'tasks',task)
    if condition=='step':payload['score']=.1
    if condition=='protocol':payload['offline_protocol']=2
    if condition=='missing_revision':payload.pop('base_score_revision')
    response=client.post('/api/v1/tasks/'+task['id']+'/score',headers=headers,json=payload)
    assert response.status_code in (404,409,422),response.text
    with db.connect() as connection:assert connection.execute('SELECT COUNT(*) FROM scores').fetchone()[0]==0


def test_offline_upload_requires_same_authorized_account(review):
    client,headers,task,template=review
    account={'username':'another','name':'另一教师','password':'test-teacher-password'}
    client.post('/api/v1/users',headers=headers,json=account)
    token=client.post('/api/v1/auth/login',json=account).json()['token']
    assert client.post('/api/v1/tasks/'+task['id']+'/score',headers={'Authorization':'Bearer '+token},json=operation()).status_code==403
    assert client.get('/api/v1/review/offline-capabilities').status_code==401
