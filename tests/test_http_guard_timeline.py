from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.dependencies import system_admin, user
from server.http_guard_analytics import router
from server.http_guard_store import GuardStore
from server.http_guard_timeline import timeline


@pytest.fixture(autouse=True)
def database_environment():
    # The traffic store and authenticated router can be exercised independently of business storage.
    pass


SHANGHAI = timezone(timedelta(hours=8))
MIDNIGHT = int(datetime(2026, 11, 21, tzinfo=SHANGHAI).timestamp())


def event(ts, person, duration, status=200, kind='user', decision='pass'):
    return {'ts': ts, 'ip': '192.0.2.1', 'country': '', 'method': 'GET', 'route': '/api/v1/tasks',
            'status': status, 'duration_ms': duration, 'bytes_out': 30, 'decision': decision, 'reason': '',
            'actor': person, 'actor_kind': kind}


def view(ts, visitor, page, key):
    return {'kind': 'page_view', 'id': key, 'ts': ts, 'visitor': visitor, 'page': page}


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr('time.time', lambda: MIDNIGHT + 3600 + 15)
    store = GuardStore(tmp_path)
    with store.connection() as db:
        db.execute('UPDATE web_collection SET started=?', (MIDNIGHT - 86400,))
        db.execute('UPDATE web_uv_collection SET started=?', (MIDNIGHT - 3600,))
    return store


def test_bucket_identity_dedup_shanghai_edges_and_weighted_times(store):
    begin = MIDNIGHT - 60
    first = view(begin + 1, b'a', 'exams', 'v1')
    store.append([first, first, view(begin + 3, b'a', 'scanner', 'v2'), view(MIDNIGHT, b'a', 'exams', 'v3'),
                  view(MIDNIGHT + 1, b'b', 'exams', 'v4'),
                  event(begin + .5, 'alice', 10), event(MIDNIGHT, 'alice', 20, decision='observed'),
                  event(MIDNIGHT + 40.9, 'bob', 300, 503), event(MIDNIGHT + 52, 'device1', 70, 403, 'device', 'blocked'),
                  view(MIDNIGHT + 120, b'outside', 'login', 'v5'), event(MIDNIGHT + 120, 'outside', 999)])
    result = timeline(store, begin, MIDNIGHT + 120, 'day')
    assert result['http_first_record'] == begin
    a, b = result['series']
    assert (a['ts'], a['start'], a['end']) == (MIDNIGHT - 86400, begin, MIDNIGHT)
    assert (b['ts'], b['start'], b['end']) == (MIDNIGHT, MIDNIGHT, MIDNIGHT + 120)
    assert (a['pv'], a['uv'], a['active_accounts'], a['avg_ms']) == (2, 1, 1, 10)
    assert (b['pv'], b['uv'], b['active_accounts'], b['avg_ms']) == (2, 2, 2, 130)
    assert result['totals'] == {'pv': 4, 'uv': 2, 'active_accounts': 2, 'requests': 4, 'blocked': 1,
                                'observed': 1, 'server_errors': 1, 'avg_ms': 100, 'bytes_out': 120}
    minute = timeline(store, begin, MIDNIGHT + 120)
    assert minute['interval'] == 'minute' and minute['series'][-1]['avg_ms'] is None
    assert minute['series'][-1]['uv'] == minute['series'][-1]['active_accounts'] == 0


def test_older_pv_survives_unknown_identity_coverage(store):
    with store.connection() as db:
        db.execute('UPDATE web_uv_collection SET started=?', (MIDNIGHT,))
        db.execute('UPDATE web_collection SET started=?', (MIDNIGHT - 30,))
        db.execute('INSERT INTO web_page VALUES (?, ?, ?)', (MIDNIGHT - 60, 'exams', 7))
        db.execute('INSERT INTO web_visitor VALUES (?, ?)', (b'old-visitor', MIDNIGHT - 20))
    store.append([view(MIDNIGHT + 3, b'new', 'exams', 'v1'), event(MIDNIGHT + 1, 'user', 5)])
    result = timeline(store, MIDNIGHT - 60, MIDNIGHT + 60, 'minute')
    old, new = result['series']
    assert old['pv'] == 7 and old['uv'] is None and old['active_accounts'] is None
    assert new['uv'] == new['active_accounts'] == 1
    assert result['totals']['pv'] == 8 and result['totals']['uv'] is result['totals']['active_accounts'] is None
    crossing = timeline(store, MIDNIGHT - 60, MIDNIGHT + 60, 'hour')
    assert crossing['series'][0]['uv'] is None
    with store.connection() as db:
        db.execute('UPDATE web_uv_collection SET started=?', (MIDNIGHT + 60,))
    assert timeline(store, MIDNIGHT, MIDNIGHT + 120, 'hour')['series'][0]['uv'] is None


def test_bounds_granularity_retention_and_purge(store):
    config = store.settings()
    store.save_settings({**config, 'retention_days': 1}, config['revision'])
    oldest = MIDNIGHT + 3600 - 86400 + 60
    with store.connection() as db:
        db.execute('INSERT INTO web_visitor_minute VALUES (?,?)', (oldest - 120, b'old'))
    clipped = timeline(store, oldest - 1200, MIDNIGHT + 7200)
    assert clipped['start'] == oldest and clipped['end'] == MIDNIGHT + 3660 and clipped['interval'] == 'hour'
    with pytest.raises(ValueError):
        timeline(store, oldest - 180, oldest - 60)
    with pytest.raises(ValueError):
        timeline(store, MIDNIGHT + 7200, MIDNIGHT + 10800)
    with pytest.raises(ValueError):
        timeline(store, oldest, MIDNIGHT, 'minute')
    store.purge(1)
    with store.connection() as db:
        assert db.execute('SELECT count(*) FROM web_visitor_minute').fetchone()[0] == 0
        index = db.execute("EXPLAIN QUERY PLAN SELECT count(DISTINCT actor) FROM event "
                           "WHERE ts>=? AND ts<? AND actor_kind='user' AND actor<>''", (oldest, MIDNIGHT))
        assert any('event_user_time' in row[-1] for row in index)


def test_live_totals_use_last_seen_across_history_boundary(store):
    with store.connection() as db:
        db.execute('UPDATE web_uv_collection SET started=?', (MIDNIGHT + 3660,))
        db.execute('UPDATE web_collection SET started=?', (MIDNIGHT + 3610,))
        for table in ('web_visitor', 'web_account'):
            db.executemany(f'INSERT INTO {table} VALUES (?,?)',
                           [('a', MIDNIGHT + 15), ('b', MIDNIGHT + 3603), ('older', MIDNIGHT - 1)])
    result = timeline(store, MIDNIGHT, MIDNIGHT + 3660, 'hour')
    assert result['totals']['uv'] == result['totals']['active_accounts'] == 2
    assert result['series'][0]['uv'] is result['series'][0]['active_accounts'] is None
    assert result['series'][-1]['uv'] == result['series'][-1]['active_accounts'] == 1
    closed = timeline(store, MIDNIGHT, MIDNIGHT + 3600, 'hour')
    assert closed['totals']['uv'] is closed['totals']['active_accounts'] is None


def test_timeline_admin_api_validation(store):
    app = FastAPI()
    app.state.http_guard = SimpleNamespace(store=store)
    app.include_router(router)
    with TestClient(app) as client:
        path = '/api/v1/system/http-guard/timeline'
        params = {'start': MIDNIGHT, 'end': MIDNIGHT + 60}
        assert client.get(path, params=params).status_code == 401
        app.dependency_overrides[user] = lambda: {'role': 'teacher'}
        assert client.get(path, params=params).status_code == 403
        app.dependency_overrides[system_admin] = lambda: {'role': 'admin'}
        result = client.get(path, params=params)
        assert result.status_code == 200 and result.json()['step_seconds'] == 60
        assert result.json()['http_first_record'] is None
        assert result.headers['cache-control'] == 'private, no-store'
        for invalid in ({'start': MIDNIGHT + 1}, {'end': MIDNIGHT}, {'interval': 'second'}):
            assert client.get(path, params={**params, **invalid}).status_code == 422
