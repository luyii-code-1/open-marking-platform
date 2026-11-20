"""Consistent PostgreSQL snapshots and the legacy backup file inventory."""
import hashlib
import os
import sqlite3
import zipfile
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4, uuid5, NAMESPACE_URL
from fastapi import HTTPException
from . import db as database
from .db import connect, get, objects, put


POLICY_ID = str(uuid5(NAMESPACE_URL, 'omp:database-backup-policy'))
BEIJING = timezone(timedelta(hours=8))


def policy(db):
    return get(db, POLICY_ID, 'backup-policy') or {'id': POLICY_ID, 'enabled': False, 'next_run': None}


def next_run(now):
    local = datetime.fromtimestamp(now, BEIJING)
    due = local.replace(hour=3, minute=0, second=0, microsecond=0)
    if due <= local:
        due += timedelta(days=1)
    return due.timestamp()


def set_enabled(enabled, actor):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        current = policy(db)
        if current['enabled'] == enabled:
            return current
        current.update(enabled=enabled, generation=str(uuid4()), next_run=next_run(time.time()) if enabled else None)
        return put(db, 'backup-policy', current, actor)


def enqueue_due(db):
    now = time.time()
    current = policy(db)
    if not current['enabled'] or current['next_run'] > now:
        return
    db.execute('BEGIN IMMEDIATE')
    current = policy(db)
    if current['enabled'] and current['next_run'] <= now:
        from .jobs import create_job
        create_job(db, 'scheduled-backup', {'generation': current['generation'], 'backup_id': str(uuid4())})
        current['next_run'] = next_run(now)
        put(db, 'backup-policy', current)


def checksum(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def inspect(path):
    path=Path(path).resolve(strict=True)
    from .database_transfer import check_sqlite, manifest, CORE
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            data = manifest(archive)
            for table, meta in data['tables'].items():
                with archive.open(table + '.copy') as file:
                    if hashlib.file_digest(file, 'sha256').hexdigest() != meta['sha256']:
                        raise ValueError('备份表数据校验失败 ' + table)
            return {table: data['tables'][table]['rows'] for table in CORE}
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as source:
        check_sqlite(source)
        return {table: source.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] for table in CORE}


def create(actor, scheduled=None, ownership=None):
    directory=database.ROOT/'backups';directory.mkdir(parents=True,exist_ok=True)
    identifier = scheduled['backup_id'] if scheduled else str(uuid4())
    target = directory / (identifier + '.ompdb')
    if scheduled:
        with connect() as db:
            current = policy(db)
            if not current['enabled'] or current['generation'] != scheduled['generation'] or get(db, identifier, 'database-backups'):
                return
    with TemporaryDirectory(dir=directory, prefix='.snapshot-') as staging:
        from .database_transfer import export_file
        temporary = Path(staging) / 'snapshot.ompdb'
        counts = export_file(temporary, os.environ['OMP_DATABASE_URL'])
        digest = checksum(temporary)
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if scheduled:
                from .jobs import guard
                guard(db, ownership)
                current = policy(db)
                if not current['enabled'] or current['generation'] != scheduled['generation'] or get(db, identifier, 'database-backups'):
                    return
            temporary.replace(target)
            return put(db,'database-backups',{'id':identifier,'status':'created','format':'omp-postgresql-copy-v1','filename':target.name,'origin':'automatic' if scheduled else 'manual','created_at':time.time(),'size':target.stat().st_size,'sha256':digest,'counts':counts,'download_url':f'/api/v1/system/backups/{identifier}/download'},actor)


def backup_filename(record):
    return record['id'] + ('.ompdb' if record.get('format') == 'omp-postgresql-copy-v1' else '.sqlite3')


def inventory(db):
    directory = database.ROOT / 'backups'
    records = objects(db, 'database-backups')
    registered = {backup_filename(record) for record in records}
    result = []
    for record in records:
        if record.get('status') == 'deleted':
            continue
        path = directory / backup_filename(record)
        result.append({**record, 'origin': record.get('origin', 'registered'), 'filename': path.name,
                       'available': not path.is_symlink() and path.is_file()})
    for path in directory.glob('*'):
        if path.suffix not in ('.sqlite3', '.ompdb') or path.name in registered or path.is_symlink() or not path.is_file():
            continue
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        identifier = 'file-' + hashlib.sha256(path.name.encode()).hexdigest()
        result.append({'id': identifier, 'filename': path.name, 'created_at': stat.st_mtime,
                       'size': stat.st_size, 'available': True,
                       'origin': 'deployment' if path.name.startswith('pre-') else 'external',
                       'download_url': f'/api/v1/system/backups/{identifier}/download'})
    return sorted(result, key=lambda row: row['created_at'], reverse=True)


def locate(db, identifier):
    record = next((row for row in inventory(db) if row['id'] == identifier), None)
    if record is None:
        raise HTTPException(404, '备份不存在')
    return record, database.ROOT / 'backups' / record['filename']


def open_download(identifier):
    with connect() as db:
        record, path = locate(db, identifier)
        if not record['available']:
            raise HTTPException(404, '备份文件不存在')
        try:
            stream = path.open('rb')
        except FileNotFoundError:
            raise HTTPException(404, '备份文件不存在')
    try:
        if record.get('sha256') and hashlib.file_digest(stream, 'sha256').hexdigest() != record['sha256']:
            raise HTTPException(409, '备份校验不一致')
        stream.seek(0)
        return stream, record['filename'], os.fstat(stream.fileno()).st_size
    except Exception:
        stream.close()
        raise


def delete(identifier, actor):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        record, path = locate(db, identifier)
        if not path.is_symlink():
            try:
                path.unlink(missing_ok=True)
            except PermissionError:
                raise HTTPException(409, '文件正在使用，请稍后再删除')
        if record['origin'] in ('external', 'deployment'):
            put(db, 'backup-deletions', {'filename': record['filename'], 'deleted_at': time.time()}, actor)
        else:
            stored = get(db, identifier, 'database-backups')
            stored.update(status='deleted', deleted_at=time.time())
            put(db, 'database-backups', stored, actor)
    return {'status': 'deleted'}
