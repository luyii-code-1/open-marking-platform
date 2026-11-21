import asyncio
from collections import deque
import json
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest

from server import http_guard_inspection as inspection


@pytest.fixture(autouse=True)
def database_environment():
    # Native parameter inspection does not connect to the business database.
    pass


@pytest.fixture
def native():
    if not inspection.engine_status()['ready']:
        pytest.skip('Build the native detector using third_party/libinjection/README.md')


policy = SimpleNamespace(sqli_mode='enforce', xss_mode='observe')
# The upstream tokenizer flags this piece of ordinary prose. The HTML sample
# contains inert JSON data. Both exercise positive results without executable content.
SQL_PROSE = 'total (5); tax included'
HTML_DATA = '<script type="application/json">{}</script>'


def check(*, body=b'', path='/api/v1/example', query=b'', content=b'application/json',
          headers=(), rules=policy, frames=None):
    original = frames if frames is not None else [{'type': 'http.request', 'body': body, 'more_body': False}]
    pending = deque(original)
    scope = {'type': 'http', 'path': path, 'method': 'POST', 'query_string': query,
             'headers': [(b'content-type', content), *headers]}

    async def receive():
        return pending.popleft()

    async def run():
        reason, replay = await inspection.inspect_request(scope, receive, rules)
        already_read = len(original) - len(pending)
        assert [await replay() for _ in original] == original
        return reason, already_read

    return asyncio.run(run())


def test_native_modes_decode_and_preserve_json_form(native):
    assert inspection.engine_status() == {'ready': True, 'version': '4.0.2'}
    assert check(body=json.dumps({'name': '七班 • 第五题'}).encode()) == ('', 1)
    assert check(body=urlencode({'name': SQL_PROSE}).encode(), content=b'application/x-www-form-urlencoded') == ('sqli', 1)
    assert check(body=json.dumps({'name': HTML_DATA}).encode(), content=b'application/example+json') == ('xss', 1)
    # A weaker match in the URL cannot hide an enforcing match in a later body.
    assert check(query=urlencode({'q': HTML_DATA}).encode(), body=json.dumps({'nested': [SQL_PROSE]}).encode()) == ('sqli', 1)
    assert check(body=json.dumps({'password': SQL_PROSE, 'refresh_token': HTML_DATA}).encode()) == ('', 1)
    assert check(body=b'bad json') == ('', 1)
    off = SimpleNamespace(sqli_mode='off', xss_mode='off')
    assert check(query=urlencode({'q': SQL_PROSE}).encode(), rules=off) == ('', 0)


def test_native_scoped_rich_text_fields(native):
    draft = '/api/v1/groups/group/drafts/draft'
    document = {'value': {'questions': [{'content_html': '<strong>答题要求</strong> ' + HTML_DATA}],
                          'print_notes': [{'html': SQL_PROSE}]}}
    assert check(path=draft, body=json.dumps(document).encode()) == ('', 1)
    assert check(path='/api/v1/system/login-footer/preview', body=json.dumps({'html': HTML_DATA}).encode()) == ('', 1)
    assert check(path='/api/v1/other', body=json.dumps({'html': HTML_DATA}).encode()) == ('xss', 1)
    document['value']['name'] = SQL_PROSE
    assert check(path=draft, body=json.dumps(document).encode()) == ('sqli', 1)


def test_stream_replay_bounds_and_binary_bypass(monkeypatch):
    class Neutral:
        def libinjection_sqli(self, *args): return 0
        def libinjection_xss(self, *args): return 0

    monkeypatch.setattr(inspection, '_engine', lambda: Neutral())
    assert check(content=b'multipart/form-data; boundary=field') == ('', 0)
    assert check(content=b'application/octet-stream') == ('', 0)
    assert check(headers=[(b'content-length', str(inspection.BODY_LIMIT + 1).encode())]) == ('', 0)
    chunks = [{'type': 'http.request', 'body': b'abc', 'more_body': True},
              {'type': 'http.request', 'body': bytes(inspection.BODY_LIMIT), 'more_body': True},
              {'type': 'http.request', 'body': b'end', 'more_body': False}]
    assert check(frames=chunks) == ('', 2)
    disconnect = [chunks[0], {'type': 'http.disconnect'}]
    assert check(frames=disconnect) == ('', 2)
    tiny = [chunks[0]] * (inspection.MESSAGE_LIMIT + 1) + [chunks[-1]]
    assert check(frames=tiny) == ('', inspection.MESSAGE_LIMIT)


def test_missing_native_library_is_visible_and_keeps_stream_intact(tmp_path, monkeypatch):
    monkeypatch.setenv('OMP_LIBINJECTION_PATH', str(tmp_path / 'absent'))
    inspection._engine.cache_clear()
    try:
        assert inspection.engine_status() == {'ready': False, 'version': None}
        assert check() == ('', 0)
    finally:
        inspection._engine.cache_clear()
