import time

from fastapi.testclient import TestClient
from server import db
from server import http_guard_inspection as inspection
from server.http_guard import Policy
from server.main import app


def test_bulk_ip_policy_atomicity_expiry_and_history(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    account = {'username': 'operator', 'password': 'operator-password-for-test', 'name': '管理员'}
    api = '/api/v1/system/http-guard'
    with TestClient(app, client=('192.0.2.10', 4567)) as client:
        client.post('/api/v1/auth/bootstrap', json=account).raise_for_status()
        token = client.post('/api/v1/auth/login', json=account).json()['token']
        headers = {'Authorization': f'Bearer {token}'}
        def post(path, values):
            return client.post(api + path, headers=headers, json=values)
        settings = client.get(api + '/settings', headers=headers).json()
        guard = app.state.http_guard
        now = time.time()
        ips = ('198.51.100.101', '198.51.100.101', '2001:db8::1', '192.0.2.10')
        guard.store.append([{'ts': now, 'ip': ip, 'country': '', 'method': 'GET', 'route': '/selected',
                             'status': 200, 'duration_ms': 2, 'bytes_out': 5, 'decision': 'pass', 'reason': ''}
                            for ip in ips])
        rows = [r for r in guard.store.events(1, '', '', None, 200)['items'] if r['route'] == '/selected']
        body = {'revision': settings['revision'], 'event_ids': [r['id'] for r in rows], 'action': 'deny'}
        assert post('/event-policy', body).status_code == 422
        assert not guard.store.settings()['managed_ips']
        body['event_ids'] = [r['id'] for r in rows if r['ip'] != '192.0.2.10']
        added = post('/event-policy', body)
        added.raise_for_status()
        saved = added.json()
        assert len(saved['managed_ips']) == 2
        assert all(now + 86398 <= item['expires'] <= now + 86410 for item in saved['managed_ips'])
        assert post('/event-policy', body).status_code == 409
        assert post('/event-policy', {**body, 'revision': saved['revision'], 'action': 'allow'}).status_code == 409
        assert guard.source_reason(saved, ips[0]) == 'deny_ip'
        assert guard.source_reason(saved, '198.51.100.102') == ''
        expired = {**saved, 'managed_ips': [{**item, 'expires': int(now)-1} for item in saved['managed_ips']]}
        assert not Policy.compile(expired).source(None, '')[0]
        assert not guard.source_reason(expired, ips[0])
        settings = client.put(api + '/settings', headers=headers,
                              json={**saved, 'mode': 'enforce', 'managed_ips': []}).json()
        assert len(settings['managed_ips']) == 2
        result = post('/remove-policy', {'revision': settings['revision'], 'ip': ips[0]})
        assert result.is_success and len(result.json()['managed_ips']) == 1
        changes = client.get(api + '/policy-history', headers=headers).json()['items']
        assert len(changes) == 3 and changes[0]['actor'] == 'operator'
        assert set(changes[-1]['ips']) == {ips[0], ips[2]}


def test_verified_business_profile_on_protected_preview(tmp_path, monkeypatch):
    class Markers:
        def libinjection_sqli(self, value, *args): return int(value == b'content-marker')
        def libinjection_xss(self, *args): return 0

    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setattr(inspection, '_engine', Markers)
    api = '/api/v1'
    settings_path = api + '/system/http-guard/settings'
    preview = api + '/system/login-footer/preview'
    account = {'username': 'publisher', 'password': 'publisher-test-password', 'name': '管理员'}
    body = {'html': 'content-marker'}
    with TestClient(app, client=('192.0.2.33', 5124)) as client:
        client.post(api + '/auth/bootstrap', json=account).raise_for_status()
        token = client.post(api + '/auth/login', json=account).json()['token']
        headers = {'Authorization': 'Bearer ' + token}
        settings = client.get(settings_path, headers=headers).json()
        config = {**settings, 'mode': 'enforce', 'sqli_mode': 'enforce', 'business_content_profile': 'verified_business'}
        client.put(settings_path, json=config, headers=headers).raise_for_status()
        assert client.post(preview, json=body).status_code == 403
        assert client.post(preview, json=body, headers=headers).status_code == 200
        assert client.post(preview, params={'q': 'content-marker'}, json=body, headers=headers).status_code == 403
        client.post(api + '/auth/logout', headers=headers).raise_for_status()
        assert client.post(preview, json=body, headers=headers).status_code == 403
        store = app.state.http_guard.store
    # Lifespan shutdown flushes pending audit events.
    events = store.events(1, '', 'observed', None, 10, reason='sqli_business')['items']
    assert len(events) == 1 and events[0]['route'] == preview and events[0]['actor_label'] == 'publisher'
