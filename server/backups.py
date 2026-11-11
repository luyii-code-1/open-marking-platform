"""Consistent SQLite snapshots with registered download metadata."""
import hashlib
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from uuid import uuid4
from . import db as database
from .db import connect,put


def checksum(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def inspect(path):
    path=Path(path).resolve(strict=True)
    if not path.is_file():raise ValueError('备份应为SQLite文件')
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:raise ValueError('SQLite完整性检查未通过')
        if db.execute('PRAGMA foreign_key_check').fetchone():raise ValueError('SQLite外键检查未通过')
        tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'users','objects','audit','scores'}<=tables:raise ValueError('文件不是受支持的OMP数据库备份')
        if db.execute("SELECT 1 FROM objects WHERE NOT json_valid(body) OR json_type(body,'$.id') IS NOT 'text' OR json_extract(body,'$.id')!=id LIMIT 1").fetchone():raise ValueError('备份对象内容无效')
        return {'users':db.execute('SELECT COUNT(*) FROM users').fetchone()[0],
                'objects':db.execute('SELECT COUNT(*) FROM objects').fetchone()[0],
                'scores':db.execute('SELECT COUNT(*) FROM scores').fetchone()[0],
                'audit':db.execute('SELECT COUNT(*) FROM audit').fetchone()[0]}


def create(actor):
    directory=database.ROOT/'backups';directory.mkdir(parents=True,exist_ok=True)
    identifier=str(uuid4());target=directory/(identifier+'.sqlite3');temporary=target.with_suffix('.tmp')
    try:
        with connect() as source:
            with closing(sqlite3.connect(temporary)) as destination:source.backup(destination)
        counts=inspect(temporary);digest=checksum(temporary);temporary.replace(target)
        with connect() as db:
            return put(db,'database-backups',{'id':identifier,'status':'created','created_at':time.time(),'size':target.stat().st_size,'sha256':digest,'counts':counts,'download_url':f'/api/v1/system/backups/{identifier}/download'},actor)
    finally:temporary.unlink(missing_ok=True)
