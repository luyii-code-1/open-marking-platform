from contextlib import contextmanager
from hashlib import sha256

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from starlette.staticfiles import StaticFiles

from server import dependencies
from server.http_guard import Guard, HttpGuardMiddleware, Policy
from server.http_guard_adaptive import AdaptiveLimiter


@pytest.fixture(autouse=True)
def database_environment():
    # Use deterministic authentication rows and a clock independent of wall time.
    pass


def test_bursts_pressure_recovery_and_memory_bound():
    now = [1000.]
    limiter = AdaptiveLimiter(lambda: now[0], capacity=2)
    assert [limiter.check('anonymous', 'ip', 12) for _ in range(2)] == [0, 0]
    assert [limiter.check('anonymous', 'ip', 12) for _ in range(3)] == [5, 5, 10]
    now[0] += 5
    assert limiter.check('anonymous', 'ip', 12) == 5
    now[0] += 61
    assert [limiter.check('anonymous', 'ip', 12) for _ in range(3)] == [0, 0, 5]
    assert limiter.check('authenticated', 'alice', 12) == 0
    assert limiter.check('authenticated', 'bob', 12) == 0
    for n in range(200):
        limiter.check('anonymous', str(n), 12)
        limiter.remember(str(n), ('user', str(n)))
    assert len(limiter._groups['anonymous']) == len(limiter._hints) == 2
    assert limiter.check('anonymous', 'ip', 12) > 0


@pytest.fixture
def guarded(tmp_path, monkeypatch):
    credentials = {'a' * 54: 'alice', 'b' * 54: 'bob'}
    rows = {sha256(key.encode()).hexdigest(): value for key, value in credentials.items()}
    calls = []

    class Database:
        def execute(self, sql, params):
            digest, _ = params
            calls.append(digest)
            self.name = rows.get(digest)
            return self

        def fetchone(self):
            return ({'id': self.name, 'name': self.name, 'username': self.name, 'role': 'teacher'}
                    if self.name else None)

    @contextmanager
    def connect():
        yield Database()

    monkeypatch.setattr(dependencies, 'connect', connect)
    app = FastAPI()
    guard = Guard(tmp_path)
    guard.adaptive = AdaptiveLimiter(lambda: 1000.)
    guard.policy = Policy.compile({'mode': 'enforce', 'adaptive_enabled': True, 'anonymous_rate_per_minute': 1,
                                   'authenticated_rate_per_minute': 12, 'sqli_mode': 'off', 'xss_mode': 'off'})
    app.state.http_guard = guard
    app.add_middleware(HttpGuardMiddleware)

    @app.get('/api/v1/tasks/{task}')
    def job(task: str, person=Depends(dependencies.user)):
        return {'id': person['id']}

    @app.get('/api/v1/public/status')
    def public():
        return {'ok': True}

    (tmp_path / 'bundle.js').write_text('/* static */', encoding='utf8')
    app.mount('/assets', StaticFiles(directory=tmp_path))
    guard.prepare_routes(app)
    with TestClient(app, client=('198.51.100.42', 4800)) as client:
        yield client, guard, rows, calls


def auth(token):
    return {'Authorization': 'Bearer ' + token}


def test_same_nat_verified_accounts_recheck_then_stop_over_quota(guarded):
    client, guard, rows, calls = guarded
    path = '/api/v1/tasks/private-ticket'
    assert client.get(path, headers=auth('a' * 54)).json()['id'] == 'alice'
    assert client.get(path, headers=auth('a' * 54)).status_code == 200
    # The router uses this request's verified result. No duplicate database read.
    assert len(calls) == 2
    limited = client.get(path, headers=auth('a' * 54))
    assert limited.status_code == 429 and limited.headers['retry-after'] == '5'
    assert len(calls) == 2
    assert client.get(path, headers=auth('b' * 54)).json()['id'] == 'bob'
    assert len(calls) == 3
    events = list(guard._events.queue)
    assert events[2]['route'] == '/api/v1/tasks/{task}' and events[2]['reason'] == 'adaptive_authenticated'
    assert 'private-ticket' not in str(events)
    rows.pop(sha256(('b' * 54).encode()).hexdigest())
    assert client.get(path, headers=auth('b' * 54)).status_code == 401
    assert len(calls) == 4
    assert list(guard._events.queue)[-1]['actor'] == ''


def test_new_credential_flood_and_unregistered_routes(guarded):
    client, guard, _, calls = guarded
    # Exhaust anonymous quota; only a bounded number of new credentials reach verification.
    for i in range(45):
        client.get('/api/v1/tasks/42', headers=auth(f'{i:054d}'))
    assert len(calls) == 10
    assert list(guard._events.queue)[-1]['reason'] == 'adaptive_anonymous'
    guard.adaptive = AdaptiveLimiter(lambda: 1000.)
    assert client.get('/assets/bundle.js', headers=auth('a' * 54)).status_code == 200
    assert client.get('/api/v1/public/status', headers=auth('a' * 54)).status_code == 200
    assert client.get('/assets/missing.js', headers=auth('a' * 54)).status_code == 429
    assert client.post('/api/v1/tasks/42', headers=auth('a' * 54)).status_code == 429
    assert len(calls) == 10
    assert client.get('/api/v1/tasks/42', headers=auth('b' * 54)).status_code == 200


def test_fixed_limit_still_precedes_verified_account(guarded):
    client, guard, _, calls = guarded
    guard.policy = Policy.compile({'mode': 'enforce', 'rate_per_minute': 1, 'adaptive_enabled': True})
    assert client.get('/api/v1/tasks/11', headers=auth('a' * 54)).status_code == 200
    assert client.get('/api/v1/tasks/11', headers=auth('b' * 54)).status_code == 429
    assert list(guard._events.queue)[-1]['reason'] == 'rate_limit'
    assert len(calls) == 1
