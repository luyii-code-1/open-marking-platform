import sqlite3
from contextlib import closing
from uuid import uuid4

from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError

from server import db, progress_cache
from server.main import app
from test_allocation import setup, seed


class RedisStub:
    def __init__(self):
        self.values = {}
        self.reads = 0
        self.writes = 0
        self.unavailable = False

    def get(self, key):
        assert not db.WRITE_LOCK._is_owned()
        self.reads += 1
        if self.unavailable:
            raise ConnectionError('offline')
        return self.values.get(key)

    def set(self, key, value, ex):
        assert not db.WRITE_LOCK._is_owned()
        assert 0 < ex <= 60
        self.values[key] = value.encode()
        self.writes += 1


def test_progress_shares_only_counts_after_auth_and_refreshes_after_scoring(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    redis = RedisStub()
    with TestClient(app) as client:
        admin, teachers = setup(client)
        scope = seed(4)
        client.post('/api/v1/assignments', headers=admin,
                    json={**scope, 'user_ids': [t[0] for t in teachers[:2]]}).raise_for_status()
        monkeypatch.setenv('OMP_REDIS_URL', 'redis://progress-test')
        monkeypatch.setattr(progress_cache, 'redis_client', lambda _: redis)
        monkeypatch.setattr(progress_cache, '_retry_after', 0)
        def fetch(index):
            return client.get('/api/v1/review-progress', params=scope, headers=teachers[index][1])
        assert fetch(2).status_code == 403 and redis.reads == 0
        assert fetch(0).json()['total_submissions'] == 4
        assert fetch(1).json()['question_completed'] == 0
        assert redis.writes == 1 and set(redis.values.values()) == {b'4,0,0'}
        task = client.post('/api/v1/tasks/claim', json=scope, headers=teachers[0][1]).json()
        client.post('/api/v1/tasks/' + task['id'] + '/score', headers=teachers[0][1],
                    json={'score': 10, 'idempotency_key': str(uuid4())}).raise_for_status()
        assert fetch(1).json()['question_completed'] == 1
        assert redis.writes == 2 and b'4,1,1' in redis.values.values()
        redis.unavailable = True
        result = fetch(0).json()
        assert result['question_completed'] == 1 and result['my_completed'] == 1


def test_replaced_database_never_reuses_old_snapshot_key(tmp_path, monkeypatch):
    root = tmp_path / 'old'
    restored = tmp_path / 'restored'
    monkeypatch.setattr(db, 'ROOT', root)
    db.initialize()
    redis = RedisStub()
    monkeypatch.setenv('OMP_REDIS_URL', 'redis://progress-test')
    monkeypatch.setattr(progress_cache, 'redis_client', lambda _: redis)
    monkeypatch.setattr(progress_cache, '_retry_after', 0)
    with db.connect() as conn:
        before = progress_cache.SharedProgress(conn, 'template', 'question')
        before.counts(conn)
    before.publish()
    restored.mkdir()
    with db.connect() as conn, closing(sqlite3.connect(restored / 'omp.sqlite3')) as destination:
        conn.backup(destination)
    monkeypatch.setattr(db, 'ROOT', restored)
    with db.connect() as conn:
        after = progress_cache.SharedProgress(conn, 'template', 'question')
        assert before.read_revision == after.read_revision and before.prefix != after.prefix
        assert after.cached is None
