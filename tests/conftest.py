"""Give each database test its own PostgreSQL schema, including child processes."""
import os
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

from server import postgres


@pytest.fixture
def pg_database_url():
    base = os.getenv('OMP_TEST_DATABASE_URL')
    if not base:
        pytest.fail('Set OMP_TEST_DATABASE_URL to a separate PostgreSQL test database')
    schemas = []
    with psycopg.connect(base, autocommit=True) as admin:
        def create():
            name = 'omp_test_' + uuid4().hex
            dsn = make_conninfo(base, options='-csearch_path=' + name)
            admin.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(name)))
            schemas.append((name, dsn))
            return dsn

        try:
            yield create
        finally:
            for name, dsn in schemas:
                postgres.close_pool(dsn)
                admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(name)))


@pytest.fixture(autouse=True)
def database_environment(monkeypatch, pg_database_url):
    monkeypatch.setenv('OMP_DATABASE_URL', pg_database_url())
