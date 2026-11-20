"""Isolated PostgreSQL and filesystem state for local benchmarks and smoke tests."""
from contextlib import contextmanager
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from server import db, postgres


@contextmanager
def rehearsal(prefix, data_subdir='data'):
    base = os.getenv('OMP_TEST_DATABASE_URL')
    if not base:
        raise RuntimeError('请为演练显式设置 OMP_TEST_DATABASE_URL，指向允许创建临时 schema 的测试数据库')
    schema = 'omp_run_' + uuid4().hex
    dsn = make_conninfo(base, options='-csearch_path=' + schema)
    name = sql.Identifier(schema)
    with TemporaryDirectory(prefix=prefix) as directory, psycopg.connect(base, autocommit=True) as admin:
        root = Path(directory)
        data = root / data_subdir
        admin.execute(sql.SQL('CREATE SCHEMA {}').format(name))
        try:
            settings = {'OMP_DATABASE_URL': dsn, 'OMP_DATA': str(data),
                        'OMP_STORAGE': 'local', 'OMP_TASK_MODE': 'inline'}
            with patch.dict(os.environ, settings), patch.object(db, 'ROOT', data):
                os.environ.pop('OMP_REDIS_URL', None)
                yield root
        finally:
            postgres.close_pool(dsn)
            admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(name))
