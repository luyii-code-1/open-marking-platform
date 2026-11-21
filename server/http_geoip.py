"""Country lookups from a local, replaceable MaxMind database."""
from contextlib import contextmanager
from functools import lru_cache
import hashlib
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from urllib.request import Request, urlopen

import maxminddb


SOURCE = 'https://github.com/Loyalsoldier/geoip'
FILE = 'Country-without-asn.mmdb'
DOWNLOADS = (
    'https://raw.githubusercontent.com/Loyalsoldier/geoip/release/',
    'https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/',
)


class UpdateInProgress(Exception):
    pass


@contextmanager
def update_lock(path):
    # OS locks release automatically if a worker is restarted during a download.
    with path.open('a+b') as lock:
        lock.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise UpdateInProgress() from error
        yield


def download(base, destination):
    def fetch(suffix):
        return urlopen(Request(base + FILE + suffix, headers={'User-Agent': 'OpenMarkingPlatform/GeoIP'}), timeout=8)

    with fetch('.sha256sum') as response:
        checksum = response.read(513)
    match = re.fullmatch(rb'([0-9a-fA-F]{64})(?:\s+\*?Country-without-asn\.mmdb)?\s*', checksum)
    if not match:
        raise ValueError('GeoIP 校验文件格式无效')
    digest = hashlib.sha256()
    size = 0
    deadline = time.monotonic() + 35
    with fetch('') as response, destination.open('wb') as out:
        while chunk := response.read(131072):
            size += len(chunk)
            if size > 64 * 1024 * 1024 or time.monotonic() > deadline:
                raise ValueError('GeoIP 下载超过限制')
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != match.group(1).decode().lower():
        raise ValueError('GeoIP 文件校验失败')
    with maxminddb.open_database(destination) as reader:
        if not reader.metadata().node_count or not reader.get('1.1.1.1'):
            raise ValueError('GeoIP 文件缺少国家或地区数据')


class GeoIP:
    def __init__(self, root):
        self.path = Path(root) / 'http-guard' / 'country.mmdb'
        self._reader = None
        self._signature = None
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._cached_country = lru_cache(maxsize=4096)(self._lookup)

    def refresh(self):
        with self._refresh_lock:
            try:
                stat = self.path.stat()
            except FileNotFoundError:
                if self._reader is not None:
                    self._replace_reader(None, None)
                return
            signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
            if signature == self._signature:
                return
            mode = maxminddb.MODE_MEMORY if os.name == 'nt' else maxminddb.MODE_AUTO
            self._replace_reader(maxminddb.open_database(self.path, mode), signature)

    def _replace_reader(self, reader, signature):
        with self._lock:
            old = self._reader
            self._reader, self._signature = reader, signature
            self._cached_country.cache_clear()
        if old:
            old.close()

    def close(self):
        with self._refresh_lock:
            self._replace_reader(None, None)

    def _lookup(self, ip):
        try:
            record = self._reader.get(ip) or {}
            code = record.get('country', {}).get('iso_code', '')
            return code if isinstance(code, str) and re.fullmatch('[A-Z]{2}', code) else ''
        except (ValueError, maxminddb.InvalidDatabaseError):
            return ''

    def country(self, ip):
        with self._lock:
            return self._cached_country(ip) if self._reader and ip else ''

    def status(self):
        with self._lock:
            return {'ready': self._reader is not None,
                    'updated_at': self._signature[2] / 1e9 if self._signature else None, 'source': SOURCE}

    def update(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with update_lock(self.path.with_suffix('.lock')):
            with tempfile.NamedTemporaryFile(dir=self.path.parent, suffix='.download', delete=False) as temp:
                staged = Path(temp.name)
            try:
                for base in DOWNLOADS:
                    try:
                        download(base, staged)
                        break
                    except (ValueError, OSError, maxminddb.InvalidDatabaseError) as error:
                        last_error = error
                else:
                    raise ValueError('GeoIP 下载或校验失败，请稍后重试') from last_error
                os.replace(staged, self.path)
                self.refresh()
            finally:
                staged.unlink(missing_ok=True)
        return self.status()
