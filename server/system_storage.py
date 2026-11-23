"""System disk usage summary and log retention/cleanup/packaging endpoints."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import tempfile
import zipfile
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from . import db as database
from .db import connect, get, put
from .dependencies import system_admin

router = APIRouter(prefix='/api/v1/system')
RETENTION_SETTING_ID = 'system-log-retention'


def _dir_size(path: Path) -> tuple[int, int]:
    if not path.exists():
        return 0, 0
    total = 0
    count = 0
    for root, _, files in os.walk(path):
        for fname in files:
            fp = Path(root) / fname
            try:
                total += fp.stat().st_size
                count += 1
            except OSError:
                pass
    return total, count


def _get_retention_days(db) -> int:
    rec = get(db, RETENTION_SETTING_ID, 'system-settings')
    if rec and isinstance(rec.get('retention_days'), int):
        return rec['retention_days']
    return 30


@router.get('/storage-summary')
def storage_summary(current=Depends(system_admin)):
    root = database.ROOT
    root.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(root)
    categories = [
        ('pages', '扫描图片（pages）', root / 'pages'),
        ('archives', '考试归档（archives）', root / 'archives'),
        ('backups', '数据库备份（backups）', root / 'backups'),
        ('assets', '题卡底图与资源（assets）', root / 'assets'),
        ('logs', '文件日志（logs）', root / 'logs'),
    ]
    breakdown = []
    tracked_bytes = 0
    for key, label, path in categories:
        size, count = _dir_size(path)
        tracked_bytes += size
        breakdown.append({'key': key, 'label': label, 'bytes': size, 'files': count})

    with connect() as db:
        req_count = db.execute('SELECT COUNT(*) FROM request_log').fetchone()[0]
        req_oldest = db.execute('SELECT MIN(created) FROM request_log').fetchone()[0]
        audit_count = db.execute('SELECT COUNT(*) FROM audit').fetchone()[0]
        retention_days = _get_retention_days(db)

    return {
        'disk': {'total': disk.total, 'used': disk.used, 'free': disk.free},
        'data_root': str(root),
        'tracked_bytes': tracked_bytes,
        'breakdown': breakdown,
        'logs': {
            'request_log_count': req_count,
            'request_log_oldest': req_oldest,
            'audit_count': audit_count,
            'retention_days': retention_days,
        },
    }


@router.put('/log-retention')
def update_log_retention(body: dict, current=Depends(system_admin)):
    days = body.get('retention_days')
    if type(days) is not int or not 0 <= days <= 3650:
        raise HTTPException(422, '保留天数需为 0 至 3650 的整数（0 表示不限）')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        saved = put(db, 'system-settings', {'id': RETENTION_SETTING_ID, 'retention_days': days}, current['id'])
        return {'retention_days': saved['retention_days']}


@router.post('/logs/cleanup')
def cleanup_logs(body: dict | None = None, current=Depends(system_admin)):
    payload = body or {}
    days = payload.get('days')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if days is None:
            days = _get_retention_days(db)
        if type(days) is not int or not 0 <= days <= 3650:
            raise HTTPException(422, '清理天数参数无效')
        if days == 0:
            deleted_req = db.execute('DELETE FROM request_log').rowcount
        else:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec='milliseconds')
            deleted_req = db.execute('DELETE FROM request_log WHERE created < ?', (cutoff,)).rowcount

        deleted_files = 0
        freed_bytes = 0
        logs_dir = database.ROOT / 'logs'
        if logs_dir.is_dir():
            cutoff_ts = (datetime.now(timezone.utc) - timedelta(days=days)).timestamp() if days > 0 else float('inf')
            for fp in logs_dir.rglob('*'):
                if fp.is_file():
                    try:
                        st = fp.stat()
                        if days == 0 or st.st_mtime < cutoff_ts:
                            freed_bytes += st.st_size
                            fp.unlink(missing_ok=True)
                            deleted_files += 1
                    except OSError:
                        pass
        put(db, 'system-settings', {'id': RETENTION_SETTING_ID, 'retention_days': _get_retention_days(db), 'last_cleanup_at': datetime.now(timezone.utc).isoformat()}, current['id'])
        return {'deleted_request_logs': max(0, deleted_req or 0), 'deleted_files': deleted_files, 'freed_bytes': freed_bytes, 'days': days}


@router.get('/logs/export')
def export_logs(days: int = Query(30, ge=0, le=3650), current=Depends(system_admin)):
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(prefix='omp-logs-', suffix='.zip', delete=False) as tmp:
            tmp_path = Path(tmp.name)
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec='milliseconds') if days > 0 else None
        with connect() as db:
            db.execute('BEGIN')
            if cutoff:
                req_rows = db.execute('SELECT * FROM request_log WHERE created >= ? ORDER BY seq DESC LIMIT 100000', (cutoff,)).fetchall()
            else:
                req_rows = db.execute('SELECT * FROM request_log ORDER BY seq DESC LIMIT 100000').fetchall()
            audit_rows = db.execute('SELECT * FROM audit ORDER BY rowid DESC LIMIT 50000').fetchall()

        with zipfile.ZipFile(tmp_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
            req_lines = '\n'.join(json.dumps(dict(r), ensure_ascii=False, default=str) for r in req_rows)
            audit_lines = '\n'.join(json.dumps(dict(r), ensure_ascii=False, default=str) for r in audit_rows)
            zf.writestr('request_log.jsonl', req_lines.encode('utf-8'))
            zf.writestr('audit.jsonl', audit_lines.encode('utf-8'))
            zf.writestr(
                'summary.json',
                json.dumps({
                    'exported_at': datetime.now(timezone.utc).isoformat(),
                    'days': days,
                    'request_log_rows': len(req_rows),
                    'audit_rows': len(audit_rows),
                }, ensure_ascii=False, indent=2).encode('utf-8'),
            )
            logs_dir = database.ROOT / 'logs'
            if logs_dir.is_dir():
                for fp in logs_dir.rglob('*'):
                    if fp.is_file():
                        try:
                            zf.write(fp, arcname='files/' + str(fp.relative_to(logs_dir)).replace('\\', '/'))
                        except OSError:
                            pass

        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        return FileResponse(
            tmp_path,
            media_type='application/zip',
            filename=f'omp-logs-{stamp}.zip',
            headers={'Cache-Control': 'no-store'},
            background=BackgroundTask(tmp_path.unlink, missing_ok=True),
        )
    except BaseException:
        if tmp_path:
            tmp_path.unlink(missing_ok=True)
        raise
