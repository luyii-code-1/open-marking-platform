"""Calendar-aligned HTTP, browser and account metrics over a retained minute range."""
from math import ceil
import time


STEPS = {'minute': 60, 'hour': 3600, 'day': 86400}
MAX_BUCKETS = 400
SHANGHAI_OFFSET = 8 * 3600
_HTTP_COUNTS = ('requests', 'blocked', 'observed', 'server_errors', 'bytes_out')


def _floor(ts, step):
    return (ts + SHANGHAI_OFFSET) // step * step - SHANGHAI_OFFSET


def _choose_step(start, end, requested):
    for interval, step in STEPS.items():
        if requested in ('auto', interval):
            count = (_floor(end - 1, step) - _floor(start, step)) // step + 1
            if count <= MAX_BUCKETS:
                return interval, step
    raise ValueError('该粒度超过 400 个时间段，请缩短时段或选择更粗的粒度')


def _metrics():
    return {'pv': 0, 'uv': None, 'active_accounts': None, **dict.fromkeys(_HTTP_COUNTS, 0), 'avg_ms': None}


def _unique_counts(db, buckets, totals, field, source, column, predicate, since, start, end, expression, step,
                   current_end, latest_table):
    # Full source rows stay in SQLite. The application receives at most 400 counts.
    eligible = [bucket for bucket in buckets.values() if bucket['start'] >= since]
    for bucket in eligible:
        bucket[field] = 0
    where = f'ts>=? AND ts<? {predicate}'
    if eligible:
        for bucket_ts, count in db.execute(
                f'SELECT {expression},count(DISTINCT {column}) FROM {source} WHERE {where} GROUP BY 1',
                (step, step, eligible[0]['start'], end)):
            buckets[bucket_ts][field] = count
    if end == current_end:
        # A last-seen timestamp proves membership in a window ending now.
        # It cannot reconstruct membership in an earlier, closed window.
        latest = f'SELECT count(*) FROM {latest_table} WHERE ts>=? AND ts<?'
        totals[field] = db.execute(latest, (start, end)).fetchone()[0]
        last = next(reversed(buckets.values()))
        if last[field] is None:
            last[field] = (totals[field] if last['start'] == start else
                           db.execute(latest, (last['start'], end)).fetchone()[0])
    elif start >= since:
        if len(eligible) == 1:
            totals[field] = eligible[0][field]
        else:
            totals[field] = db.execute(f'SELECT count(DISTINCT {column}) FROM {source} WHERE {where}',
                                       (start, end)).fetchone()[0]


def timeline(store, start, end, interval='auto'):
    if start < 0 or end <= start or start % 60 or end % 60:
        raise ValueError('起止时间须为整分钟，且结束时间须晚于开始时间')
    if interval not in ('auto', *STEPS):
        raise ValueError('请选择有效的统计粒度')
    now = time.time()
    current_end = int(now) // 60 * 60 + 60
    with store.connection() as db:
        db.execute('BEGIN')
        retention_days = db.execute("SELECT json_extract(body,'$.retention_days') FROM policy WHERE id=1").fetchone()[0]
        # Removing the leading partially retained minute keeps raw identities and minute totals comparable.
        retained_start = ceil((now - retention_days * 86400) / 60) * 60
        start, end = max(retained_start, start), min(current_end, end)
        if start >= end:
            raise ValueError('所选时段超出日志保留范围或位于未来')
        interval, step = _choose_step(start, end, interval)
        buckets = {ts: {'ts': ts, 'start': max(ts, start), 'end': min(ts + step, end), **_metrics()}
                   for ts in range(_floor(start, step), end, step)}
        totals = _metrics()
        # The reusable expression accepts integer minute keys and fractional raw-event seconds.
        expression = f'CAST((ts+{SHANGHAI_OFFSET})/? AS INTEGER)*?-{SHANGHAI_OFFSET}'
        args = (step, step, start, end)
        duration_sum = 0.0
        for row in db.execute(f'''SELECT {expression}, sum(requests), sum(blocked), sum(observed),
                                  sum(errors), sum(bytes_out), sum(duration) FROM minute
                                  WHERE ts>=? AND ts<? GROUP BY 1''', args):
            bucket = buckets[row[0]]
            for key, value in zip(_HTTP_COUNTS, row[1:6]):
                bucket[key] = value
                totals[key] += value
            duration_sum += row[6]
            if bucket['requests']:
                bucket['avg_ms'] = round(row[6] / bucket['requests'], 2)
        if totals['requests']:
            totals['avg_ms'] = round(duration_sum / totals['requests'], 2)
        for ts, count in db.execute(f'SELECT {expression},sum(pv) FROM web_page WHERE ts>=? AND ts<? GROUP BY 1', args):
            buckets[ts]['pv'] = count
            totals['pv'] += count
        visits_since = db.execute('SELECT started FROM web_collection WHERE id=1').fetchone()[0]
        http_first_record = db.execute('SELECT min(ts) FROM minute').fetchone()[0]
        uv_since = db.execute('SELECT started FROM web_uv_collection WHERE id=1').fetchone()[0]
        accounts_since = ceil(visits_since / 60) * 60
        _unique_counts(db, buckets, totals, 'uv', 'web_visitor_minute', 'visitor', '',
                       uv_since, start, end, expression, step, current_end, 'web_visitor')
        _unique_counts(db, buckets, totals, 'active_accounts', 'event', 'actor',
                       "AND actor_kind='user' AND actor<>''", accounts_since, start, end, expression, step,
                       current_end, 'web_account')
    return {'start': start, 'end': end, 'interval': interval, 'step_seconds': step,
            'uv_since': uv_since, 'visits_since': visits_since, 'accounts_since': accounts_since,
            'http_first_record': http_first_record, 'retained_start': retained_start,
            'series': list(buckets.values()), 'totals': totals}
