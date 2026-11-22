"""Deployment database snapshots. Run inside the Linux API container via stdin."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


def release_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('发布编号必须是完整的 40 位 Git 提交 SHA')
    return value


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, data):
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as file:
        temp = Path(file.name)
        try:
            json.dump(data, file)
            file.flush()
            os.fsync(file.fileno())
            os.replace(temp, path)
            sync_directory(path.parent)
        finally:
            temp.unlink(missing_ok=True)


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def identity(stat):
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def verify(path, digest):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'发布备份缺失或校验失败：{path.name}')
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
            raise ValueError(f'发布备份校验失败：{path.name}')
        return identity(os.fstat(stream.fileno()))


@contextmanager
def rotation_transaction():
    # The management API deletes backup files under this same database lock.
    # Large reads and exports finish before we enter the critical section.
    from server.db import connect

    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        yield db


def export(path):
    from server.backups import inspect
    from server.database_transfer import export_file

    counts = export_file(path, os.environ['OMP_DATABASE_URL'])
    if inspect(path) != counts:
        raise ValueError('发布备份记录数校验失败')


def deployment_backup(root, action, release):
    release_id(release)
    backups = root / 'backups'
    directory = backups / '.deployments'
    if directory.is_symlink() or directory.parent.is_symlink():
        raise ValueError('发布备份路径是符号链接')
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    state_path = directory / 'state.json'
    snapshot = backups / f'pre-deploy-{release}.ompdb'
    # All API versions mount the same OMP_DATA volume. A process exit releases
    # the lock even if it happens during export or cleanup.
    with (directory / '.lock').open('a+b') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        staged = directory / 'snapshot.tmp'
        staged.unlink(missing_ok=True)
        if state_path.is_symlink() or snapshot.is_symlink():
            raise ValueError('发布备份状态或恢复点是符号链接')
        state = json.loads(state_path.read_text()) if state_path.exists() else {'current': None, 'records': {}, 'retire': []}
        current = state['current']
        if current is not None:
            release_id(current)
        records = state['records']
        info = records.get(release)
        if info is not None and current != release and info['previous'] != current:
            raise ValueError('该恢复点准备时的线上版本已经被替代，请核对发布顺序')
        if action == 'prepare':
            if snapshot.exists():
                if info is None:
                    raise ValueError('同名文件不属于部署备份工具')
                verify(snapshot, info['sha256'])
                return {'backup': str(snapshot), 'result': 'reused'}
            try:
                export(staged)
                staged.chmod(0o600)
                with staged.open('rb') as file:
                    os.fsync(file.fileno())
                records[release] = {'previous': info['previous'] if info else current, 'sha256': checksum(staged)}
                # Register the verified bytes first. If publication is interrupted,
                # the next prepare can replace a missing file. link never overwrites.
                write_json(state_path, state)
                os.link(staged, snapshot)
                sync_directory(backups)
            finally:
                staged.unlink(missing_ok=True)
            return {'backup': str(snapshot), 'result': 'rebuilt' if info else 'created'}
        if action != 'complete':
            raise ValueError('不支持的备份操作')
        if info is None:
            raise ValueError('该版本尚无已验证的部署备份')
        live_identity = verify(snapshot, info['sha256'])

        # A completed deployment keeps exactly its verified database recovery point.
        # Preview every candidate, reject links, and fence paths to this backup root.
        obsolete = {}
        for path in backups.rglob('*'):
            if directory in path.parents or path == snapshot or path.is_dir():
                continue
            if path.is_symlink() or not path.resolve().is_relative_to(backups.resolve()):
                raise ValueError('备份清理路径超出备份目录')
            if path.suffix.lower() in ('.ompdb','.sqlite3','.sqlite','.db','.dump','.sql','.bak','.zip','.gz'):
                obsolete[path] = identity(path.stat(follow_symlinks=False))
        if os.environ.get('OMP_DATABASE_URL','').startswith(('postgresql:','postgres:')):
            for name in ('omp.sqlite3','omp.sqlite3-wal','omp.sqlite3-shm'):
                path=root/name
                if path.is_symlink():raise ValueError('旧数据库路径是符号链接')
                if path.is_file() and path.resolve().parent==root.resolve():obsolete[path]=identity(path.stat(follow_symlinks=False))
        with rotation_transaction() as db:
            if identity(snapshot.stat(follow_symlinks=False)) != live_identity:
                raise ValueError('当前发布恢复点已变化，请重新校验')
            removed = []
            for path, old_identity in obsolete.items():
                if identity(path.stat(follow_symlinks=False)) != old_identity:
                    raise ValueError(f'备份文件已变化：{path.name}')
                removed.append(path)
            state.update(current=release, records={release: info}, retire=[])
            write_json(state_path, state)
            for path in removed:
                path.unlink()
            from server.db import objects,put
            removed_names={path.name for path in removed}
            for record in objects(db,'database-backups'):
                if record.get('filename') in removed_names:
                    record['status']='deleted';put(db,'database-backups',record)
            sync_directory(backups)
        return {'backup': str(snapshot), 'removed': [path.name for path in removed]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'complete'))
    parser.add_argument('release')
    args = parser.parse_args()
    try:
        result = deployment_backup(Path(os.environ['OMP_DATA']), args.action, args.release)
    except (KeyError, OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')
    print(json.dumps(result, ensure_ascii=False))
