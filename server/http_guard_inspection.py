"""Bounded SQLi/XSS heuristics over HTTP parameters, backed by libinjection."""
from collections import deque
import ctypes
from functools import lru_cache
from itertools import islice
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import unquote_plus


VERSION = '4.0.2'
BODY_LIMIT = 32 * 1024
QUERY_LIMIT = 8 * 1024
VALUE_LIMIT = 4096
FIELD_LIMIT = 64
MESSAGE_LIMIT = 64
_MODES = {'observe': 1, 'enforce': 2}
_SENSITIVE_KEYS = {
    'authorization', 'cookie', 'signature', 'challenge', 'nonce', 'digest',
    'public_key', 'private_key', 'api_key', 'access_key', 'credential', 'credentials',
    'credential_id', 'assertion', 'clientdatajson', 'attestationobject',
}
_TEMPLATE_ROUTE = re.compile(r'/api/v1/(?:templates(?:/[^/]+)?|groups/[^/]+/drafts/[^/]+)')
_RICH_FIELDS = {
    ('questions', '[]', 'content_html'), ('questions', '[]', 'parts', '[]', 'content_html'),
    ('print_notes', '[]', 'html'), ('question', 'content_html'),
}


@lru_cache(maxsize=1)
def _engine():
    configured = os.getenv('OMP_LIBINJECTION_PATH')
    if configured:
        paths = [Path(configured)]
    else:
        name = {'win32': 'omp_injection.dll', 'darwin': 'libomp_injection.dylib'}.get(sys.platform, 'libomp_injection.so')
        paths = [Path('/usr/local/lib') / name, Path(__file__).resolve().parents[1] / 'dist' / 'http-guard' / name]
    for path in paths:
        if not path.is_absolute():
            continue
        try:
            library = ctypes.CDLL(str(path))
            library.libinjection_version.argtypes = []
            library.libinjection_version.restype = ctypes.c_char_p
            if library.libinjection_version() != VERSION.encode('ascii'):
                continue
            library.libinjection_sqli.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_char)]
            library.libinjection_xss.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
            library.libinjection_sqli.restype = library.libinjection_xss.restype = ctypes.c_int
            return library
        except (OSError, AttributeError):
            continue
    return None


def engine_status():
    ready = _engine() is not None
    return {'ready': ready, 'version': VERSION if ready else None}


def _private_key(name):
    key = name.lower()
    return (key in _SENSITIVE_KEYS or 'password' in key or 'token' in key or 'secret' in key)


def _parameters(raw):
    for pair in islice(raw.split(b'&', FIELD_LIMIT), FIELD_LIMIT):
        key, _, value = pair.partition(b'=')
        field = unquote_plus(key.decode('utf-8', 'replace'))
        if value and not _private_key(field):
            yield unquote_plus(value.decode('utf-8', 'replace'))


def _json_values(document, path):
    footer = path in ('/api/v1/system/login-footer', '/api/v1/system/login-footer/preview')
    template = bool(_TEMPLATE_ROUTE.fullmatch(path))
    visited = 0

    def walk(value, keys):
        nonlocal visited
        visited += 1
        if visited > 512 or len(keys) > 12:
            return
        if isinstance(value, str):
            template_keys = keys[1:] if keys[:1] == ('value',) else keys
            if (footer and keys == ('html',)) or (template and template_keys in _RICH_FIELDS):
                return
            yield value
        elif isinstance(value, dict):
            for key, child in value.items():
                if visited >= 512:
                    break
                if not _private_key(key):
                    yield from walk(child, (*keys, key))
        elif isinstance(value, list):
            for child in value:
                if visited >= 512:
                    break
                yield from walk(child, (*keys, '[]'))
    return walk(document, ())


class _Inspection:
    def __init__(self, library, sqli, xss):
        self.library = library
        self.checks = sorted(((sqli, 'sqli'), (xss, 'xss')), reverse=True)
        self.priority = 0
        self.reason = ''
        self.fingerprint = ctypes.create_string_buffer(8) if sqli else None

    def scan(self, values):
        # Keep looking after an observe-only match if another enabled rule can block.
        for value in islice(values, FIELD_LIMIT):
            if not value:
                continue
            encoded = value[:VALUE_LIMIT].encode('utf-8', 'replace')[:VALUE_LIMIT]
            for priority, kind in self.checks:
                if priority <= self.priority:
                    break
                if kind == 'sqli':
                    result = self.library.libinjection_sqli(encoded, len(encoded), self.fingerprint)
                else:
                    result = self.library.libinjection_xss(encoded, len(encoded))
                # The upstream third return value represents an internal parser error.
                if result == 1:
                    self.reason, self.priority = kind, priority
                    if self.priority == self.checks[0][0]:
                        return True
                    break
        return False


async def _buffer(receive):
    """Replay every original ASGI message, including over-limit chunks/disconnects."""
    frames = deque()
    size = 0
    body = None
    for _ in range(MESSAGE_LIMIT):
        frame = await receive()
        frames.append(frame)
        if frame['type'] != 'http.request':
            break
        size += len(frame.get('body', b''))
        if size > BODY_LIMIT:
            break
        if not frame.get('more_body', False):
            body = b''.join(item.get('body', b'') for item in frames)
            break

    async def replay():
        if frames:
            return frames.popleft()
        return await receive()

    return body, replay


async def inspect_request(scope, receive, policy):
    if scope['type'] != 'http':
        return '', receive
    query = scope.get('query_string', b'')
    can_have_fields = (scope['method'] in ('POST', 'PUT', 'PATCH', 'DELETE')
                       and scope['path'] != '/api/v1/telemetry/page-view')
    if not query and not can_have_fields:
        return '', receive
    sqli = _MODES.get(policy.sqli_mode, 0)
    xss = _MODES.get(policy.xss_mode, 0)
    if not (sqli or xss) or (library := _engine()) is None:
        return '', receive
    inspect = _Inspection(library, sqli, xss)
    if query and inspect.scan(_parameters(query[:QUERY_LIMIT])):
        return inspect.reason, receive
    if not can_have_fields:
        return inspect.reason, receive
    headers = dict(scope.get('headers', ()))
    content = headers.get(b'content-type', b'').partition(b';')[0].strip().lower()
    is_json = content == b'application/json' or (content.startswith(b'application/') and content.endswith(b'+json'))
    if not is_json and content != b'application/x-www-form-urlencoded':
        return inspect.reason, receive
    if headers.get(b'content-encoding', b'identity').strip().lower() != b'identity':
        return inspect.reason, receive
    length = headers.get(b'content-length')
    if length is not None and (not length.isdigit() or len(length) > 20 or int(length) > BODY_LIMIT):
        return inspect.reason, receive
    body, replay = await _buffer(receive)
    if body and is_json:
        try:
            document = json.loads(body)
        except (ValueError, UnicodeDecodeError, RecursionError):
            pass
        else:
            inspect.scan(_json_values(document, scope['path']))
    elif body:
        inspect.scan(_parameters(body))
    return inspect.reason, replay
