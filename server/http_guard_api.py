from ipaddress import ip_address, IPv6Address
import sqlite3
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from .dependencies import system_admin
from .http_geoip import UpdateInProgress
from . import http_guard_policy
from .http_guard_inspection import engine_status
from .http_guard_store import BUCKET_SECONDS, RevisionConflict


def guard_service(request: Request, response: Response):
    response.headers['Cache-Control'] = 'private, no-store'
    return request.app.state.http_guard


router = APIRouter(prefix='/api/v1/system/http-guard', dependencies=[Depends(system_admin)])
Service = Annotated[object, Depends(guard_service)]
Rules = Annotated[list[Annotated[str, Field(max_length=100)]], Field(max_length=512)]
Mode = Literal['off', 'observe', 'enforce']


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    mode: Mode
    revision: int = Field(ge=1, le=2**63 - 2)
    retention_days: int = Field(ge=1, le=365)
    rate_per_minute: int = Field(ge=0, le=1_000_000)
    block_sensitive_paths: bool
    allow_ips: Rules
    deny_ips: Rules
    allow_countries: Rules
    deny_countries: Rules
    sqli_mode: Mode | None = None
    xss_mode: Mode | None = None
    managed_ips: list[dict] | None = Field(None, max_length=512, exclude=True)


class EventPolicy(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    revision: int = Field(ge=1, le=2**63 - 2)
    event_ids: list[Annotated[int, Field(ge=1, le=2**63 - 1)]] = Field(min_length=1, max_length=200)
    action: Literal['allow', 'deny']
    ttl_hours: Literal[0, 1, 24, 168] = 24


class RemovePolicy(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    revision: int = Field(ge=1, le=2**63 - 2)
    ip: str = Field(min_length=2, max_length=45)


def window(hours: int = 24):
    if hours != 0 and hours not in BUCKET_SECONDS:
        raise HTTPException(422, '请选择有效的统计时段')
    return hours


def storage_call(fn, *args):
    try:
        return fn(*args)
    except (OSError, sqlite3.Error) as error:
        raise HTTPException(503, 'HTTP 防护数据库暂时不可用') from error
    except RevisionConflict as error:
        raise HTTPException(409, '策略已由其他管理员更新，请刷新后再提交') from error
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.get('/settings')
def settings(guard: Service):
    return http_guard_policy.current_policy(storage_call(guard.store.settings))


@router.put('/settings')
def save_settings(body: Settings, request: Request, guard: Service, admin=Depends(system_admin)):
    return storage_call(http_guard_policy.save, guard, body.revision, admin['username'],
                        body.model_dump(exclude={'revision'}, exclude_none=True),
                        guard.client_ip(request.scope), engine_status()['ready'])


@router.post('/event-policy')
def event_policy(body: EventPolicy, request: Request, guard: Service, admin=Depends(system_admin)):
    return storage_call(http_guard_policy.add_from_events, guard, body.revision, admin['username'],
                        body.event_ids, body.action, body.ttl_hours, guard.client_ip(request.scope))


@router.post('/remove-policy')
def remove_policy(body: RemovePolicy, request: Request, guard: Service, admin=Depends(system_admin)):
    return storage_call(http_guard_policy.remove, guard, body.revision, admin['username'], body.ip,
                        guard.client_ip(request.scope))


@router.get('/policy-history')
def policy_history(guard: Service):
    return storage_call(http_guard_policy.history, guard.store)


@router.get('/status')
def status(request: Request, guard: Service):
    ip = guard.client_ip(request.scope)
    state = guard.status()
    return {'client_ip': ip, 'geo': guard.geo.status(), 'engine': engine_status(),
            'runtime': {'queued': state['queued'], 'dropped': state['dropped'],
                        'write_errors': state['writer_errors'], 'settings_errors': state['settings_errors']}}


@router.post('/geoip/update')
def update_geoip(guard: Service):
    try:
        return guard.geo.update()
    except UpdateInProgress as error:
        raise HTTPException(409, 'GeoIP 正在更新，请稍后刷新') from error
    except (ValueError, OSError) as error:
        raise HTTPException(502, 'GeoIP 更新失败，请检查数据源连接及文件写入权限') from error


@router.get('/overview')
def overview(guard: Service, hours: int = Depends(window)):
    return storage_call(guard.store.overview, hours)


@router.get('/events')
def events(guard: Service, hours: int = Depends(window), ip: str = Query('', max_length=64),
           decision: Literal['', 'pass', 'observed', 'blocked'] = '',
           actor: str = Query('', max_length=160), reason: str = Query('', max_length=40),
           status_group: int | None = Query(None, ge=2, le=5),
           before: int | None = Query(None, ge=1, le=2**63 - 1), limit: int = Query(50, ge=1, le=200)):
    if ip:
        try:
            address = ip_address(ip.strip())
            ip = str(address.ipv4_mapped or address) if isinstance(address, IPv6Address) else str(address)
        except ValueError as error:
            raise HTTPException(422, '请输入完整的 IPv4 或 IPv6 地址') from error
    return storage_call(guard.store.events, hours, ip, decision, before, limit, actor.strip(), reason, status_group)
