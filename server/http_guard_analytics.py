"""Same-origin page-view collection and administrator traffic analytics."""
import hashlib
import json
import os
import time
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from .dependencies import system_admin
from .http_guard_api import Service, storage_call, window
from .http_guard_timeline import timeline


router = APIRouter(prefix='/api/v1')
PAGES = {
    'dashboard', 'scanner', 'subject-catalog', 'electives', 'exams', 'marking', 'exceptions',
    'results', 'people', 'conversions', 'settings', 'account', 'archives', 'login',
    'login/admin', 'login/marking',
    'http-guard/overview', 'http-guard/events', 'http-guard/policies', 'http-guard/performance', 'http-guard/traffic',
}


def check_origin(request):
    supplied = request.headers.get('origin', '')
    site = request.headers.get('sec-fetch-site')
    try:
        origin = urlsplit(supplied)
        valid = (origin.scheme in ('http', 'https') and not origin.path and not origin.query and not origin.fragment
                 and not origin.username and not origin.password and origin.netloc
                 and origin.netloc.lower() == request.headers.get('host', '').lower())
        # Caddy terminates TLS. Modern browsers attest the origin relation directly.
        # Older clients behind the proxy can use the configured public origin.
        if valid and site is None and origin.scheme != request.url.scheme:
            configured = os.getenv('OMP_WS_ORIGINS', '') + ',' + os.getenv('OMP_WEBAUTHN_ORIGINS', '')
            valid = supplied in (value.strip() for value in configured.split(','))
    except ValueError:
        valid = False
    if not valid or site not in (None, 'same-origin'):
        raise HTTPException(403, '仅接收同源页面访问')


def uuid4_value(value):
    if not isinstance(value, str) or len(value) != 36:
        raise ValueError
    parsed = UUID(value)
    if parsed.version != 4 or str(parsed) != value.lower():
        raise ValueError
    return parsed


@router.post('/telemetry/page-view', status_code=204)
async def collect_page_view(request: Request):
    check_origin(request)
    guard = request.app.state.http_guard
    if guard.policy.mode != 'off':
        if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
            raise HTTPException(415, '需要 JSON 请求')
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 512:
                raise HTTPException(413, '页面访问事件过大')
            data.extend(chunk)
        try:
            body = json.loads(data)
            if not isinstance(body, dict) or set(body) != {'id', 'visitor', 'page'} or body['page'] not in PAGES:
                raise ValueError
            view_id = uuid4_value(body['id'])
            visitor = uuid4_value(body['visitor'])
        except (ValueError, TypeError, UnicodeError, RecursionError) as error:
            raise HTTPException(422, '页面访问事件格式无效') from error
        guard.offer({'kind': 'page_view', 'ts': time.time(), 'id': str(view_id),
                     'visitor': hashlib.sha256(visitor.bytes).digest(), 'page': body['page']})
    return Response(status_code=204, headers={'Cache-Control': 'no-store'})


@router.get('/system/http-guard/analytics', dependencies=[Depends(system_admin)])
def analytics(guard: Service, hours: int = Depends(window)):
    return storage_call(guard.store.analytics, hours)


@router.get('/system/http-guard/timeline', dependencies=[Depends(system_admin)])
def traffic_timeline(guard: Service, start: Annotated[int, Query(ge=0, le=253402300799)],
                     end: Annotated[int, Query(ge=0, le=253402300799)],
                     interval: Literal['auto', 'minute', 'hour', 'day'] = 'auto'):
    return storage_call(timeline, guard.store, start, end, interval)
