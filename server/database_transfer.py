"""Transactionally transfer OMP data, including stable audit cursors and scan history."""
import argparse
from contextlib import closing, contextmanager
import hashlib
from itertools import zip_longest
import json
import os
from pathlib import Path
import sqlite3
import zipfile

import psycopg
from psycopg import sql
from psycopg.rows import tuple_row


TABLES = ('users', 'sessions', 'objects', 'audit', 'request_log', 'scores',
          'review_results', 'review_allocations', 'allocation_state', 'regrade_queue',
          'deletion_locks', 'deletion_files', 'scanned_groups', 'schema_migrations')
SEQUENCES = {'objects': 'rowid', 'audit': 'rowid', 'request_log': 'seq'}
CORE = ('users', 'objects', 'audit', 'scores')
FORMAT = 'omp-postgresql-copy-v1'


def columns(cur, table):
    cur.execute("""SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name=%s AND is_generated='NEVER'
        ORDER BY ordinal_position""", (table,))
    return [row[0] for row in cur]


def manifest(archive):
    try:
        data = json.loads(archive.read('manifest.json'))
        if data['format'] != FORMAT or set(data['tables']) - {'identifiers'} != set(TABLES):
            raise ValueError('不支持的 OMP 备份版本')
        extra = {'identifiers.copy'} if 'identifiers' in data['tables'] else set()
        names = [table + '.copy' for table in TABLES] + list(extra) + ['manifest.json']
        if sorted(archive.namelist()) != sorted(names):
            raise ValueError('备份文件清单不一致')
        return data
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError('备份缺少有效 OMP 清单') from exc


def count(cur, table):
    cur.execute(sql.SQL('SELECT COUNT(*) FROM {}').format(sql.Identifier(table)))
    return cur.fetchone()[0]


def check_pg_tables(cur):
    cur.execute("""SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_type='BASE TABLE'""")
    if {row[0] for row in cur} != set(TABLES):
        raise ValueError('PostgreSQL 表清单与当前 OMP 备份版本不符')


def counts(cur):
    return {table: count(cur, table) for table in CORE}


def seq_details(cur, table, col):
    cur.execute("""SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid=pg_get_serial_sequence(format('%%I.%%I',current_schema(),%s::text),%s)::regclass""", (table,col))
    row = cur.fetchone()
    if row is None:
        raise ValueError('缺少数据库序列 ' + table)
    return sql.Identifier(*row)


def export_file(path, dsn):
    data = {'format': FORMAT, 'tables': {}, 'sequences': {}}
    with psycopg.connect(dsn) as conn, conn.cursor(row_factory=tuple_row) as cur:
        cur.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        check_pg_tables(cur)
        with zipfile.ZipFile(path, 'x', zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            for table in TABLES:
                fields = columns(cur, table)
                selected = sql.SQL(',').join(map(sql.Identifier, fields))
                command = sql.SQL("COPY (SELECT {} FROM {}) TO STDOUT WITH (ENCODING 'UTF8')").format(selected, sql.Identifier(table))
                digest = hashlib.sha256()
                with archive.open(table + '.copy', 'w', force_zip64=True) as file, cur.copy(command) as stream:
                    for chunk in stream:
                        file.write(chunk)
                        digest.update(chunk)
                data['tables'][table] = {'columns': fields, 'rows': count(cur, table), 'sha256': digest.hexdigest()}
                if table in SEQUENCES:
                    sequence = seq_details(cur, table, SEQUENCES[table])
                    cur.execute(sql.SQL('SELECT last_value,is_called FROM {}').format(sequence))
                    last, called = cur.fetchone()
                    data['sequences'][table] = last + int(called)
            archive.writestr('manifest.json', json.dumps(data))
    return {table: data['tables'][table]['rows'] for table in CORE}


def import_archive(cur, path):
    with zipfile.ZipFile(path) as archive:
        data = manifest(archive)
        for table in TABLES:
            meta = data['tables'][table]
            if set(meta['columns']) != set(columns(cur, table)) or len(set(meta['columns'])) != len(meta['columns']):
                raise ValueError('备份字段与目标不匹配 ' + table)
            fields = sql.SQL(',').join(map(sql.Identifier, meta['columns']))
            cmd = sql.SQL("COPY {} ({}) FROM STDIN WITH (ENCODING 'UTF8')").format(sql.Identifier(table), fields)
            digest = hashlib.sha256()
            with archive.open(table + '.copy') as file, cur.copy(cmd) as dest:
                while chunk := file.read(1024 * 1024):
                    dest.write(chunk)
                    digest.update(chunk)
            if digest.hexdigest() != meta['sha256'] or count(cur, table) != meta['rows']:
                raise ValueError('备份表数据校验失败 ' + table)
        return data['sequences']


def check_sqlite(source):
    tables = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'")}
    if not set(CORE) <= tables or (tables - {'identifiers'}) - set(TABLES):
        raise ValueError('文件不是受支持的 OMP SQLite 数据库')
    if source.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or source.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('SQLite 数据完整性检查失败')
    if source.execute("SELECT 1 FROM objects WHERE NOT json_valid(body) OR json_type(body,'$.id') IS NOT 'text' OR json_extract(body,'$.id')!=id LIMIT 1").fetchone():
        raise ValueError('备份对象内容无效')
    return tables


def import_sqlite(cur, db, path):
    seqs = {}
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as source:
        source.execute('BEGIN')
        tables = check_sqlite(source)
        for table in TABLES:
            if table not in tables:
                continue
            info = source.execute(f'PRAGMA table_info("{table}")').fetchall()
            fields = [row[1] for row in info]
            if table in ('objects', 'audit'):
                fields.insert(0, 'rowid')
            if set(fields) != set(columns(cur, table)):
                raise ValueError('旧数据库字段与目标不匹配 ' + table)
            cols = ','.join('"' + col.replace('"', '""') + '"' for col in fields)
            with cur.copy(sql.SQL('COPY {} ({}) FROM STDIN').format(sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier, fields)))) as stream:
                for row in source.execute(f'SELECT {cols} FROM "{table}"'):
                    stream.write_row(row)
            keys = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
            if table in SEQUENCES:
                keys = [SEQUENCES[table]]
            if not keys:
                raise ValueError('旧数据库缺少主键 ' + table)
            # Compare every value in PK order with bounded client memory. IDs, composite
            # keys and UTF-8 text sort identically under SQLite BINARY and PostgreSQL C.
            text_keys = {row[1] for row in info if 'TEXT' in row[2].upper()}
            source_order = ','.join(f'"{k}"' + (' COLLATE BINARY' if k in text_keys else '') for k in keys)
            target_order = sql.SQL(',').join(
                sql.Identifier(k) + (sql.SQL(' COLLATE "C"') if k in text_keys else sql.SQL('')) for k in keys)
            originals = source.execute(f'SELECT {cols} FROM "{table}" ORDER BY {source_order}')
            with cur.connection.cursor(name='omp_verify_rows', row_factory=tuple_row) as imported:
                imported.execute(sql.SQL('SELECT {} FROM {} ORDER BY {}').format(
                    sql.SQL(',').join(map(sql.Identifier, fields)), sql.Identifier(table), target_order))
                if any(left != right for left, right in zip_longest(originals, imported)):
                    raise ValueError('迁移记录内容或数量不匹配 ' + table)
        if 'request_log' in tables and source.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone():
            row = source.execute("SELECT seq FROM sqlite_sequence WHERE name='request_log'").fetchone()
            if row:
                seqs['request_log'] = row[0] + 1
        cur.execute("""INSERT INTO scanned_groups(group_id)
            SELECT body::jsonb->>'group_id' FROM objects WHERE kind='submissions'
            UNION SELECT b.body::jsonb->>'group_id' FROM objects p JOIN objects b
            ON b.id=p.body::jsonb->>'batch_id' AND b.kind='scan-batches' WHERE p.kind='pages'
            ON CONFLICT DO NOTHING""")
    return seqs


@contextmanager
def import_database(path, dsn):
    """Yield a populated but uncommitted database so file recovery can share its rollback."""
    from .postgres import open_connection
    from .postgres_schema import initialize
    path = Path(path).resolve(strict=True)
    if not dsn:
        raise ValueError('请指定独立的空 PostgreSQL 目标库')
    with closing(open_connection(dsn)) as db, db.raw.transaction(), db.raw.cursor(row_factory=tuple_row) as cur:
        initialize(db)
        check_pg_tables(cur)
        cur.execute(sql.SQL('LOCK TABLE {} IN ACCESS EXCLUSIVE MODE').format(sql.SQL(',').join(map(sql.Identifier, TABLES))))
        if any(count(cur, table) for table in TABLES if table != 'schema_migrations'):
            raise ValueError('目标 PostgreSQL 数据库已有业务数据，导入需要空库')
        cur.execute('SELECT name FROM schema_migrations')
        schema_seeds = {r[0] for r in cur}
        if schema_seeds - {'postgres-v1', 'identifiers-v1', 'drop-identifiers-v1'}:
            raise ValueError('目标 PostgreSQL 迁移记录与空库不一致')
        cur.execute('DELETE FROM schema_migrations')
        for table in ('objects', 'users'):
            cur.execute(sql.SQL('ALTER TABLE {} DISABLE TRIGGER USER').format(sql.Identifier(table)))
        with path.open('rb') as file:
            legacy = file.read(16) == b'SQLite format 3\x00'
        if not legacy and not zipfile.is_zipfile(path):
            raise ValueError('文件不是受支持的 OMP 数据库备份')
        seqs = import_sqlite(cur, db, path) if legacy else import_archive(cur, path)
        if legacy:
            schema_seeds.add('sqlite-import-v1')
        for seed in schema_seeds:
            cur.execute('INSERT INTO schema_migrations(name) VALUES(%s) ON CONFLICT DO NOTHING', (seed,))
        for table in ('objects', 'users'):
            cur.execute(sql.SQL('ALTER TABLE {} ENABLE TRIGGER USER').format(sql.Identifier(table)))
        for table, col in SEQUENCES.items():
            cur.execute(sql.SQL('SELECT COALESCE(MAX({}),0) FROM {}').format(sql.Identifier(col), sql.Identifier(table)))
            start = max(int(seqs.get(table, 1)), cur.fetchone()[0] + 1, 1)
            cur.execute(sql.SQL('ALTER SEQUENCE {} RESTART WITH {}').format(seq_details(cur, table, col), sql.Literal(start)))
        yield db, counts(cur)


def main():
    from .postgres import close_pool
    parser = argparse.ArgumentParser(description='将停写的 OMP SQLite 数据库或备份导入独立空 PostgreSQL 库')
    parser.add_argument('source', type=Path)
    parser.add_argument('--check-only', action='store_true', help='完成导入和校验后回滚，保留空目标')
    args = parser.parse_args()
    class Checked(Exception):
        pass
    try:
        with import_database(args.source, os.environ.get('OMP_DATABASE_URL')) as (_, result):
            if args.check_only:
                raise Checked
    except Checked:
        pass
    except (OSError, ValueError, sqlite3.Error, zipfile.BadZipFile, psycopg.Error) as error:
        parser.exit(1, str(error) + '\n')
    finally:
        close_pool()
    print(json.dumps({'mode': 'checked' if args.check_only else 'imported', 'counts': result}))


if __name__ == '__main__':
    main()
