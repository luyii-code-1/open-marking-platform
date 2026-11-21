from ipaddress import ip_address, IPv6Address
import sqlite3
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from .dependencies import system_admin
from .http_geoip import UpdateInProgress
from .http_guard import validate_settings
from .http_guard_store import BUCKET_SECONDS, RevisionConflict


def guard_service(request: Request, response: Response):
    response.headers['Cache-Control'] = 'private, no-store'
    return request.app.state.http_guard


router = APIRouter(prefix='/api/v1/system/http-guard', dependencies=[Depends(system_admin)])
Service = Annotated[object, Depends(guard_service)]
Rules = Annotated[list[Annotated[str, Field(max_length=100)]], Field(max_length=512)]


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    mode: Literal['off', 'observe', 'enforce']
    revision: int = Field(ge=1, le=2**63 - 2)
    retention_days: int = Field(ge=1, le=365)
    rate_per_minute: int = Field(ge=0, le=1_000_000)
    block_sensitive_paths: bool
    allow_ips: Rules
    deny_ips: Rules
    allow_countries: Rules
    deny_countries: Rules


def window(hours: int = 24):
    if hours != 0 and hours not in BUCKET_SECONDS:
        raise HTTPException(422, '请选择有效的统计时段')
    return hours


def storage_call(fn, *args):
    try:
        return fn(*args)
    except (OSError, sqlite3.Error) as error:
        raise HTTPException(503, 'HTTP 防护数据库暂时不可用') from error


@router.get('/settings')
def settings(guard: Service):
    return storage_call(guard.store.settings)


@router.put('/settings')
def save_settings(body: Settings, request: Request, guard: Service):
    try:
        policy = validate_settings(body.model_dump(exclude={'revision'}))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if policy['mode'] == 'enforce':
        if (policy['allow_countries'] or policy['deny_countries']) and not guard.geo.status()['ready']:
            raise HTTPException(422, '启用地区拦截前，请先下载 GeoIP 数据库')
        if guard.source_reason(policy, guard.client_ip(request.scope)):
            raise HTTPException(422, '这组规则会拦截你当前的来源 IP，请先调整来源规则')
    try:
        result = storage_call(guard.store.save_settings, policy, body.revision)
    except RevisionConflict as error:
        raise HTTPException(409, '设置已由其他管理员更新，请重新加载后再保存') from error
    storage_call(guard.reload)
    return result


@router.get('/status')
def status(request: Request, guard: Service):
    ip = guard.client_ip(request.scope)
    state = guard.status()
    return {'client_ip': ip, 'geo': guard.geo.status(),
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
           before: int | None = Query(None, ge=1, le=2**63 - 1), limit: int = Query(50, ge=1, le=200)):
    if ip:
        try:
            address = ip_address(ip.strip())
            ip = str(address.ipv4_mapped or address) if isinstance(address, IPv6Address) else str(address)
        except ValueError as error:
            raise HTTPException(422, '请输入完整的 IPv4 或 IPv6 地址') from error
    return storage_call(guard.store.events, hours, ip, decision, before, limit)
