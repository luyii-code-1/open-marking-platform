import asyncio
import json
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from server import db,realtime
from server.main import app


def login(client):
    body={'username':'admin','password':'administrator-password','name':'管理员'}
    client.post('/api/v1/auth/bootstrap',json=body)
    return client.post('/api/v1/auth/login',json=body).json()['token']


def test_websocket_origin_auth_no_query_token_and_revocation(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);monkeypatch.setenv('OMP_WS_ORIGINS','http://testserver');monkeypatch.setattr(realtime,'POLL_SECONDS',.02)
    with TestClient(app) as client:
        token=login(client)
        for url,origin in [('/api/v1/events','https://foreign.example'),('/api/v1/events?token=forbidden','http://testserver')]:
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(url,headers={'origin':origin}):pass
        with pytest.raises(WebSocketDisconnect) as invalid:
            with client.websocket_connect('/api/v1/events',headers={'origin':'http://testserver'}) as socket:
                socket.send_json({'type':'auth','token':'invalid'});socket.receive_json()
        assert invalid.value.code==4401
        for binary in (False,True):
            with pytest.raises(WebSocketDisconnect) as malformed:
                with client.websocket_connect('/api/v1/events',headers={'origin':'http://testserver'}) as socket:
                    if binary:socket.send_bytes(b'invalid')
                    else:socket.send_text('{')
                    socket.receive_json()
            assert malformed.value.code==1008
        with client.websocket_connect('/api/v1/events',headers={'origin':'http://testserver'}) as socket:
            socket.send_json({'type':'auth','token':token});assert socket.receive_json()=={'type':'ready'}
            response=client.post('/api/v1/projects',json={'name':'项目'},headers={'Authorization':'Bearer '+token})
            assert response.status_code==200
            event=socket.receive_json()
            assert event=={'type':'invalidate','roots':['exam-catalog','projects']}
            assert token not in json.dumps(event) and response.json()['id'] not in json.dumps(event)
            assert client.post('/api/v1/auth/logout',headers={'Authorization':'Bearer '+token}).status_code==200
            with pytest.raises(WebSocketDisconnect) as revoked:socket.receive_json()
            assert revoked.value.code==4401


def test_teacher_scope_assignment_removal_and_queue_coalescing(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);db.initialize()
    uid,other=str(uuid4()),str(uuid4())
    with db.connect() as connection:
        project=db.put(connection,'projects',{'name':'项目'})
        subject=db.put(connection,'subjects',{'project_id':project['id'],'name':'科目'})
        group=db.put(connection,'groups',{'subject_id':subject['id'],'name':'组'})
        template=db.put(connection,'templates',{'group_id':group['id'],'questions':[]})
        assignment=db.put(connection,'assignments',{'template_id':template['id'],'question_id':str(uuid4()),'user_ids':[uid]})
        previous=realtime.permissions(connection,{uid,other})
        assignment['user_ids']=[other];db.put(connection,'assignments',assignment)
        current=realtime.permissions(connection,{uid,other})
    person={'id':uid,'role':'teacher','name':'教师'}
    assert 'templates' in realtime.topics(person,current[uid],previous[uid],'assignments',assignment)
    task={'template_id':template['id'],'user_id':other,'score':10,'candidate_number':'123'}
    assert realtime.topics(person,previous[uid],previous[uid],'tasks',task)=={'review-progress','dashboard','results','analysis'}
    assert realtime.topics({'id':other,'role':'teacher'},previous[other],previous[other],'tasks',task)=={'review-progress','dashboard','results','analysis','tasks'}
    foreign={**task,'template_id':str(uuid4()),'user_id':str(uuid4())}
    assert realtime.topics(person,previous[uid],previous[uid],'tasks',foreign)==set()
    async def coalesce():
        client=realtime.Client('digest',person,previous[uid])
        for root in ('tasks','results','analysis'):client.offer({'type':'invalidate','roots':[root]})
        assert client.queue.qsize()==1 and await client.queue.get()=={'type':'sync'}
    asyncio.run(coalesce())
def test_peer_disconnect_during_close_is_handled(monkeypatch):
    import asyncio
    from fastapi import WebSocketDisconnect
    from server.realtime import events
    monkeypatch.setenv('OMP_WS_ORIGINS','https://localhost')
    class Disconnected:
        headers={'origin':'https://localhost'}
        query_params={}
        async def accept(self):pass
        async def receive_text(self):raise WebSocketDisconnect(code=1006)
        async def close(self,code):raise WebSocketDisconnect(code=1006)
    asyncio.run(events(Disconnected()))


def test_grouped_review_updates_keep_teacher_scope(tmp_path, monkeypatch):
    import hashlib
    import time

    monkeypatch.setattr(db, 'ROOT', tmp_path)
    db.initialize()
    teacher_ids = [str(uuid4()) for _ in range(3)]
    tokens = [str(uuid4()) for _ in teacher_ids]
    with db.connect() as conn:
        for uid, token in zip(teacher_ids, tokens):
            conn.execute('INSERT INTO users VALUES(?,?,?,?,?)', (uid, uid, uid, 'teacher', 'unused'))
            conn.execute('INSERT INTO sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), uid, time.time()+600))
        template = db.put(conn, 'templates', {'questions': []})
        db.put(conn, 'assignments', {'template_id': template['id'], 'user_ids': teacher_ids[:2]})
    clients = [realtime.authenticate(token) for token in tokens]
    hub = realtime.Hub()
    hub.cursor = clients[0].start_cursor
    with db.connect() as conn:
        for _ in range(3):
            db.put(conn, 'tasks', {'template_id': template['id'], 'user_id': teacher_ids[0]})
    _, changes = hub.collect(clients)
    roots = {client.person['id']: updated for client, _, _, updated in changes}
    assert roots[teacher_ids[0]] == {'tasks', 'dashboard', 'review-progress', 'results', 'analysis'}
    assert roots[teacher_ids[1]] == {'dashboard', 'review-progress', 'results', 'analysis'}
    assert roots[teacher_ids[2]] == set()

