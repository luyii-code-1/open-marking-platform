"""PostgreSQL connections for the API, workers, and grouped review writes."""
import atexit
import os
import re
from functools import lru_cache
from threading import Lock

from psycopg import OperationalError
from psycopg.pq import TransactionStatus
from psycopg_pool import ConnectionPool


class Row(tuple):
    """Rows can be unpacked, read by column name, or converted with dict(row)."""

    def __new__(cls, values, columns):
        row = super().__new__(cls, values)
        row.columns = columns
        return row

    def __getitem__(self, key):
        return super().__getitem__(self.columns[key] if isinstance(key, str) else key)

    def keys(self):
        return self.columns.keys()


def _row_factory(cursor):
    columns = {}
    for index, column in enumerate(cursor.description or ()):
        columns.setdefault(column.name, index)
    return lambda values: Row(values, columns)


_pools = {}
_pool_lock = Lock()


def _after_fork():
    # Neither a socket nor a pool maintenance thread can be shared after fork.
    global _pools, _pool_lock
    _pools = {}
    _pool_lock = Lock()


if hasattr(os, 'register_at_fork'):
    os.register_at_fork(after_in_child=_after_fork)


def close_pool(dsn=None):
    """Close a retired DSN's pool, or every pool owned by this process."""
    with _pool_lock:
        if dsn is None:
            pools = list(_pools.values())
            _pools.clear()
        else:
            pool = _pools.pop(dsn, None)
            pools = [pool] if pool else []
    for pool in pools:
        pool.close()


atexit.register(close_pool)


def open_connection(dsn):
    if not isinstance(dsn, str) or not dsn.strip():
        raise ValueError('请配置 PostgreSQL 数据库连接')
    with _pool_lock:
        pool = _pools.get(dsn)
        if pool is None:
            pool = ConnectionPool(
                dsn,
                min_size=0,
                max_size=int(os.getenv('OMP_DB_POOL_SIZE', '16')),
                max_idle=60,
                timeout=30,
                kwargs={'autocommit': True, 'row_factory': _row_factory, 'connect_timeout': 8},
                open=True,
            )
            _pools[dsn] = pool
    return Connection(pool, pool.getconn())


_COLUMN = r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?'
_PATH = r"'\$\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)'"
_JSON_EXTRACT = re.compile(rf'\bjson_extract\(\s*({_COLUMN})\s*,\s*{_PATH}\s*\)', re.I)
_JSON_LENGTH = re.compile(rf'\bjson_array_length\(\s*({_COLUMN})\s*,\s*{_PATH}\s*\)', re.I)
_JSON_EACH = re.compile(
    rf'\bjson_each\(\s*({_COLUMN}|\?)(?:\s*,\s*{_PATH})?\s*\)'
    r'(?:\s+(?!(?:WHERE|JOIN|ON|ORDER|GROUP|LIMIT)\b)([A-Za-z_]\w*))?', re.I,
)
_PARAMETERS = re.compile(r"""'(?:''|[^'])*'|"(?:""|[^"])*"|\?|(?<!:):([a-zA-Z_]\w*)""")


def _json_value(match):
    column, path = match.groups()
    text = f"({column}::jsonb #>> '{{{path.replace('.', ',')}}}')"
    if path in ('expires_at', 'skipped_at'):
        return f'{text}::double precision'
    if path == 'frozen':
        return f'{text}::boolean::integer'
    return text


def _json_elements(match):
    column, path, alias = match.groups()
    array = f'{column}::jsonb'
    if path:
        array += f" #> '{{{path.replace('.', ',')}}}'"
    return f'jsonb_array_elements_text({array}) AS {alias or "element"}(value)'


@lru_cache(maxsize=2048)
def _sql(statement, bound):
    """Convert the application's existing JSON lookups and bound parameters."""
    statement = re.sub(r'\s+INDEXED BY \w+', '', statement, flags=re.I)
    statement = re.sub(r'=\+([a-zA-Z_])', r'=\1', statement)
    statement = re.sub(r'\bCROSS JOIN (objects \w+ ON)\b', r'JOIN \1', statement, flags=re.I)
    statement = re.sub(r'\bJOIN json_each\(', 'CROSS JOIN json_each(', statement, flags=re.I)
    statement = _JSON_EACH.sub(_json_elements, statement)
    statement = _JSON_EXTRACT.sub(_json_value, statement)
    statement = _JSON_LENGTH.sub(
        lambda m: f"jsonb_array_length({m[1]}::jsonb #> '{{{m[2].replace('.', ',')}}}')", statement,
    )
    if re.match(r'^\s*INSERT OR IGNORE\b', statement, re.I):
        statement = re.sub(r'INSERT OR IGNORE', 'INSERT', statement, count=1, flags=re.I)
        statement = statement.rstrip().rstrip(';') + ' ON CONFLICT DO NOTHING'
    statement = re.sub(r'\bIS NOT\s+\?', 'IS DISTINCT FROM ?', statement, flags=re.I)
    statement = re.sub(r'\?\s+IS NULL\b', '?::text IS NULL', statement, flags=re.I)
    statement = re.sub(r'\binstr\(', 'strpos(', statement, flags=re.I)
    statement = statement.replace('temp.deletion_', 'pg_temp.deletion_')
    if re.match(r'^\s*CREATE TEMP TABLE\b', statement, re.I):
        # The connection will return to its pool at the end of the operation.
        statement = statement.rstrip().rstrip(';') + ' ON COMMIT DROP'
    if 'json_set(' in statement:
        statement = statement.replace(
            "json_set(body,'$.deletion_plan_id',?,'$.deleted_at',?,'$.deletion_reason',?)",
            "(body::jsonb || jsonb_build_object('deletion_plan_id',?::text,"
            "'deleted_at',?::double precision,'deletion_reason',?::text))::text",
        )
    if bound:
        statement = statement.replace('%', '%%')
        def placeholder(match):
            if match[0] == '?':
                return '%s'
            if match[1]:
                return f'%({match[1]})s'
            return match[0]
        statement = _PARAMETERS.sub(placeholder, statement)
    return statement


class Connection:
    def __init__(self, pool, raw):
        self._pool = pool
        self._pid = os.getpid()
        self._raw = raw
        self._writes = False
        self._snapshot = False

    @property
    def raw(self):
        if self._pid != os.getpid() or self._raw is None:
            raise OperationalError('该进程的数据库连接已关闭，请重新连接')
        return self._raw

    @property
    def in_transaction(self):
        return self.raw.info.transaction_status != TransactionStatus.IDLE

    def _begin_write(self):
        if self._writes and self.in_transaction:
            return
        if self._snapshot:
            raise RuntimeError('请先结束当前读取快照，再重新进行写事务')
        # The lock is database- and schema-local, and follows the transaction
        # across worker processes. Under READ COMMITTED the *next* statement
        # sees the commit made by the previous lock holder.
        lock = 'SELECT pg_advisory_xact_lock(1330466817, hashtext(current_schema()::text))'
        if not self.in_transaction:
            self.raw.execute('BEGIN ISOLATION LEVEL READ COMMITTED; ' + lock, prepare=False)
        else:
            self.raw.execute(lock)
        self._writes = True

    def execute(self, statement, params=None):
        command = statement.strip().rstrip(';').upper()
        if command == 'BEGIN IMMEDIATE':
            self._begin_write()
            return self.raw.cursor()
        if command == 'BEGIN':
            cursor = self.raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
            self._snapshot = True
            return cursor
        if command.split(None, 1)[0] in ('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE'):
            # Hierarchy reports use private temporary tables to walk a stable
            # snapshot. They never modify a shared row in that transaction.
            local_scope = self._snapshot and re.match(
                r'^(?:CREATE TEMP TABLE|DROP TABLE IF EXISTS TEMP\.|INSERT(?: OR IGNORE)? INTO )'
                r'\s*DELETION_(?:SCOPE|QUESTIONS|JOBS)\b', command,
            )
            if not local_scope:
                self._begin_write()
        return self.raw.execute(_sql(statement, bool(params)), params or None)

    def executemany(self, statement, parameters):
        self._begin_write()
        cursor = self.raw.cursor()
        cursor.executemany(_sql(statement, True), parameters)
        return cursor

    def executescript(self, script):
        """Execute native PostgreSQL DDL in the caller's transaction."""
        self._begin_write()
        return self.raw.execute(script, prepare=False)

    def commit(self):
        self.raw.commit()
        self._writes = False
        self._snapshot = False

    def rollback(self):
        self.raw.rollback()
        self._writes = False
        self._snapshot = False

    def close(self):
        raw, self._raw = self._raw, None
        if raw is None or self._pid != os.getpid():
            return
        try:
            if not raw.closed and raw.info.transaction_status != TransactionStatus.IDLE:
                raw.rollback()
        finally:
            self._pool.putconn(raw)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
