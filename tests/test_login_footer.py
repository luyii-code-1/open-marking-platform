from html.parser import HTMLParser

from fastapi.testclient import TestClient

from server import db
from server.login_footer import clean_html
from server.main import app


def test_login_footer_permissions_persistence_preview_and_clear(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        public = client.get('/api/v1/public/login-footer')
        assert public.status_code == 200 and public.json() == {'html': ''}
        assert public.headers['cache-control'] == 'no-store'
        assert client.get('/api/v1/system/login-footer').status_code == 401
        assert client.put('/api/v1/system/login-footer', json={'html': 'changed'}).status_code == 401
        account = {'username': 'admin', 'name': '管理员', 'password': 'administrator-password'}
        assert client.post('/api/v1/auth/bootstrap', json=account).status_code == 200
        admin = {'Authorization': 'Bearer ' + client.post('/api/v1/auth/login', json=account).json()['token']}
        for role in ('manager', 'teacher'):
            person = {'username': role, 'name': role, 'password': 'account-password', 'role': role}
            assert client.post('/api/v1/users', json=person, headers=admin).status_code == 200
            auth = {'Authorization': 'Bearer ' + client.post('/api/v1/auth/login', json=person).json()['token']}
            assert client.get('/api/v1/system/login-footer', headers=auth).status_code == 403
            assert client.put('/api/v1/system/login-footer', json={'html': 'changed'}, headers=auth).status_code == 403
            assert client.post('/api/v1/system/login-footer/preview', json={'html': 'changed'}, headers=auth).status_code == 403
        html = '<p style="text-align:center"><a href="https://beian.miit.gov.cn/">测试备案号</a><br>联系方式</p><script>private-source</script>'
        preview = client.post('/api/v1/system/login-footer/preview', json={'html': html}, headers=admin)
        assert preview.status_code == 200 and preview.json()['html'] == clean_html(html)
        assert client.get('/api/v1/public/login-footer').json() == {'html': ''}
        saved = client.put('/api/v1/system/login-footer', json={'html': html}, headers=admin)
        assert saved.status_code == 200 and saved.json()['html'] == html
        assert client.get('/api/v1/system/login-footer', headers=admin).json() == saved.json()
        assert client.get('/api/v1/public/login-footer').json() == preview.json()
        assert 'private-source' not in client.get('/api/v1/public/login-footer').text
        assert client.put('/api/v1/system/login-footer', json={'html': 'x' * 20001}, headers=admin).status_code == 422
        assert client.get('/api/v1/public/login-footer').json() == preview.json()
    # Reload through the application's normal startup and persistence path.
    with TestClient(app) as client:
        assert client.get('/api/v1/public/login-footer').json() == preview.json()
        assert client.put('/api/v1/system/login-footer', json={'html': ''}, headers=admin).status_code == 200
        assert client.get('/api/v1/public/login-footer').json() == {'html': ''}
        with db.connect() as connection:
            settings = db.find(connection, 'site-settings', key='login-footer')
            assert len(settings) == 1
            assert connection.execute("SELECT COUNT(*) FROM audit WHERE object_id=?", (settings[0]['id'],)).fetchone()[0] == 2


def test_footer_sanitizer_preserves_links_images_and_blocks_active_html():
    html = '''<div style="color:#555;display:flex;gap:8px;position:fixed;background:url(javascript:x)" onclick="attack()">
        <a href="https://example.test/filing?a=1&amp;b=2" target="_self">备案 &amp; 说明</a>
        <img src="/assets/badge.png" width="20" height="20" alt="徽标" onerror="attack()">
        <a href="java&#x73;cript:attack()">链接</a><img src="data:image/svg+xml,attack">
        <svg><a href="https://hidden.test">hidden-svg</a></svg>
        <iframe src="https://hidden.test">hidden-frame</iframe><style>hidden-style</style><script>hidden-script</script>
        <span style="font-size:12px;line-height:1.8">底部文字</span></div>'''
    cleaned = clean_html(html)
    assert '备案 &amp; 说明' in cleaned and '底部文字' in cleaned
    assert 'color:#555;display:flex;gap:8px' in cleaned
    assert 'font-size:12px;line-height:1.8' in cleaned
    for removed in ('javascript:', 'onclick', 'onerror', 'position:', 'background:', 'data:image', 'hidden-'):
        assert removed not in cleaned
    class Tags(HTMLParser):
        def __init__(self):
            super().__init__()
            self.tags = []
        def handle_starttag(self, name, attrs):
            self.tags.append((name, dict(attrs)))
    parsed = Tags()
    parsed.feed(cleaned)
    links = [attrs for tag, attrs in parsed.tags if tag == 'a']
    assert links[0]['href'] == 'https://example.test/filing?a=1&b=2'
    assert links[0]['target'] == '_blank' and links[0]['rel'] == 'noopener noreferrer'
    assert 'href' not in links[1]
    assert [attrs for tag, attrs in parsed.tags if tag == 'img'][0]['src'] == '/assets/badge.png'
    assert clean_html(cleaned) == cleaned
