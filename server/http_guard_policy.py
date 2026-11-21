"""Atomic policy edits and their administrator-visible history in the guard database."""
import json
import time
from ipaddress import ip_address, ip_network

from fastapi import HTTPException

from .http_guard import validate_settings
from .http_guard_store import DEFAULT_SETTINGS, RevisionConflict


HISTORY = """CREATE TABLE IF NOT EXISTS policy_change (
    id INTEGER PRIMARY KEY, ts REAL NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL, ips TEXT NOT NULL
)"""
LABELS = {
    'mode': '运行模式', 'retention_days': '保留天数', 'allow_ips': 'IP 放行名单',
    'deny_ips': 'IP 封禁名单', 'allow_countries': '允许地区', 'deny_countries': '封禁地区',
    'rate_per_minute': 'IP 限流', 'block_sensitive_paths': '敏感路径',
    'sqli_mode': 'SQL 注入检测', 'xss_mode': 'XSS 检测',
    'business_content_profile': '业务内容识别', 'adaptive_enabled': '动态限流',
    'anonymous_rate_per_minute': '匿名每分钟额度', 'authenticated_rate_per_minute': '已验证身份每分钟额度',
}
MODES = {'observe': '观察', 'off': '关闭', 'enforce': '拦截', 'uniform': '统一检测', 'verified_business': '识别已验证业务内容'}


def current_policy(policy):
    now = time.time()
    return {**policy, 'managed_ips': [item for item in policy.get('managed_ips', [])
                                      if not item['expires'] or item['expires'] > now]}


def _edit(guard, revision, actor, change):
    with guard.store.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT revision,body FROM policy WHERE id=1').fetchone()
        if revision != row['revision']:
            raise RevisionConflict()
        original = current_policy({**DEFAULT_SETTINGS, **json.loads(row['body'])})
        policy, summary, ips = change(db, original)
        policy = validate_settings(policy)
        if policy == original:
            return {**policy, 'revision': revision}
        db.execute('UPDATE policy SET revision=revision+1,body=? WHERE id=1', (json.dumps(policy),))
        db.execute(HISTORY)
        db.execute('INSERT INTO policy_change(ts,actor,summary,ips) VALUES (?,?,?,?)',
                   (time.time(), actor, summary, json.dumps(ips)))
        db.execute('DELETE FROM policy_change WHERE id <= (SELECT max(id)-500 FROM policy_change)')
    guard.reload()
    return {**policy, 'revision': revision + 1}


def save(guard, revision, actor, new_values, client_ip, engine_ready):
    def change(db, original):
        proposed = validate_settings({**original, **new_values})
        if proposed['mode'] == 'enforce':
            if (proposed['allow_countries'] or proposed['deny_countries']) and not guard.geo.status()['ready']:
                raise HTTPException(422, '启用地区拦截前，请先下载 GeoIP 数据库')
            if 'enforce' in (proposed['sqli_mode'], proposed['xss_mode']) and not engine_ready:
                raise HTTPException(422, '内容检测引擎尚未就绪')
            if guard.source_reason(proposed, client_ip):
                raise HTTPException(422, '这组规则会拦截你当前的来源 IP，请先调整来源规则')
        changes = []
        affected_ips = set()
        for key, label in LABELS.items():
            old, new = original[key], proposed[key]
            if old == new:
                continue
            if isinstance(new, list):
                added, removed = set(new) - set(old), set(old) - set(new)
                changes.append(f'{label} 增加 {len(added)} 项、移除 {len(removed)} 项')
                if key.endswith('_ips'):
                    affected_ips.update(added | removed)
            else:
                def display(value):
                    if isinstance(value, bool):
                        return '开启' if value else '关闭'
                    return MODES.get(value, str(value))
                changes.append(f'{label} {display(old)} → {display(new)}')
        return proposed, '，'.join(changes), sorted(affected_ips)

    return _edit(guard, revision, actor, change)


def add_from_events(guard, revision, actor, event_ids, action, hours, client_ip):
    ids = sorted(set(event_ids))
    def change(db, original):
        cutoff = time.time() - original['retention_days'] * 86400
        rows = db.execute(f"SELECT ip FROM event WHERE id IN ({','.join('?' for _ in ids)}) AND ts>=?",
                          [*ids, cutoff]).fetchall()
        if len(rows) != len(ids):
            raise HTTPException(409, '部分日志已过期，请刷新后重新选择')
        try:
            targets = sorted({ip_address(row['ip']) for row in rows}, key=lambda addr: (addr.version, int(addr)))
        except ValueError as error:
            raise HTTPException(422, '所选日志包含无法识别的来源 IP') from error
        managed = {item['ip']: item for item in original['managed_ips']}
        allowed = [ip_network(net, strict=False) for net in original['allow_ips']]
        denied = [ip_network(net, strict=False) for net in original['deny_ips']]
        expires = int(time.time()) + hours * 3600 if hours else 0
        ips = [str(addr) for addr in targets]
        for addr, ip in zip(targets, ips):
            if action == 'deny' and ip == client_ip:
                raise HTTPException(422, '所选日志包含你当前的 IP，请取消该来源')
            if action == 'deny' and any(addr in network for network in allowed):
                raise HTTPException(409, f'{ip} 已在放行名单中，请先调整放行规则')
            existing = denied if action == 'deny' else allowed
            if any(addr in network for network in existing):
                raise HTTPException(409, f'{ip} 已有相同的长期名单规则，请先从选择中移除')
            item = managed.get(ip)
            if item and item['action'] != action:
                raise HTTPException(409, f'{ip} 已有相反策略，请先撤销原策略')
            managed[ip] = {'ip': ip, 'action': action, 'expires': expires}
        verb = '放行' if action == 'allow' else '封禁'
        duration = f'{hours} 小时' if hours else '长期'
        return {**original, 'managed_ips': list(managed.values())}, f'{verb} {len(ips)} 个来源 IP（{duration}）', ips

    return _edit(guard, revision, actor, change)


def remove(guard, revision, actor, ip, client_ip):
    def change(db, original):
        proposed = {**original, 'managed_ips': [rule for rule in original['managed_ips'] if rule['ip'] != ip]}
        if proposed['mode'] == 'enforce' and guard.source_reason(proposed, client_ip):
            raise HTTPException(422, '撤销这条策略会拦截你当前的来源 IP')
        return proposed, '撤销精确 IP 策略', [ip]
    return _edit(guard, revision, actor, change)


def history(store):
    with store.connection() as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='policy_change'").fetchone():
            return {'items': []}
        days = json.loads(db.execute('SELECT body FROM policy WHERE id=1').fetchone()[0])['retention_days']
        rows = db.execute('SELECT * FROM policy_change WHERE ts>=? ORDER BY id DESC LIMIT 50',
                          (time.time() - days * 86400,)).fetchall()
    return {'items': [{**dict(row), 'ips': json.loads(row['ips'])} for row in rows]}
