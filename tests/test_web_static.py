import asyncio
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.datastructures import Headers

from server.http_guard import Guard, HttpGuardMiddleware, Policy
from server.http_guard_adaptive import RouteIndex
from server.request_log import RequestLogMiddleware
from server.web_static import WebStaticFiles, PublicAssetMiddleware


@pytest.fixture(autouse=True)
def database_environment():
    pass  # Isolated static HTTP tests have no database dependency.


SCRIPT = Path(__file__).resolve().parents[1] / 'web' / 'tools' / 'precompress-assets.mjs'
JS = '/assets/app-aBCdEf12.js'
HTML = b'<html>' + b'public static shell ' * 70 + b'</html>'
CODE = b'console.log("hello");\n' * 5000


@pytest.fixture
def distribution(tmp_path):
    (tmp_path / 'assets').mkdir()
    (tmp_path / '.vite').mkdir()
    (tmp_path / 'api').mkdir()
    (tmp_path / 'index.html').write_bytes(HTML)
    (tmp_path / 'worker.js').write_text('self.skipWaiting()')
    (tmp_path / JS.lstrip('/')).write_bytes(CODE)
    (tmp_path / 'assets' / 'site-settings.js').write_text('unversioned file')
    (tmp_path / 'api' / 'internal.txt').write_text('private data')
    (tmp_path / '.vite' / 'manifest.json').write_text(json.dumps({'main': {'file': JS.lstrip('/')}}))
    subprocess.run(['node', str(SCRIPT), str(tmp_path)], check=True, capture_output=True)
    return WebStaticFiles(tmp_path)


def request(app, path, method='GET', **headers):
    messages = []

    async def receive():
        raise AssertionError('static response read the request')

    async def send(message):
        messages.append(message)

    scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.4'}, 'http_version': '1.1',
             'method': method, 'path': path, 'root_path': '', 'raw_path': path.encode(),
             'query_string': b'', 'scheme': 'http', 'client': ('192.0.2.3', 1234), 'server': ('test', 80),
             'headers': [(key.replace('_', '-').encode(), value.encode()) for key, value in headers.items()]}
    asyncio.run(app(scope, receive, send))
    return (messages[0]['status'], Headers(raw=messages[0]['headers']),
            b''.join(part.get('body', b'') for part in messages[1:]))


def test_memory_shell_and_negotiation(distribution):
    # Every full shell request, including HEAD and validators, works without reopening the entry file.
    (Path(distribution.directory) / 'index.html').unlink()
    for path in ('/', '/index.html'):
        status, original, body = request(distribution, path)
        assert status == 200 and body == HTML and original['cache-control'] == 'no-cache'
        assert original['etag'] == '"' + hashlib.sha256(HTML).hexdigest() + '"'
        assert original['vary'] == 'Accept-Encoding'
        status, encoded, body = request(distribution, path, accept_encoding='gzip;q=0.7, br;q=0.3')
        assert status == 200 and encoded['content-encoding'] == 'gzip' and gzip.decompress(body) == HTML
        assert original['etag'] != encoded['etag'] and encoded['content-type'] == original['content-type']
        status, cached, body = request(distribution, path, accept_encoding='gzip', if_none_match='W/' + encoded['etag'])
        assert status == 304 and body == b'' and cached['etag'] == encoded['etag'] and cached['vary'] == 'Accept-Encoding'
        assert request(distribution, path, if_none_match='"old"', if_modified_since=original['last-modified'])[0] == 200
        assert request(distribution, path, if_modified_since=original['last-modified'])[0] == 304
        assert request(distribution, path, if_none_match='"other", W/' + original['etag'])[0] == 304
        assert request(distribution, path, accept_encoding='gzip', if_none_match=original['etag'])[0] == 200
        status, head, body = request(distribution, path, 'HEAD', accept_encoding='br, gzip')
        assert status == 200 and head['content-encoding'] == 'br' and head['content-type'] == original['content-type']
        assert body == b'' and 0 < int(head['content-length']) < len(HTML)
        assert 'content-encoding' not in request(distribution, path, accept_encoding='identity;q=1, gzip;q=0.5')[1]
        assert request(distribution, path, accept_encoding='*;q=0')[0] == 406
        assert request(distribution, path, accept_encoding='br;q=0, *;q=1')[1]['content-encoding'] == 'gzip'
    assert request(distribution, '/worker.js')[1]['cache-control'] == 'no-cache'


def test_streamed_ranges_cache_and_variant_validators(distribution):
    status, original, body = request(distribution, JS)
    assert status == 200 and body == CODE and 'immutable' in original['cache-control']
    assert distribution.files[JS]['identity'].body is None
    assert request(distribution, '/assets/site-settings.js')[1]['cache-control'] == 'no-cache'
    _, zipped, full = request(distribution, JS, accept_encoding='gzip')
    assert gzip.decompress(full) == CODE and 'javascript' in zipped['content-type']
    assert request(distribution, JS, 'HEAD', accept_encoding='gzip') == (200, zipped, b'')
    status, partial, body = request(distribution, JS, range='bytes=4-11', accept_encoding='gzip')
    assert status == 206 and body == CODE[4:12] and partial['content-range'] == f'bytes 4-11/{len(CODE)}'
    assert partial['etag'] == original['etag'] and 'content-encoding' not in partial
    status, partial, body = request(distribution, JS, range='bytes=0-3', accept_encoding='gzip', if_range=zipped['etag'])
    assert status == 206 and body == full[:4] and partial['etag'] == zipped['etag']
    assert request(distribution, JS, range='bytes=0-3', if_range='"old"')[2] == CODE
    assert request(distribution, JS, range='bytes=1000000-')[0] == 416
    assert request(distribution, JS, 'HEAD', range='bytes=3-7') == (200, original, b'')
    assert request(distribution, JS, range='bytes=0-3', if_none_match='*')[0] == 304


def test_old_build_and_stale_sidecars_fall_back_to_original(tmp_path):
    shell = tmp_path / 'index.html'
    shell.write_bytes(HTML)
    legacy = WebStaticFiles(tmp_path)
    status, headers, body = request(legacy, '/', accept_encoding='br, gzip')
    assert status == 200 and body == HTML and 'content-encoding' not in headers
    subprocess.run(['node', str(SCRIPT), str(tmp_path)], check=True, capture_output=True)
    shell.write_bytes(HTML + b'new release')
    replaced = WebStaticFiles(tmp_path)
    status, updated, body = request(replaced, '/', accept_encoding='br', if_none_match=headers['etag'])
    assert status == 200 and body == shell.read_bytes() and 'content-encoding' not in updated
    assert updated['etag'] != headers['etag']


def test_public_routing_preserves_firewall_audit_and_private_api(distribution, tmp_path):
    app = FastAPI()
    app.add_middleware(PublicAssetMiddleware, files=distribution)
    app.add_middleware(RequestLogMiddleware)
    app.add_middleware(HttpGuardMiddleware)
    guard = Guard(tmp_path)
    guard.policy = Policy.compile({'mode': 'enforce', 'deny_ips': ['192.0.2.3']})
    app.state.http_guard = guard
    seen, logged = [], []
    guard.offer = seen.append

    class TestJournal:
        def offer(self, row):
            logged.append(row)
            return True

    app.state.request_journal = TestJournal()

    @app.get('/api/v1/private')
    def private():
        return {'real': 'api'}

    app.mount('/', distribution, name='web')
    forbidden, headers, _ = request(app, '/', if_none_match='*')
    assert forbidden == 403 and headers['cache-control'] == 'no-store' and seen[-1]['decision'] == 'blocked'
    guard.policy = Policy.compile({'mode': 'observe'})
    assert request(app, JS, 'HEAD')[0] == 200
    assert seen[-1]['bytes_out'] == 0 and logged[-1]['status'] == 200
    assert request(app, '/', accept_encoding='gzip')[0] == 200
    assert seen[-1]['bytes_out'] == len(distribution.files['/']['gzip'].body) and len(logged) == 2
    via = TestClient(app)
    assert via.get('/api/v1/private').json() == {'real': 'api'}
    for path in ('/api/internal.txt', '/.vite/manifest.json', '/.http-enc/' + hashlib.sha256(HTML).hexdigest() + '.gz',
                 '/unknown.html'):
        assert via.get(path).status_code == 404
    assert via.post('/').status_code == 405
    index = RouteIndex(app)
    assert index.resource('GET', '/') and index.resource('GET', JS)
    assert not index.resource('GET', '/.vite/manifest.json')
