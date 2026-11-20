"""Install the native PostgreSQL schema once, including during parallel startup."""
from pathlib import Path


VERSION = 'postgres-v1'
SCHEMA = Path(__file__).with_suffix('.sql')


def installed(connection):
    table = connection.execute("""
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relname='schema_migrations' AND c.relkind='r'
    """).fetchone()
    if not table:
        return False
    return connection.execute('SELECT 1 FROM schema_migrations WHERE name=%s', (VERSION,)).fetchone() is not None


def initialize(db):
    connection = db.raw
    if installed(connection):
        return
    with connection.transaction():
        connection.execute("SELECT pg_advisory_xact_lock(hashtextextended('omp-schema:' || current_schema(), 0))")
        if installed(connection):
            return
        connection.execute(SCHEMA.read_text(encoding='utf-8'), prepare=False)
        connection.execute('INSERT INTO schema_migrations(name) VALUES (%s)', (VERSION,))
