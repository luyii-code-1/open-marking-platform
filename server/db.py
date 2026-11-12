import json
import os
import sqlite3
import re
import threading
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

ROOT = Path(os.getenv('OMP_DATA', Path(__file__).resolve().parents[1] / 'data'))
WRITE_LOCK=threading.RLock()


class Connection(sqlite3.Connection):
    writer_owned=False
    def execute(self,sql,*args,**kwargs):
        if sql.strip().upper().startswith('BEGIN IMMEDIATE') and not self.writer_owned:
            WRITE_LOCK.acquire();self.writer_owned=True
        return super().execute(sql,*args,**kwargs)
    def close(self):
        try:super().close()
        finally:
            if self.writer_owned:self.writer_owned=False;WRITE_LOCK.release()


@contextmanager
def connect(root=None):
    directory=Path(root) if root is not None else ROOT
    directory.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(directory / 'omp.sqlite3', timeout=5,factory=Connection)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=5000')
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize(root=None):
    with connect(root) as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS object_kind ON objects(kind,deleted);
        CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT,action TEXT NOT NULL,object_id TEXT,body TEXT NOT NULL,created TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor);
        CREATE INDEX IF NOT EXISTS audit_object ON audit(object_id);
        CREATE TABLE IF NOT EXISTS request_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,actor TEXT,method TEXT NOT NULL,route TEXT NOT NULL,object_id TEXT,status INTEGER NOT NULL,duration_ms REAL NOT NULL,peer TEXT,created TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS request_actor ON request_log(actor,seq);
        CREATE INDEX IF NOT EXISTS request_object ON request_log(object_id,seq);
        CREATE TABLE IF NOT EXISTS scores(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,user_id TEXT NOT NULL,score INTEGER NOT NULL,idempotency_key TEXT NOT NULL,UNIQUE(user_id,idempotency_key));
        CREATE TABLE IF NOT EXISTS review_results(submission_id TEXT NOT NULL,question_id TEXT NOT NULL,final_cents INTEGER,PRIMARY KEY(submission_id,question_id));
        CREATE TABLE IF NOT EXISTS review_allocations(template_id TEXT NOT NULL,question_id TEXT NOT NULL,submission_id TEXT NOT NULL,round INTEGER NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(submission_id,question_id,round));
        CREATE INDEX IF NOT EXISTS allocation_user ON review_allocations(user_id,question_id,template_id);
        CREATE TABLE IF NOT EXISTS allocation_state(question_id TEXT PRIMARY KEY,signature TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS regrade_queue(task_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,template_id TEXT NOT NULL,question_id TEXT NOT NULL,position INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS regrade_user ON regrade_queue(user_id,template_id,question_id,position);
        CREATE INDEX IF NOT EXISTS object_submission ON objects(kind,deleted,json_extract(body,'$.template_id'),json_extract(body,'$.status'));
        CREATE INDEX IF NOT EXISTS object_task_answer ON objects(kind,deleted,json_extract(body,'$.submission_id'),json_extract(body,'$.question_id'),json_extract(body,'$.status'));
        CREATE INDEX IF NOT EXISTS object_task_user ON objects(kind,deleted,json_extract(body,'$.user_id'),json_extract(body,'$.question_id'),json_extract(body,'$.status'));
        CREATE INDEX IF NOT EXISTS object_group ON objects(kind,deleted,json_extract(body,'$.group_id'));
        CREATE INDEX IF NOT EXISTS object_relative ON objects(kind,deleted,json_extract(body,'$.relative'));
        CREATE INDEX IF NOT EXISTS object_token_hash ON objects(kind,deleted,json_extract(body,'$.token_hash'));
        CREATE INDEX IF NOT EXISTS object_deleted_plan ON objects(json_extract(body,'$.deletion_plan_id')) WHERE deleted=1;
        ''')
        from .identifiers import initialize as initialize_identifiers
        initialize_identifiers(db)


def objects(db, kind):
    return [json.loads(row['body']) for row in db.execute('SELECT body FROM objects WHERE kind=? AND deleted=0',(kind,))]


def find(db,kind,**filters):
    clauses=['kind=?','deleted=0'];parameters=[kind]
    for key,value in filters.items():
        if not re.fullmatch('[a-z_]+',key):raise ValueError('查询字段无效')
        clauses.append("json_extract(body,'$."+key+"')=?");parameters.append(value)
    index='object_task_answer' if 'submission_id' in filters else 'object_task_user' if 'user_id' in filters else 'object_submission' if 'template_id' in filters else 'object_group' if 'group_id' in filters else 'object_kind'
    return [json.loads(row['body']) for row in db.execute('SELECT body FROM objects INDEXED BY '+index+' WHERE '+' AND '.join(clauses),parameters)]


def get(db, identifier, kind=None):
    row = db.execute('SELECT kind,body FROM objects WHERE id=? AND deleted=0',(identifier,)).fetchone()
    return json.loads(row['body']) if row and (kind is None or row['kind']==kind) else None


def put(db, kind, body, actor=None):
    body = dict(body)
    body.setdefault('id', str(uuid4()))
    old = db.execute('SELECT kind,deleted,body FROM objects WHERE id=?',(body['id'],)).fetchone()
    if old and (old['kind'] != kind or old['deleted']):
        from .identifiers import IdentifierConflict
        raise IdentifierConflict('编号已被使用，不能复用')
    from .identifiers import reserve,template_questions
    reserve(db,body['id'],kind,body['id'])
    if kind=='templates':template_questions(db,body,json.loads(old['body']) if old else None)
    db.execute('INSERT INTO objects(id,kind,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',(body['id'],kind,json.dumps(body,ensure_ascii=False)))
    db.execute('INSERT INTO audit(id,actor,action,object_id,body) VALUES(?,?,?,?,?)',(str(uuid4()),actor,'update' if old else 'create',body['id'],json.dumps(body,ensure_ascii=False)))
    return body
