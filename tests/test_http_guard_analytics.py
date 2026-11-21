import json
import sqlite3
import time
from contextlib import closing
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.dependencies import set_request_actor
from server.http_guard_analytics import router
from server.http_guard_store import GuardStore


def test_upgrade_preserves_policy_and_events_and_analytics_uses_new_data(tmp_path):
    store = GuardStore(tmp_path)
    store.path.parent.mkdir()
    with closing(sqlite3.connect(store.path)) as old, old:
        old.execute('CREATE TABLE policy(id INTEGER PRIMARY KEY, revision INTEGER, body TEXT)')
        old.execute('INSERT INTO policy VALUES (1,7,?)', (json.dumps({'retention_days': 18, 'mode': 'off'}),))
        old.execute('''CREATE TABLE event(id INTEGER PRIMARY KEY, ts REAL, ip TEXT, country TEXT, method TEXT,
                    route TEXT, status INTEGER,duration_ms REAL,bytes_out INTEGER,decision TEXT,reason TEXT)''')
        old.execute("INSERT INTO event VALUES (1,?,'','','GET','/old',200,1,2,'pass','')", (time.time(),))
    assert store.settings()['revision'] == 7 and store.settings()['mode'] == 'off'
    assert store.settings()['sqli_mode'] == 'observe'
    assert store.events(1, '', '', None, 10)['items'][0]['actor_label'] == ''
    assert store.analytics(1)['routes'] == []

    now = time.time()
    view = {'kind': 'page_view', 'id': 'a', 'visitor': b'visitor1', 'page': 'exams', 'ts': now}
    event = {'ts': now, 'ip': '192.0.2.1', 'country': '', 'method': 'GET', 'route': '/api/v1/groups',
             'status': 200, 'duration_ms': 2, 'bytes_out': 5, 'decision': 'pass', 'reason': '',
             'actor': 'abc', 'actor_label': 'teacher', 'actor_kind': 'user'}
    store.append([view, view, {**view, 'id': 'b'}, {**view, 'id': 'c', 'visitor': b'visitor2'},
                  event, {**event, 'status': 503, 'duration_ms': 18},
                  {**event, 'route': '/api/v1/health', 'actor': 'device', 'actor_kind': 'device'},
                  {**event, 'route': '/api/v1/telemetry/page-view', 'actor': '', 'actor_kind': ''}])
    other_worker = GuardStore(tmp_path)
    result = other_worker.analytics(1)
    assert (result['pv'], result['uv'], result['active_accounts']) == (3, 2, 1)
    assert result['pages'] == [{'page': 'exams', 'pv': 3}] and sum(row['pv'] for row in result['series']) == 3
    assert result['routes'] == [{'route': '/api/v1/groups', 'method': 'GET', 'requests': 2,
                                 'errors': 1, 'avg_ms': 10, 'max_ms': 18, 'p95_ms': 18}]
    assert other_worker.events(1, '', '', None, 10)['items'][2]['actor_label'] == 'teacher'
    errors = other_worker.events(1, '', '', None, 10, 'teacher', '', 5)
    assert len(errors['items']) == 1 and errors['items'][0]['status'] == 503
    assert other_worker.events(1, '', '', None, 10, 'abc', 'deny_ip', 5)['items'] == []
    old_time = now - 2 * 86400
    other_worker.append([{**view, 'id': 'old', 'visitor': b'old', 'ts': old_time},
                         {**event, 'actor': 'old', 'ts': old_time}])
    other_worker.purge(1)
    assert other_worker.analytics(0)['pv'] == 3 and other_worker.analytics(0)['active_accounts'] == 1


def test_public_collector_origin_shape_off_and_identity():
    events = []
    service = SimpleNamespace(policy=SimpleNamespace(mode='observe'), offer=events.append)
    app = FastAPI()
    app.include_router(router)
    app.state.http_guard = service
    visitor = str(uuid4())
    view = {'id': str(uuid4()), 'visitor': visitor, 'page': 'login'}
    headers = {'Origin': 'http://testserver'}
    with TestClient(app) as client:
        path = '/api/v1/telemetry/page-view'
        assert client.get('/api/v1/system/http-guard/analytics').status_code == 401
        assert client.post(path, json=view, headers={'Origin': 'https://external.example'}).status_code == 403
        assert client.post(path, json={**view, 'actor': 'x'}, headers=headers).status_code == 422
        assert client.post(path, json={**view, 'page': '/exams/student-id'}, headers=headers).status_code == 422
        assert client.post(path, json={**view, 'page': 'x' * 600}, headers=headers).status_code == 413
        assert client.post(path, json=view, headers=headers).status_code == 204
        assert len(events) == 1 and len(events[0]['visitor']) == 32 and events[0]['visitor'] != visitor.encode()
        service.policy.mode = 'off'
        assert client.post(path, json=view, headers=headers).status_code == 204 and len(events) == 1
    req = SimpleNamespace(state=SimpleNamespace())
    set_request_actor(req, {'id': 'u1', 'name': 'Teacher', 'username': 'teacher', 'role': 'teacher'})
    assert (req.state.actor, req.state.actor_label, req.state.actor_kind) == ('u1', 'teacher', 'user')
    set_request_actor(req, {'id': 's1', 'name': 'Scanner', 'role': 'scanner'})
    assert (req.state.actor_label, req.state.actor_kind) == ('Scanner', 'device')
