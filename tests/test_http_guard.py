import queue
import socket
import time

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.http_guard import Guard, HttpGuardMiddleware, Policy, validate_settings
from server.http_guard_store import GuardStore


@pytest.fixture(autouse=True)
def database_environment():
    # These isolated ASGI tests use only the optional traffic database.
    pass


def test_trust_chain_ip_precedence_and_country_rules(tmp_path, monkeypatch):
    monkeypatch.setenv('OMP_HTTP_TRUSTED_PROXIES', 'proxy,10.0.0.0/24')
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *args, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 0, '', ('192.0.2.9', 0))])
    guard = Guard(tmp_path)
    guard._maintain(refresh_proxies=True)
    scope = {'client': ('192.0.2.9', 51234), 'headers': [
        (b'x-forwarded-for', b'203.0.113.10, 198.51.100.42'), (b'x-forwarded-for', b'10.0.0.5')]}
    assert guard.client_ip(scope) == '198.51.100.42'
    assert guard.client_ip({**scope, 'client': ('198.51.100.99', 51234)}) == '198.51.100.99'
    assert guard.client_ip({**scope, 'headers': [(b'x-forwarded-for', b'invalid')]}) == ''
    monkeypatch.setattr(guard.geo, 'country', lambda ip: 'CN' if ip == '198.51.100.42' else '')
    settings = {'allow_ips': ['::ffff:203.0.113.10'], 'deny_ips': ['203.0.113.0/24'],
                'allow_countries': ['CN']}
    assert not guard.source_reason(settings, '203.0.113.10')
    assert not guard.source_reason(settings, '198.51.100.42')
    assert guard.source_reason(settings, '203.0.113.11') == 'deny_ip'
    assert guard.source_reason(settings, '10.0.0.5') == 'country_not_allowed'
    assert guard.source_reason({**settings, 'deny_countries': ['cn']}, '198.51.100.42') == 'deny_country'
    with pytest.raises(ValueError):
        validate_settings({'allow_ips': ['198.51.100.100/99']})
    with pytest.raises(ValueError):
        validate_settings({'retention_days': True})


def test_stream_metadata_deny_observe_rate_off_and_socket_handshake(tmp_path):
    guard = Guard(tmp_path)
    app = FastAPI()
    app.state.http_guard = guard
    app.add_middleware(HttpGuardMiddleware)

    @app.get('/files/{ticket}')
    def download(ticket: str):
        return StreamingResponse(iter([b'abc', b'def']))

    @app.websocket('/socket')
    async def websocket_route(websocket: WebSocket):
        raise AssertionError('a denied handshake should stop before routing')

    source = '198.51.100.42'
    with TestClient(app, client=(source, 12345)) as client:
        guard.policy = Policy.compile({'mode': 'observe', 'deny_ips': [source]})
        assert client.get('/files/private-ticket?token=private-query').content == b'abcdef'
        event = guard._events.get_nowait()
        assert event['decision'] == 'observed' and event['reason'] == 'deny_ip'
        assert event['route'] == '/files/{ticket}' and event['bytes_out'] == 6
        assert 'private' not in str(event) and event['status'] == 200 and event['duration_ms'] >= 0
        guard.policy = Policy.compile({'mode': 'enforce', 'deny_ips': [source]})
        assert client.get('/files/private-ticket').status_code == 403
        assert guard._events.get_nowait()['decision'] == 'blocked'
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect('/socket'):
                pass
        assert error.value.code == 1008 and guard._events.empty()
        guard.policy = Policy.compile({'mode': 'enforce', 'rate_per_minute': 1})
        assert client.get('/.env').status_code == 403
        assert guard._events.get_nowait()['reason'] == 'sensitive_path'
        assert client.get('/files/ok').status_code == 200
        assert client.get('/files/ok').status_code == 429
        assert guard._events.get_nowait()['reason'] == ''
        assert guard._events.get_nowait()['reason'] == 'rate_limit'
        guard.policy = Policy.compile({'mode': 'off', 'deny_ips': [source]})
        assert client.get('/files/private-ticket').status_code == 200
        assert guard._events.empty()


def test_local_readiness_and_bounded_writer(tmp_path, monkeypatch):
    guard = Guard(tmp_path)
    guard._events = queue.Queue(maxsize=1)
    policy = Policy.compile({'mode': 'enforce', 'allow_countries': ['CN']})
    local = {'client': ('127.0.0.1', 321), 'type': 'http', 'method': 'GET', 'path': '/api/v1/health'}
    assert guard.evaluate(local, policy)[2] == ''
    assert guard.evaluate({**local, 'path': '/api/v1/projects'}, policy)[2] == 'country_not_allowed'
    forwarded = {**local, 'headers': [(b'x-forwarded-for', b'127.0.0.1')]}
    assert guard.evaluate(forwarded, policy)[2] == 'country_not_allowed'

    def fail_write(events):
        raise OSError('simulated storage failure')

    monkeypatch.setattr(guard.store, 'append', fail_write)
    guard.offer({'ts': 0})
    guard.offer({'ts': 1})
    assert guard.status()['dropped'] == 1
    guard.start()
    guard.close()
    assert guard.status()['dropped'] == 2 and guard.status()['writer_errors'] == 1


def test_content_action_follows_global_and_category_modes(tmp_path, monkeypatch):
    # Exercise the decision path independently of the platform's native library build.
    async def matched(scope, receive, policy):
        return 'sqli', receive
    monkeypatch.setattr('server.http_guard.inspect_request', matched)
    guard = Guard(tmp_path)
    app = FastAPI()
    app.state.http_guard = guard
    app.add_middleware(HttpGuardMiddleware)

    @app.get('/sample')
    def sample():
        return {'ok': True}

    with TestClient(app) as client:
        for global_mode, category_mode, code, decision in (
            ('observe', 'enforce', 200, 'observed'),
            ('enforce', 'observe', 200, 'observed'),
            ('enforce', 'enforce', 403, 'blocked'),
        ):
            guard.policy = Policy.compile({'mode': global_mode, 'sqli_mode': category_mode})
            assert client.get('/sample').status_code == code
            event = guard._events.get_nowait()
            assert (event['decision'], event['reason']) == (decision, 'sqli')


def test_shared_policy_refresh_and_persistent_log_drain(tmp_path):
    guard = Guard(tmp_path)
    guard.start()
    external = GuardStore(tmp_path)
    try:
        previous = external.settings()
        external.save_settings(validate_settings({**previous, 'mode': 'enforce'}), previous['revision'])
        deadline = time.monotonic() + 6
        while guard.policy.mode != 'enforce' and time.monotonic() < deadline:
            time.sleep(.05)
        assert guard.policy.mode == 'enforce'
        guard.offer({'ts': time.time(), 'ip': '198.51.100.12', 'country': '', 'method': 'GET',
                     'route': '/api/v1/health', 'status': 200, 'duration_ms': 2.3, 'bytes_out': 51,
                     'decision': 'pass', 'reason': ''})
    finally:
        guard.close()
    events = external.events(1, None, None, None, 10)['items']
    assert [row['ip'] for row in events] == ['198.51.100.12']
