"""Install and migrate the native PostgreSQL schema idempotently."""
from pathlib import Path


VERSION = 'postgres-v1'
DROP_IDENTIFIERS_VERSION = 'drop-identifiers-v1'
SCHEMA = Path(__file__).with_suffix('.sql')


def installed(connection):
    table = connection.execute("""
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relname='schema_migrations' AND c.relkind='r'
    """).fetchone()
    if not table:
        return False
    return connection.execute('SELECT 1 FROM schema_migrations WHERE name=%s', (VERSION,)).fetchone() is not None


def _drop_identifiers(connection):
    if connection.execute('SELECT 1 FROM schema_migrations WHERE name=%s', (DROP_IDENTIFIERS_VERSION,)).fetchone():
        return
    connection.execute("""
        DROP TRIGGER IF EXISTS object_identifier_insert ON objects;
        DROP TRIGGER IF EXISTS user_identifier_insert ON users;
        DROP TRIGGER IF EXISTS object_identifier_retire ON objects;
        DROP TRIGGER IF EXISTS object_identifier_delete ON objects;
        DROP TRIGGER IF EXISTS user_identifier_delete ON users;
        DROP FUNCTION IF EXISTS omp_register_identifier();
        DROP FUNCTION IF EXISTS omp_retire_identifier();
        DROP TABLE IF EXISTS identifiers CASCADE;
        DELETE FROM schema_migrations WHERE name='identifiers-v1';
        INSERT INTO schema_migrations(name) VALUES ('drop-identifiers-v1') ON CONFLICT DO NOTHING;
    """, prepare=False)


def initialize(db):
    connection = db.raw
    if installed(connection):
        with connection.transaction():
            connection.execute("SELECT pg_advisory_xact_lock(hashtextextended('omp-schema:' || current_schema(), 0))")
            _drop_identifiers(connection)
        return
    with connection.transaction():
        connection.execute("SELECT pg_advisory_xact_lock(hashtextextended('omp-schema:' || current_schema(), 0))")
        if installed(connection):
            _drop_identifiers(connection)
            return
        connection.execute(SCHEMA.read_text(encoding='utf-8'), prepare=False)
        connection.execute('INSERT INTO schema_migrations(name) VALUES (%s) ON CONFLICT DO NOTHING', (VERSION,))
