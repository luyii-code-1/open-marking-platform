from contextlib import closing
import json
import sqlite3
from uuid import uuid4

import psycopg
import pytest

from server.database_transfer import export_file, import_database
from server.backups import inspect
from server.postgres import open_connection
from server.postgres_schema import initialize


def test_legacy_migration_preserves_data_cursors_scan_lock_and_rollback(tmp_path, pg_database_url):
    source = tmp_path / 'legacy.sqlite3'
    student, group, score, user = [str(uuid4()) for _ in range(4)]
    with closing(sqlite3.connect(source)) as db, db:
        db.executescript("""
            CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,name TEXT,role TEXT,password TEXT);
            CREATE TABLE objects(id TEXT PRIMARY KEY,kind TEXT,body TEXT,deleted INTEGER);
            CREATE TABLE scores(id TEXT PRIMARY KEY,task_id TEXT,user_id TEXT,score INTEGER,idempotency_key TEXT);
            CREATE TABLE audit(id TEXT PRIMARY KEY,actor TEXT,action TEXT,object_id TEXT,body TEXT,created TEXT);
            CREATE TABLE request_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT,actor TEXT,method TEXT,route TEXT,
                object_id TEXT,status INTEGER,duration_ms REAL,peer TEXT,created TEXT);
        """)
        db.execute("INSERT INTO users VALUES(?, 'test', '教师', 'teacher', 'opaque')", (user,))
        body = json.dumps({'id': student, 'group_id': group}, ensure_ascii=False)
        db.execute("INSERT INTO objects(rowid,id,kind,body,deleted) VALUES(18,?,'submissions',?,1)", (student, body))
        db.execute("INSERT INTO audit(rowid,id,actor,action,object_id,body,created) VALUES(45,?,?,'update',?,?,NULL)",
                   (str(uuid4()), user, student, body))
        db.execute("INSERT INTO scores VALUES(?,?,?,?,?)", (score, str(uuid4()), user, 850, 'replayed'))
        db.execute("INSERT INTO request_log(seq,id) VALUES(89,?)", (str(uuid4()),))
        db.execute("DELETE FROM request_log")
    dsn = pg_database_url()
    with closing(open_connection(dsn)) as target:
        initialize(target)
    with pytest.raises(RuntimeError, match='deliberate rollback'):
        with import_database(source, dsn) as (db, _):
            assert db.execute("SELECT 1 FROM schema_migrations WHERE name='sqlite-import-v1'").fetchone()
            raise RuntimeError('deliberate rollback')
    with psycopg.connect(dsn) as target:
        assert target.execute("SELECT 1 FROM schema_migrations WHERE name='sqlite-import-v1'").fetchone() is None
    with import_database(source, dsn) as (db, totals):
        assert totals['scores'] == 1 and totals['objects'] == 1
        assert db.execute('SELECT score FROM scores WHERE id=?', (score,)).fetchone()[0] == 850
        assert db.execute('SELECT rowid FROM audit').fetchone()[0] == 45
        assert db.execute('SELECT rowid FROM objects').fetchone()[0] == 18
        assert db.execute('SELECT retired FROM identifiers WHERE id=?', (student,)).fetchone()[0] == 1
        assert db.execute('SELECT group_id FROM scanned_groups').fetchone()[0] == group
        assert db.raw.execute("SELECT nextval(pg_get_serial_sequence('request_log','seq'))").fetchone()[0] == 90
    with pytest.raises(ValueError, match='空库'):
        with import_database(source, dsn):
            pass
    snapshot = tmp_path / 'converted.ompdb'
    export_file(snapshot, dsn)
    assert inspect(snapshot)['scores'] == 1
    fresh = pg_database_url()
    with import_database(snapshot, fresh) as (db, totals):
        assert totals['scores'] == 1
        assert db.execute("SELECT 1 FROM schema_migrations WHERE name='sqlite-import-v1'").fetchone()
        assert db.raw.execute("SELECT nextval(pg_get_serial_sequence('request_log','seq'))").fetchone()[0] == 91
        assert db.raw.execute("SELECT nextval(pg_get_serial_sequence('audit','rowid'))").fetchone()[0] == 46
    with psycopg.connect(dsn) as original:
        assert original.execute('SELECT COUNT(*) FROM scores').fetchone()[0] == 1
