"""Request-scoped identity classification and bounded per-worker token buckets."""
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from hashlib import sha256
from math import ceil
from pathlib import Path
import re
import threading
import time

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

from . import dependencies
from .web_static import WebStaticFiles


_BEARER = re.compile(rb'Bearer [A-Za-z0-9_-]{54}')
_TRANSACTION_ROUTES = {('POST', '/api/v1/tasks/claim'), ('POST', '/api/v1/tasks/{identifier}/score')}
_FONT_PATHS = {f'/api/v1/paper-fonts/{family}/{weight}' for family in ('sans', 'serif') for weight in (400, 700)}


def _auth_kind(dependant):
    if dependant is None:
        return ''
    if dependant.call in (dependencies.scan_user, dependencies.scan_admin):
        return 'scanner'
    if dependant.call in (dependencies.user, dependencies.admin, dependencies.system_admin):
        return 'user'
    for item in dependant.dependencies:
        if kind := _auth_kind(item):
            return kind
    return ''


class RouteIndex:
    def __init__(self, app):
        try:
            from fastapi.routing import iter_route_contexts
        except ImportError:  # Older supported FastAPI releases flatten includes into app.routes.
            routes = app.routes
        else:
            routes = iter_route_contexts(app.routes)
        self.paths = defaultdict(list)
        self.resources = set()
        for route in routes:
            original = getattr(route, 'original_route', route)
            if isinstance(original, Mount) and isinstance(original.app, WebStaticFiles):
                self.resources.update(original.path + path for path in original.app.files)
                continue
            if isinstance(original, Mount) and isinstance(original.app, StaticFiles) and original.app.directory:
                folder = Path(original.app.directory)
                for item in folder.rglob('*'):
                    if item.is_file():
                        relative = item.relative_to(folder).as_posix()
                        self.resources.add(f'{original.path}/{relative}')
                        if original.app.html and relative == 'index.html':
                            self.resources.add(original.path + '/')
                continue
            if not (path := getattr(route, 'path', '')).startswith('/api/v1/'):
                continue
            prefix = path.split('/', 4)[3]
            for method in getattr(route, 'methods', None) or ():
                kind = ('user' if (method, path) in _TRANSACTION_ROUTES
                        else _auth_kind(getattr(route, 'dependant', None)))
                self.paths[method, prefix].append((route.path_regex, kind, path))
                if path == '/api/v1/paper-fonts/{family}/{weight}':
                    self.resources.update(_FONT_PATHS)

    def resource(self, method, path):
        return method in ('GET', 'HEAD') and path in self.resources

    def match(self, method, path):
        parts = path.split('/', 4)
        if len(parts) < 4 or parts[1:3] != ['api', 'v1']:
            return '', ''
        for pattern, kind, template in self.paths.get((method, parts[3]), ()):
            if pattern.fullmatch(path):
                return kind, template
        return '', ''


def credential(scope, routes):
    headers = [value for name, value in scope.get('headers', ()) if name == b'authorization']
    if len(headers) != 1 or not _BEARER.fullmatch(headers[0]):
        return None
    kind, _ = routes.match(scope['method'], scope['path'])
    if not kind:
        return None
    return headers[0].decode('ascii'), kind


async def verify(scope, credentials):
    token, kind = credentials
    if kind == 'scanner':
        from .scanner_auth import scan_user as authenticate
    else:
        authenticate = dependencies.user
    state = scope.setdefault('state', {})
    try:
        person = await run_in_threadpool(authenticate, token)
    except HTTPException as error:
        state['_http_guard_auth'] = (token, kind, None, error.status_code, error.detail, error.headers)
        return None
    except Exception:
        # An unavailable identity store cannot qualify the request for relaxed
        # inspection. Let the application's normal authentication handle it.
        return None
    state['_http_guard_auth'] = (token, kind, person, 0, '', None)
    state.update(http_guard_verified=True, http_guard_role=person['role'], actor=person['id'],
                 actor_label=(person.get('username') or person.get('name') or '')[:160],
                 actor_kind='device' if person['role'] == 'scanner' else 'user')
    return person


@dataclass(slots=True)
class Bucket:
    tokens: float
    updated: float
    misses: int = 0
    first_miss: float = 0
    penalty_until: float = 0


class AdaptiveLimiter:
    def __init__(self, clock=time.monotonic, capacity=16384):
        self.clock, self.capacity = clock, capacity
        self._lock = threading.Lock()
        self._groups = {kind: OrderedDict() for kind in ('anonymous', 'authenticated', 'resource', 'credential')}
        self._overflow = {}
        self._hints = OrderedDict()

    def hint(self, digest):
        with self._lock:
            found = self._hints.get(digest)
            if found and found[1] > self.clock():
                return found[0]
            self._hints.pop(digest, None)
            return None

    def remember(self, digest, key):
        with self._lock:
            if not key:
                self._hints.pop(digest, None)
                return
            self._hints[digest] = (key, self.clock() + 600)
            self._hints.move_to_end(digest)
            if len(self._hints) > self.capacity:
                self._hints.popitem(last=False)

    def refund(self, kind, key, rate):
        with self._lock:
            bucket = self._groups[kind].get(key) or self._overflow.get(kind)
            if bucket:
                bucket.tokens = min(ceil(rate / 6), bucket.tokens + 1)

    async def credentials(self, scope, credentials, ip, policy):
        """Hints can reject over-quota credentials, never authenticate them."""
        token, category = credentials
        digest = sha256(token.encode('ascii')).digest()
        known = self.hint(digest)
        if known and known[0] == 'device' and category != 'scanner':
            known = None
        if known:
            group, key, rate = 'authenticated', known, policy.authenticated_rate_per_minute
        else:
            group, key = 'credential', ip
            rate = max(60, min(1000000, policy.anonymous_rate_per_minute * 2))
        wait = self.check(group, key, rate)
        if wait:
            return ('adaptive_authenticated' if known else 'adaptive_anonymous'), wait
        person = await verify(scope, credentials)
        if not person:
            if known:
                self.refund(group, key, rate)
                self.remember(digest, None)
            wait = self.check('anonymous', ip, policy.anonymous_rate_per_minute)
            return ('adaptive_anonymous', wait) if wait else ('', 0)
        identity = (scope['state']['actor_kind'], person['id'])
        if identity == known:
            self.remember(digest, identity)
            return '', 0
        self.refund(group, key, rate)
        self.remember(digest, identity)
        wait = self.check('authenticated', identity, policy.authenticated_rate_per_minute)
        return ('adaptive_authenticated', wait) if wait else ('', 0)

    def check(self, kind, key, rpm):
        now = self.clock()
        burst = ceil(rpm / 6)
        with self._lock:
            group = self._groups[kind]
            bucket = group.get(key)
            if bucket is not None:
                group.move_to_end(key)
            else:
                if len(group) >= self.capacity:
                    oldest = next(iter(group.values()))
                    if now - oldest.updated >= 120:
                        group.popitem(last=False)
                if len(group) < self.capacity:
                    bucket = group[key] = Bucket(burst, now)
                else:
                    # Churn of unique IPs cannot evict live accounts/buckets
                    # or continuously grant new initial bursts.
                    bucket = self._overflow.get(kind)
                    if bucket is None:
                        bucket = self._overflow[kind] = Bucket(burst, now)
            elapsed = max(0, now - bucket.updated)
            penalized = min(elapsed, max(0, bucket.penalty_until - bucket.updated))
            rate = rpm / 60
            bucket.tokens = min(burst, bucket.tokens + rate * (elapsed - penalized / 2))
            bucket.updated = now
            if bucket.tokens >= 1:
                bucket.tokens -= 1
                bucket.misses = 0
                return 0
            if kind == 'anonymous':
                if not bucket.misses or now - bucket.first_miss > 10:
                    bucket.misses, bucket.first_miss = 0, now
                bucket.misses += 1
                if bucket.misses >= 3:
                    bucket.penalty_until = now + 60
            missing = 1 - bucket.tokens
            slow_seconds = max(0, bucket.penalty_until - now)
            wait = (missing * 2 / rate if missing <= slow_seconds * rate / 2
                    else slow_seconds + (missing - slow_seconds * rate / 2) / rate)
            return max(1, ceil(wait))
