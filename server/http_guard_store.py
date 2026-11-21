"""Independent, local HTTP telemetry database shared by API workers."""
from collections import defaultdict
from bisect import bisect_left
from contextlib import closing, contextmanager
import json
from pathlib import Path
import sqlite3
import threading
import time


DEFAULT_SETTINGS = {
    'mode': 'observe', 'retention_days': 60, 'allow_ips': [], 'deny_ips': [],
    'allow_countries': [], 'deny_countries': [], 'rate_per_minute': 0,
    'block_sensitive_paths': True, 'sqli_mode': 'observe', 'xss_mode': 'observe', 'managed_ips': [],
}
BUCKET_SECONDS = {1: 60, 24: 1800, 168: 10800, 720: 43200}
LATENCY_BOUNDS = (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000)
MONITORING_ROUTES = {'/api/v1/health', '/api/v1/system/build', '/api/v1/telemetry/page-view',
                     '/api/v1/auth/activity', '/api/v1/auth/session'}

SCHEMA = """
CREATE TABLE IF NOT EXISTS policy (
    id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, ip TEXT NOT NULL,
    country TEXT NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL,
    duration_ms REAL NOT NULL, bytes_out INTEGER NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_time ON event(ts);
CREATE INDEX IF NOT EXISTS event_ip ON event(ip,id);
CREATE INDEX IF NOT EXISTS event_decision ON event(decision,id);
CREATE TABLE IF NOT EXISTS minute (
    ts INTEGER PRIMARY KEY, requests INTEGER, blocked INTEGER, observed INTEGER,
    errors INTEGER, duration REAL, bytes_out INTEGER
);
CREATE TABLE IF NOT EXISTS source_hour (
    ts INTEGER NOT NULL, ip TEXT NOT NULL, country TEXT NOT NULL,
    requests INTEGER, blocked INTEGER, PRIMARY KEY(ts,ip,country)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS web_collection (
    id INTEGER PRIMARY KEY CHECK (id=1), started REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS web_seen (id TEXT PRIMARY KEY, ts REAL NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS web_seen_time ON web_seen(ts);
CREATE TABLE IF NOT EXISTS web_visitor (id BLOB PRIMARY KEY, ts REAL NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS web_visitor_time ON web_visitor(ts);
CREATE TABLE IF NOT EXISTS web_account (id TEXT PRIMARY KEY, ts REAL NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS web_account_time ON web_account(ts);
CREATE TABLE IF NOT EXISTS web_page (
    ts INTEGER NOT NULL, page TEXT NOT NULL, pv INTEGER NOT NULL, PRIMARY KEY(ts,page)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS web_route (
    ts INTEGER NOT NULL, route TEXT NOT NULL, method TEXT NOT NULL, bin INTEGER NOT NULL,
    requests INTEGER NOT NULL, errors INTEGER NOT NULL, duration REAL NOT NULL, peak REAL NOT NULL,
    PRIMARY KEY(ts,route,method,bin)
) WITHOUT ROWID;
"""


class RevisionConflict(Exception):
    pass


class GuardStore:
    def __init__(self, root):
        self.path = Path(root) / 'http-guard' / 'traffic.sqlite3'
        self._ready = False
        self._init_lock = threading.Lock()

    @contextmanager
    def connection(self):
        if not self._ready:
            with self._init_lock:
                if not self._ready:
                    self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with closing(sqlite3.connect(self.path, timeout=4)) as setup, setup:
                        setup.execute('PRAGMA journal_mode=WAL')
                        setup.executescript(SCHEMA)
                        # API processes can start concurrently against a database from an earlier release.
                        setup.execute('BEGIN IMMEDIATE')
                        columns = {row[1] for row in setup.execute('PRAGMA table_info(event)')}
                        for name in ('actor', 'actor_label', 'actor_kind'):
                            if name not in columns:
                                setup.execute(f"ALTER TABLE event ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
                        for name in ('actor', 'actor_label', 'reason'):
                            setup.execute(f"CREATE INDEX IF NOT EXISTS event_{name}_lookup ON event({name},id) WHERE {name}<>''")
                        setup.execute('INSERT OR IGNORE INTO policy VALUES (1, 1, ?)',
                                      (json.dumps(DEFAULT_SETTINGS),))
                        setup.execute('INSERT OR IGNORE INTO web_collection VALUES (1, ?)', (time.time(),))
                    self._ready = True
        with closing(sqlite3.connect(self.path, timeout=4)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA synchronous=NORMAL')
            yield db

    def settings(self):
        with self.connection() as db:
            row = db.execute('SELECT revision, body FROM policy WHERE id=1').fetchone()
            return {**DEFAULT_SETTINGS, **json.loads(row['body']), 'revision': row['revision']}

    def save_settings(self, settings, revision):
        with self.connection() as db:
            updated = db.execute('UPDATE policy SET body=?, revision=revision+1 WHERE id=1 AND revision=?',
                                 (json.dumps(settings), revision))
            if updated.rowcount != 1:
                raise RevisionConflict()
            return {**settings, 'revision': revision + 1}

    def append(self, events):
        if not events:
            return
        views = [event for event in events if event.get('kind') == 'page_view']
        events = [event for event in events if event.get('kind') != 'page_view']
        minutes = defaultdict(lambda: [0, 0, 0, 0, 0.0, 0])
        sources = defaultdict(lambda: [0, 0])
        accounts = {}
        routes = defaultdict(lambda: [0, 0, 0.0, 0.0])
        for event in events:
            for field in ('actor', 'actor_label', 'actor_kind'):
                event[field] = event.get(field) or ''
            ts = int(event['ts'])
            minute = minutes[ts - ts % 60]
            source = sources[(ts - ts % 3600, event['ip'], event['country'])]
            blocked = event['decision'] == 'blocked'
            minute[0] += 1
            minute[1] += blocked
            minute[2] += event['decision'] == 'observed'
            minute[3] += event['status'] >= 500
            minute[4] += event['duration_ms']
            minute[5] += event['bytes_out']
            source[0] += 1
            source[1] += blocked
            if event['actor_kind'] == 'user' and event['actor']:
                accounts[event['actor']] = max(accounts.get(event['actor'], 0), event['ts'])
            route = event['route']
            if route.startswith('/api/v1/') and route not in MONITORING_ROUTES and not route.startswith('/api/v1/system/http-guard'):
                duration = event['duration_ms']
                key = (ts - ts % 60, route, event['method'], bisect_left(LATENCY_BOUNDS, duration))
                counts = routes[key]
                counts[0] += 1
                counts[1] += event['status'] >= 500
                counts[2] += duration
                counts[3] = max(counts[3], duration)
        with self.connection() as db:
            db.executemany("""
                INSERT INTO event(ts,ip,country,method,route,status,duration_ms,bytes_out,decision,reason,actor,actor_label,actor_kind)
                VALUES (:ts,:ip,:country,:method,:route,:status,:duration_ms,:bytes_out,:decision,:reason,:actor,:actor_label,:actor_kind)
            """, events)
            db.executemany("""
                INSERT INTO minute VALUES (?,?,?,?,?,?,?) ON CONFLICT(ts) DO UPDATE SET
                requests=requests+excluded.requests, blocked=blocked+excluded.blocked,
                observed=observed+excluded.observed, errors=errors+excluded.errors,
                duration=duration+excluded.duration, bytes_out=bytes_out+excluded.bytes_out
            """, ((ts, *counts) for ts, counts in minutes.items()))
            db.executemany("""
                INSERT INTO source_hour VALUES (?,?,?,?,?) ON CONFLICT(ts,ip,country) DO UPDATE SET
                requests=requests+excluded.requests, blocked=blocked+excluded.blocked
            """, ((*key, *counts) for key, counts in sources.items()))
            db.executemany("""INSERT INTO web_account VALUES (?,?) ON CONFLICT(id)
                              DO UPDATE SET ts=max(ts,excluded.ts)""", accounts.items())
            db.executemany("""INSERT INTO web_route VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(ts,route,method,bin)
                DO UPDATE SET requests=requests+excluded.requests, errors=errors+excluded.errors,
                duration=duration+excluded.duration, peak=max(peak,excluded.peak)""",
                ((*key, *counts) for key, counts in routes.items()))
            for view in views:
                ts = view['ts']
                inserted = db.execute('INSERT OR IGNORE INTO web_seen VALUES (?,?)', (view['id'], ts))
                if inserted.rowcount:
                    db.execute("""INSERT INTO web_visitor VALUES (?,?) ON CONFLICT(id)
                               DO UPDATE SET ts=max(ts,excluded.ts)""", (view['visitor'], ts))
                    db.execute("""INSERT INTO web_page VALUES (?,?,1) ON CONFLICT(ts,page)
                               DO UPDATE SET pv=pv+1""", (int(ts) // 60 * 60, view['page']))

    def purge(self, retention_days):
        cutoff = int(time.time()) - retention_days * 86400
        # Release the write lock between batches so a retention change can run alongside ingestion.
        tables = (('event', 'id', 1), ('minute', 'ts', 60), ('source_hour', '(ts,ip,country)', 3600),
                  ('web_seen', 'id', 1), ('web_visitor', 'id', 1), ('web_account', 'id', 1),
                  ('web_page', '(ts,page)', 60), ('web_route', '(ts,route,method,bin)', 60))
        for table, keys, width in tables:
            limit = cutoff - cutoff % width
            select_keys = keys.strip('()')
            while True:
                with self.connection() as db:
                    removed = db.execute(f'DELETE FROM {table} WHERE {keys} IN '
                                         f'(SELECT {select_keys} FROM {table} WHERE ts<? LIMIT 2000)', (limit,))
                if removed.rowcount < 2000:
                    break
        with self.connection() as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='policy_change'").fetchone():
                db.execute('DELETE FROM policy_change WHERE ts<?', (cutoff,))

    def analytics(self, hours):
        now = int(time.time())
        with self.connection() as db:
            db.execute('BEGIN')
            retention = json.loads(db.execute('SELECT body FROM policy WHERE id=1').fetchone()[0])['retention_days'] * 24
            hours = min(hours or retention, retention)
            start = now - now % 60 - hours * 3600 + 60
            width = BUCKET_SECONDS.get(hours) or max(3600, ((hours + 59) // 60) * 3600)
            since = db.execute('SELECT started FROM web_collection WHERE id=1').fetchone()[0]
            uv = db.execute('SELECT count(*) FROM web_visitor WHERE ts>=?', (start,)).fetchone()[0]
            accounts = db.execute('SELECT count(*) FROM web_account WHERE ts>=?', (start,)).fetchone()[0]
            series = dict(db.execute('SELECT ts/?*?,sum(pv) FROM web_page WHERE ts>=? GROUP BY 1',
                                     (width, width, start)))
            pages = db.execute('SELECT page,sum(pv) pv FROM web_page WHERE ts>=? GROUP BY page ORDER BY pv DESC,page',
                               (start,)).fetchall()
            bins = db.execute("""SELECT route,method,bin,sum(requests) n,sum(errors) errors,
                sum(duration) duration,max(peak) peak FROM web_route WHERE ts>=?
                GROUP BY route,method,bin ORDER BY route,method,bin""", (start,))
            routes = {}
            for row in bins:
                key = (row['route'], row['method'])
                data = routes.setdefault(key, {'route': key[0], 'method': key[1], 'requests': 0, 'errors': 0,
                                               'duration': 0.0, 'max_ms': 0.0, 'bins': []})
                data['requests'] += row['n']
                data['errors'] += row['errors']
                data['duration'] += row['duration']
                data['max_ms'] = max(data['max_ms'], row['peak'])
                data['bins'].append((row['n'], row['peak']))
        for entry in routes.values():
            entry['avg_ms'] = round(entry.pop('duration') / entry['requests'], 2)
            rank = (entry['requests'] * 95 + 99) // 100
            for count, peak in entry.pop('bins'):
                rank -= count
                if rank <= 0:
                    entry['p95_ms'] = round(peak, 2)
                    break
        return {'pv': sum(series.values()), 'uv': uv, 'active_accounts': accounts, 'since': since,
                'series': [{'ts': ts, 'pv': series.get(ts, 0)} for ts in range(start - start % width, now + 1, width)],
                'pages': [dict(page) for page in pages],
                'routes': sorted(routes.values(), key=lambda item: (-item['requests'], item['route'], item['method']))}

    def events(self, hours, ip, decision, before, limit, actor='', reason='', status_group=0):
        clauses = ['ts>=?']
        args = []
        for condition, value in (('ip=?', ip), ('decision=?', decision), ('id<?', before),
                                 ("reason<>'' AND reason=?", reason)):
            if value is not None and value != '':
                clauses.append(condition)
                args.append(value)
        if actor:
            clauses.append("((actor<>'' AND actor=?) OR (actor_label<>'' AND actor_label=?))")
            args.extend((actor, actor))
        if status_group:
            clauses.append('status>=? AND status<?')
            args.extend((status_group * 100, (status_group + 1) * 100))
        with self.connection() as db:
            retention = json.loads(db.execute('SELECT body FROM policy WHERE id=1').fetchone()[0])['retention_days'] * 24
            start = time.time() - min(hours or retention, retention) * 3600
            rows = db.execute('SELECT * FROM event WHERE ' + ' AND '.join(clauses)
                              + ' ORDER BY id DESC LIMIT ?', [start, *args, limit + 1]).fetchall()
        items = [dict(row) for row in rows[:limit]]
        return {'items': items, 'next_before': items[-1]['id'] if len(rows) > limit else None}

    def overview(self, hours):
        now = int(time.time())
        # Use whole minutes so counters and source counts share the same window.
        with self.connection() as db:
            db.execute('BEGIN')
            retention = json.loads(db.execute('SELECT body FROM policy WHERE id=1').fetchone()[0])['retention_days'] * 24
            hours = min(hours or retention, retention)
            start = now - now % 60 - hours * 3600 + 60
            width = BUCKET_SECONDS.get(hours) or max(3600, ((hours + 59) // 60) * 3600)
            rows = db.execute("""
                SELECT ts / ? * ? AS bucket, sum(requests) AS requests, sum(blocked) AS blocked,
                       sum(observed) AS observed, sum(errors) AS errors, sum(duration) AS duration,
                       sum(bytes_out) AS bytes_out FROM minute WHERE ts>=? GROUP BY bucket
            """, (width, width, start)).fetchall()
            # Only the leading partial hour needs to touch request details. All other hours
            # (including the current one) already have per-source counts in the same transaction.
            next_hour = ((start + 3599) // 3600) * 3600
            db.execute("""
                CREATE TEMP TABLE sources AS
                SELECT ip,country,sum(n) AS requests,sum(b) AS blocked FROM (
                    SELECT ip,country,count(*) AS n,sum(decision='blocked') AS b
                    FROM event WHERE ts>=? AND ts<? GROUP BY ip,country
                    UNION ALL
                    SELECT ip,country,requests,blocked FROM source_hour WHERE ts>=?
                ) GROUP BY ip,country
            """, (start, next_hour, next_hour))
            unique_ips = db.execute("SELECT count(DISTINCT ip) FROM sources WHERE ip<>''").fetchone()[0]
            top = db.execute("""
                SELECT ip,max(country) AS country,sum(requests) AS requests,sum(blocked) AS blocked
                FROM sources WHERE ip<>'' GROUP BY ip ORDER BY requests DESC,ip LIMIT 10
            """).fetchall()
            countries = db.execute("""
                SELECT country,sum(requests) AS requests FROM sources
                GROUP BY country ORDER BY requests DESC,country LIMIT 10
            """).fetchall()
        values = {row['bucket']: row for row in rows}
        series = []
        for ts in range(start - start % width, now + 1, width):
            row = values.get(ts)
            series.append({'ts': ts, **{k: row[k] if row else 0 for k in ('requests', 'blocked', 'observed')}})
        requests = sum(row['requests'] for row in rows)
        return {
            'requests': requests, 'unique_ips': unique_ips, 'blocked': sum(row['blocked'] for row in rows),
            'observed': sum(row['observed'] for row in rows), 'server_errors': sum(row['errors'] for row in rows),
            'avg_ms': round(sum(row['duration'] for row in rows) / requests, 2) if requests else 0,
            'bytes_out': sum(row['bytes_out'] for row in rows), 'series': series,
            'top_ips': [dict(row) for row in top], 'countries': [dict(row) for row in countries],
        }
