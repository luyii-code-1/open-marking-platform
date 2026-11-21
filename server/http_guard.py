"""HTTP source policy and bounded, asynchronous access metrics."""
from bisect import bisect_right
from collections import OrderedDict
from dataclasses import dataclass
from ipaddress import collapse_addresses, ip_address, ip_network, IPv6Address, IPv6Network
import logging
import os
import queue
import re
import socket
import threading
import time

from starlette.responses import JSONResponse

from .http_geoip import GeoIP
from .http_guard_store import DEFAULT_SETTINGS, GuardStore


log = logging.getLogger(__name__)
_SENSITIVE = re.compile(
    r'(?:^|/)(?:\.(?:git|svn|hg)(?:/|$)|\.env(?:[./]|$)|'
    r'\.aws/(?:credentials|config)(?:/|$)|\.ssh/(?:id_[^/]+|authorized_keys)(?:/|$))',
    re.IGNORECASE | re.ASCII,
)
_HOST = re.compile(r'(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?$')


def _network(text):
    if '%' in text:
        raise ValueError('不支持带接口标识的地址')
    net = ip_network(text, strict=False)
    if isinstance(net, IPv6Network) and net.prefixlen >= 96 and net.network_address.ipv4_mapped:
        return ip_network((net.network_address.ipv4_mapped, net.prefixlen - 96))
    return net


def _address(text):
    try:
        if '%' in text:
            return None
        parsed = ip_address(text)
        return (parsed.ipv4_mapped or parsed) if isinstance(parsed, IPv6Address) else parsed
    except (ValueError, TypeError):
        return None


def validate_settings(settings):
    if not isinstance(settings, dict):
        raise ValueError('无效的安全设置')
    result = {key: settings.get(key, default) for key, default in DEFAULT_SETTINGS.items()}
    if result['mode'] not in ('off', 'observe', 'enforce'):
        raise ValueError('请选择有效的防护模式')
    for key, low, high in [('retention_days', 1, 365), ('rate_per_minute', 0, 1000000)]:
        if type(result[key]) is not int or not low <= result[key] <= high:
            raise ValueError(f'{key} 需要介于 {low} 和 {high} 之间的整数')
    if type(result['block_sensitive_paths']) is not bool:
        raise ValueError('敏感路径防护需要布尔值')
    for key in ('allow_ips', 'deny_ips', 'allow_countries', 'deny_countries'):
        items = result[key]
        if not isinstance(items, list) or len(items) > 512:
            raise ValueError('每份规则列表最多包含 512 项')
        validated = {}
        for item in items:
            if not isinstance(item, str) or not item.strip() or len(item) > 100:
                raise ValueError('规则中包含无效的地址或国家代码')
            value = item.strip()
            if key.endswith('_ips'):
                try:
                    network = _network(value)
                except ValueError as exc:
                    raise ValueError(f'无效的 IP 地址或 CIDR 网段：{value}') from exc
                value = str(network.network_address) if network.prefixlen == network.max_prefixlen else str(network)
            else:
                if len(value) != 2 or not value.isascii() or not value.isalpha():
                    raise ValueError(f'无效的两位国家代码：{value}')
                value = value.upper()
            validated[value] = None
        result[key] = list(validated)
    return result


class Networks:
    """Binary search over disjoint, merged IPv4 and IPv6 address ranges."""
    def __init__(self, networks):
        self.ranges = {}
        networks = tuple(networks)
        for version in (4, 6):
            merged = list(collapse_addresses(net for net in networks if net.version == version))
            self.ranges[version] = ([int(net.network_address) for net in merged],
                                    [int(net.broadcast_address) for net in merged])

    def contains(self, address):
        if address is None:
            return False
        starts, ends = self.ranges[address.version]
        number = int(address)
        index = bisect_right(starts, number) - 1
        return index >= 0 and number <= ends[index]


@dataclass(frozen=True)
class Policy:
    mode: str
    retention_days: int
    allow_ips: Networks
    deny_ips: Networks
    allow_countries: frozenset
    deny_countries: frozenset
    rate_per_minute: int
    block_sensitive_paths: bool

    @classmethod
    def compile(cls, settings):
        values = validate_settings(settings)
        for key in ('allow_ips', 'deny_ips'):
            values[key] = Networks(_network(item) for item in values[key])
        for key in ('allow_countries', 'deny_countries'):
            values[key] = frozenset(values[key])
        return cls(**values)

    def source(self, address, country):
        if self.allow_ips.contains(address):
            return '', True
        if self.deny_ips.contains(address):
            return 'deny_ip', False
        if country in self.deny_countries:
            return 'deny_country', False
        if self.allow_countries and country not in self.allow_countries:
            return 'country_not_allowed', False
        return '', False


class Guard:
    def __init__(self, root):
        self.root = root
        self.store = GuardStore(root)
        self.geo = GeoIP(root)
        self.policy = Policy.compile(DEFAULT_SETTINGS)
        self._settings = None
        self._reload_lock = threading.Lock()
        self._proxies = Networks(())
        self._proxy_entries = os.getenv('OMP_HTTP_TRUSTED_PROXIES', '').split(',')
        self._rates = OrderedDict()
        self._rate_minute = None
        self._rate_lock = threading.Lock()
        self._events = queue.Queue(maxsize=4096)
        self._stop = threading.Event()
        self._thread = None
        self._updater = None
        self._dropped = self._write_errors = self._settings_errors = 0

    def start(self):
        self._maintain(refresh_proxies=True)
        self._updater = threading.Thread(target=self._refresh_loop, name='omp-http-policy', daemon=True)
        self._thread = threading.Thread(target=self._run, name='omp-http-guard', daemon=True)
        self._updater.start()
        self._thread.start()

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=8)
        if self._updater:
            self._updater.join(timeout=1)
        if not self._updater or not self._updater.is_alive():
            self.geo.close()

    def status(self):
        return {'queued': self._events.qsize(), 'dropped': self._dropped,
                'writer_errors': self._write_errors, 'settings_errors': self._settings_errors}

    def reload(self):
        with self._reload_lock:
            settings = self.store.settings()
            if settings != self._settings:
                policy = Policy.compile(settings)
                if self.policy.rate_per_minute != policy.rate_per_minute:
                    with self._rate_lock:
                        self._rates.clear()
                self.policy = policy
                self._settings = settings

    def _maintain(self, refresh_proxies):
        try:
            self.reload()
        except Exception:
            self._settings_errors += 1
            if self._settings_errors == 1:
                log.exception('HTTP 防护设置读取失败')
        try:
            self.geo.refresh()
        except Exception:
            self._settings_errors += 1
            if self._settings_errors == 1:
                log.exception('GeoIP 加载失败')
        if refresh_proxies:
            networks = []
            for entry in self._proxy_entries:
                entry = entry.strip()
                if not entry:
                    continue
                try:
                    networks.append(_network(entry))
                    continue
                except ValueError:
                    if not _HOST.fullmatch(entry):
                        continue
                try:
                    for answer in socket.getaddrinfo(entry, None, type=socket.SOCK_STREAM):
                        addr = _address(answer[4][0])
                        if addr is not None:
                            networks.append(ip_network(addr))
                except OSError:
                    log.warning('可信代理域名解析失败：%s', entry)
            self._proxies = Networks(networks)

    def _refresh_loop(self):
        next_dns = time.monotonic() + 60
        while not self._stop.wait(2):
            now = time.monotonic()
            self._maintain(now >= next_dns)
            if now >= next_dns:
                next_dns = now + 60

    def _run(self):
        next_purge = 0
        last_retention = None
        while True:
            now = time.monotonic()
            retention = self.policy.retention_days
            if not self._stop.is_set() and (now >= next_purge or retention != last_retention):
                try:
                    self.store.purge(retention)
                    next_purge = now + 3600
                except Exception:
                    self._write_errors += 1
                    next_purge = now + 60
                last_retention = retention
            try:
                event = self._events.get(timeout=0.2)
            except queue.Empty:
                if self._stop.is_set():
                    return
                continue
            batch = [event]
            deadline = time.monotonic() + 0.2
            while len(batch) < 256:
                try:
                    remaining = max(0, deadline - time.monotonic())
                    batch.append(self._events.get(timeout=0 if self._stop.is_set() else remaining))
                except queue.Empty:
                    break
            try:
                self.store.append(batch)
            except Exception:
                self._write_errors += 1
                self._dropped += len(batch)
                if self._write_errors == 1:
                    log.exception('HTTP 安全日志写入失败')

    def offer(self, event):
        try:
            self._events.put_nowait(event)
        except queue.Full:
            self._dropped += 1

    def _client_address(self, scope):
        client = scope.get('client')
        peer = _address(client[0]) if client else None
        if not self._proxies.contains(peer):
            return peer
        # Trust only hops vouched for by the peer on their right. Multiple XFF
        # header instances are equivalent to a single comma-delimited chain.
        address = peer
        for key, value in reversed(scope.get('headers', [])):
            if key.lower() != b'x-forwarded-for':
                continue
            for hop in reversed(value.split(b',')):
                if not self._proxies.contains(address):
                    return address
                try:
                    address = _address(hop.strip().decode('ascii'))
                except UnicodeDecodeError:
                    return None
                if address is None:
                    return None
        return address

    def client_ip(self, scope):
        address = self._client_address(scope)
        return str(address) if address is not None else ''

    def _country(self, ip):
        if not ip or self.geo is None:
            return ''
        try:
            return self.geo.country(ip) or ''
        except Exception:
            return ''

    def source_reason(self, settings, ip):
        return Policy.compile(settings).source(_address(ip), self._country(ip))[0]

    def _over_limit(self, ip, limit):
        minute = int(time.monotonic() // 60)
        with self._rate_lock:
            if minute != self._rate_minute:
                self._rates.clear()
                self._rate_minute = minute
            if ip not in self._rates and len(self._rates) >= 65536:
                self._rates.popitem(last=False)
            count = self._rates.get(ip, 0) + 1
            self._rates[ip] = count
            self._rates.move_to_end(ip)
        return count > limit

    def evaluate(self, scope, policy):
        address = self._client_address(scope)
        ip = str(address) if address is not None else ''
        country = self._country(ip)
        if (scope['type'] == 'http' and scope['method'] == 'GET' and scope['path'] == '/api/v1/health'
                and address is not None and address.is_loopback
                and not any(name.lower() == b'x-forwarded-for' for name, _ in scope.get('headers', []))):
            # The container's local readiness check must keep working when an
            # administrator limits traffic by country or source network.
            return ip, country, ''
        reason, allowed = policy.source(address, country)
        if not allowed and not reason:
            if policy.block_sensitive_paths and _SENSITIVE.search(scope['path']):
                reason = 'sensitive_path'
            elif policy.rate_per_minute and self._over_limit(ip, policy.rate_per_minute):
                reason = 'rate_limit'
        return ip, country, reason


class HttpGuardMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] not in ('http', 'websocket'):
            return await self.app(scope, receive, send)
        guard = getattr(scope['app'].state, 'http_guard', None)
        if guard is None or (policy := guard.policy).mode == 'off':
            return await self.app(scope, receive, send)
        started = time.monotonic()
        ip, country, reason = guard.evaluate(scope, policy)
        blocked = bool(reason) and policy.mode == 'enforce'
        if scope['type'] == 'websocket':
            if blocked:
                return await send({'type': 'websocket.close', 'code': 1008})
            return await self.app(scope, receive, send)
        status = 500
        bytes_out = 0
        content_length = 0

        async def send_counted(message):
            nonlocal status, bytes_out, content_length
            await send(message)
            if message['type'] == 'http.response.start':
                status = message['status']
                if 'http.response.pathsend' in scope.get('extensions', {}):
                    for name, value in message.get('headers', ()):
                        if name == b'content-length' and value.isdigit() and len(value) <= 20:
                            content_length = int(value)
            elif message['type'] == 'http.response.body':
                bytes_out += len(message.get('body', b''))
            elif message['type'] == 'http.response.pathsend':
                bytes_out += content_length

        try:
            if blocked:
                code = 429 if reason == 'rate_limit' else 403
                response = JSONResponse({'detail': '请求过于频繁' if code == 429 else '来源或访问路径受限'},
                                        status_code=code, headers={'Cache-Control': 'no-store'})
                return await response(scope, receive, send_counted)
            return await self.app(scope, receive, send_counted)
        finally:
            # A route template never includes arbitrary submitted paths, query
            # strings or the archive download ticket occupying a path segment.
            route = getattr(scope.get('route'), 'path', None) or ('<blocked>' if blocked else '<unmatched>')
            guard.offer({'ts': time.time(), 'ip': ip, 'country': country,
                         'method': scope['method'][:16], 'route': route[:256],
                         'status': status, 'duration_ms': round((time.monotonic() - started) * 1000, 2),
                         'bytes_out': bytes_out, 'decision': 'blocked' if blocked else 'observed' if reason else 'pass',
                         'reason': reason})
