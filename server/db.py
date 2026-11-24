import json
import os
import re
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from . import postgres, postgres_schema
from .postgres import Connection

ROOT = Path(os.getenv('OMP_DATA', Path(__file__).resolve().parents[1] / 'data'))


def database_url():
    url = os.getenv('OMP_DATABASE_URL')
    if not url:
        raise RuntimeError('请设置 OMP_DATABASE_URL 连接 PostgreSQL')
    return url


def open_connection(root=None):
    return postgres.open_connection(database_url())


@contextmanager
def connect(root=None):
    db = open_connection(root)
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize(root=None):
    directory = Path(root) if root is not None else ROOT
    directory.mkdir(parents=True, exist_ok=True)
    with connect(root) as db:
        postgres_schema.initialize(db)
        if (directory / 'omp.sqlite3').is_file():
            migrated = db.execute("SELECT 1 FROM schema_migrations WHERE name='sqlite-import-v1'").fetchone()
            if not migrated:
                raise RuntimeError('数据目录包含旧库。请先用 server.database_transfer 将该库迁入目标 PostgreSQL 数据库。')


def objects(db, kind):
    return [json.loads(row['body']) for row in db.execute('SELECT body FROM objects WHERE kind=? AND deleted=0 ORDER BY rowid',(kind,))]


def find(db,kind,**filters):
    clauses=['kind=?','deleted=0'];parameters=[kind]
    for key,value in filters.items():
        if not re.fullmatch('[a-z_]+',key):raise ValueError('查询字段无效')
        clauses.append("json_extract(body,'$."+key+"')=?");parameters.append(value)
    return [json.loads(row['body']) for row in db.execute('SELECT body FROM objects WHERE '+' AND '.join(clauses)+' ORDER BY rowid',parameters)]


def get(db, identifier, kind=None):
    # Grouped review operations share a write transaction. Cache only the
    # reference rows those operations cannot change, keeping mutable return
    # values independent for each caller.
    cache = getattr(db, 'review_reference_rows', None)
    if cache is not None and kind in ('grades', 'room-tags', 'groups'):
        key = (identifier, kind)
        if key not in cache:
            row = db.execute('SELECT body FROM objects WHERE id=? AND kind=? AND deleted=0',key).fetchone()
            cache[key] = row[0] if row else None
        return json.loads(cache[key]) if cache[key] is not None else None
    row = db.execute('SELECT kind,body FROM objects WHERE id=? AND deleted=0',(identifier,)).fetchone()
    return json.loads(row['body']) if row and (kind is None or row['kind']==kind) else None


def put(db, kind, body, actor=None):
    if not db.in_transaction: db.execute('BEGIN IMMEDIATE')
    body = dict(body)
    if 'id' not in body:body['id']=str(uuid4())
    old = db.execute('SELECT kind,deleted,body FROM objects WHERE id=?',(body['id'],)).fetchone()
    if old and (old['kind'] != kind or old['deleted']):
        from .identifiers import IdentifierConflict
        raise IdentifierConflict('编号已被使用，不能复用')
    from .lifecycle import writable
    if old: writable(db, kind, json.loads(old['body']))
    writable(db, kind, body)
    from .identifiers import canonical,template_questions
    canonical(body['id'])
    if kind=='templates':template_questions(db,body,json.loads(old['body']) if old else None)
    encoded=json.dumps(body,ensure_ascii=False)
    if old:
        db.execute('UPDATE objects SET body=? WHERE id=?',(encoded,body['id']))
    else:
        db.execute('INSERT INTO objects(id,kind,body) VALUES(?,?,?)',(body['id'],kind,encoded))
    db.execute('INSERT INTO audit(id,actor,action,object_id,body) VALUES(?,?,?,?,?)',(str(uuid4()),actor,'update' if old else 'create',body['id'],encoded))
    return body
