from contextlib import closing
from io import BytesIO
import sqlite3
import time

from fastapi.testclient import TestClient
import pytest

from server import db, http_geoip
from server.http_guard_store import GuardStore, RevisionConflict
from server.main import app


def test_store_rollups_match_details_and_retention(tmp_path, monkeypatch):
    store = GuardStore(tmp_path)
    policy = store.settings()
    now = 1800004321
    monkeypatch.setattr(time, 'time', lambda: now)
    # Exercise the leading partial hour and precomputed full hours.
    rows = [
        (-86500, '192.0.2.1', 'CN', 'pass', 200),
        (-86280, '192.0.2.1', 'CN', 'observed', 404),
        (-3600, '192.0.2.1', 'CN', 'pass', 200),
        (-10, '192.0.2.2', 'SG', 'blocked', 403),
        (-3, '192.0.2.1', 'CN', 'pass', 503),
    ]
    store.append([{'ts': now + offset, 'ip': ip, 'country': cc, 'decision': decision,
                   'status': status, 'method': 'GET', 'route': '/test', 'reason': '',
                   'duration_ms': 5, 'bytes_out': 30} for offset, ip, cc, decision, status in rows])
    result = store.overview(24)
    assert (result['requests'], result['unique_ips'], result['observed'], result['blocked'],
            result['server_errors'], result['bytes_out'], result['avg_ms']) == (4, 2, 1, 1, 1, 120, 5)
    assert result['top_ips'][0]['requests'] == 3
    assert sum(r['requests'] for r in result['series']) == 4
    assert result['countries'] == [{'country': 'CN', 'requests': 3}, {'country': 'SG', 'requests': 1}]
    page = store.events(0, '192.0.2.1', '', None, 2)
    assert len(page['items']) == 2 and page['next_before']
    older = store.events(0, '192.0.2.1', '', page['next_before'], 2)
    assert len(older['items']) == 2 and not older['next_before']
    # A chart bucket may end well before the default rolling log window.
    bucket = (now - 86280) // 60 * 60
    historical = store.events(1, '', '', None, 10, start=bucket, end=bucket + 60)
    assert [row['ts'] for row in historical['items']] == [now - 86280]
    assert not store.events(1, '', '', None, 10, start=bucket - 60, end=bucket)['items']
    revision = policy.pop('revision')
    store.save_settings({**policy, 'retention_days': 1}, revision)
    with pytest.raises(RevisionConflict):
        store.save_settings(policy, revision)
    store.purge(1)
    assert store.overview(0)['requests'] == 4
    assert len(store.events(0, '', '', None, 10)['items']) == 4
    with closing(sqlite3.connect(store.path)) as conn:
        assert conn.execute('SELECT count(*) FROM event').fetchone()[0] == 4


def test_geoip_rejects_corrupt_update_without_replacing_installed_file(tmp_path, monkeypatch):
    geo = http_geoip.GeoIP(tmp_path)
    geo.path.parent.mkdir()
    original = b'previous file'
    geo.path.write_bytes(original)

    def fake_open(request, timeout):
        data = b'0' * 64 if request.full_url.endswith('.sha256sum') else b'corrupted download'
        return BytesIO(data)

    monkeypatch.setattr(http_geoip, 'urlopen', fake_open)
    with pytest.raises(ValueError):
        geo.update()
    assert geo.path.read_bytes() == original
    assert not list(geo.path.parent.glob('*.download'))


def test_admin_policy_access_conflict_and_own_ip(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    account = {'username': 'admin', 'password': 'administrator-password', 'name': '管理员'}
    root = '/api/v1/system/http-guard'
    with TestClient(app, client=('192.0.2.9', 5443)) as client:
        assert client.get(root + '/overview').status_code == 401
        client.post('/api/v1/auth/bootstrap', json=account).raise_for_status()
        token = client.post('/api/v1/auth/login', json=account).json()['token']
        headers = {'Authorization': 'Bearer ' + token}
        teacher = {**account, 'username': 'teacher', 'role': 'teacher'}
        client.post('/api/v1/users', json=teacher, headers=headers).raise_for_status()
        other = client.post('/api/v1/auth/login', json=teacher).json()['token']
        assert client.post(root + '/geoip/update', headers={'Authorization': 'Bearer ' + other}).status_code == 403
        settings = client.get(root + '/settings', headers=headers).json()
        assert settings['mode'] == 'observe' and settings['retention_days'] == 60
        assert client.get(root + '/status', headers=headers).json()['client_ip'] == '192.0.2.9'
        def save(changes):
            return client.put(root + '/settings', json={**settings, **changes}, headers=headers)
        assert save({'mode': 'enforce', 'deny_ips': ['192.0.2.0/24']}).status_code == 422
        assert save({'mode': 'enforce', 'allow_countries': ['CN']}).status_code == 422
        assert save({'deny_ips': ['invalid-address']}).status_code == 422
        assert save({'mode': 'off'}).status_code == 200
        assert save({'mode': 'enforce'}).status_code == 409
        assert client.get(root + '/overview?hours=0', headers=headers).status_code == 200
        assert client.get(root + '/events?decision=blocked&hours=0', headers=headers).status_code == 200
        assert client.get(root + '/events?start=60', headers=headers).status_code == 422
        assert client.get(root + '/events?start=120&end=60', headers=headers).status_code == 422
