import asyncio
import hashlib
import time
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient

from server import db
from server.review_writes import ReviewWriter
from server.main import app
from test_allocation import seed, setup


def test_batch_isolation_authorization_and_commit_failure(tmp_path):
    db.initialize(tmp_path)
    token, user_id = str(uuid4()), str(uuid4())
    with db.connect(tmp_path) as conn:
        conn.execute('INSERT INTO users VALUES(?,?,?,?,?)', (user_id, 'a', 'A', 'teacher', 'unused'))
        conn.execute('INSERT INTO sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), user_id, time.time()+600))
        conn.execute('CREATE TABLE probe(value INTEGER, user_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)')

    def request(bearer):
        return SimpleNamespace(headers={'authorization': 'Bearer '+bearer}, state=SimpleNamespace())

    def save(conn, prepared, current, value):
        owner = 'missing' if value == 4 else current['id']
        conn.execute('INSERT INTO probe VALUES(?,?)', (value, owner))
        if value == 2:
            raise HTTPException(409, 'conflict')
        return value

    async def burst():
        writer = ReviewWriter(tmp_path, persistent=True)
        first = request(token)
        results = await asyncio.gather(
            writer.submit(first, save, 1),
            writer.submit(request(token), save, 2),
            writer.submit(request('revoked'), save, 3),
            writer.submit(request(token), save, 3),
            return_exceptions=True)
        assert first.state.actor == user_id
        assert [r.status_code if isinstance(r, HTTPException) else r for r in results] == [1, 409, 401, 3]
        failed_commit = await asyncio.gather(writer.submit(request(token), save, 4),
                                             writer.submit(request(token), save, 5), return_exceptions=True)
        assert all(isinstance(error, HTTPException) and error.status_code == 503 for error in failed_commit)
        # A failed COMMIT discarded the handle; the next operation still gets
        # its receipt, even when shutdown starts while the batch is queued.
        pending = asyncio.create_task(writer.submit(request(token), save, 6))
        await asyncio.sleep(0)
        await writer.close()
        assert await pending == 6
        try:
            await writer.submit(request(token), save, 7)
        except HTTPException as error:
            assert error.status_code == 503
        else:
            raise AssertionError('closed writer accepted another operation')

    asyncio.run(burst())
    with db.connect(tmp_path) as conn:
        assert [row[0] for row in conn.execute('SELECT value FROM probe ORDER BY value')] == [1, 3, 6]


def test_http_review_writer_reuses_one_unlocked_connection_per_lifespan(tmp_path, monkeypatch):
    from threading import get_ident
    from server.review_writes import ReviewConnection

    monkeypatch.setattr(db, 'ROOT', tmp_path)
    samples = []
    original = ReviewConnection.commit
    def observe(self, batch):
        result = original(self, batch)
        samples.append((self, self.db, get_ident(), self.db.raw.info.backend_pid))
        assert not self.db.in_transaction
        return result
    monkeypatch.setattr(ReviewConnection, 'commit', observe)

    with TestClient(app) as client:
        admin, teachers = setup(client, 1)
        scope = seed(1)
        client.post('/api/v1/assignments', headers=admin,
                    json={**scope, 'user_ids': [teachers[0][0]]}).raise_for_status()
        headers = teachers[0][1]
        task = client.post('/api/v1/tasks/claim', headers=headers, json=scope).json()
        with db.connect() as other, other.raw.transaction():
            assert other.raw.info.backend_pid != samples[0][3]
            other.execute("SET LOCAL lock_timeout = '2s'")
            other.execute('BEGIN IMMEDIATE')
            db.put(other, 'account-events', {'user_id': teachers[0][0], 'action': 'external_write'})
        url = '/api/v1/tasks/'+task['id']+'/score'
        payload = {'score': 10, 'idempotency_key': str(uuid4())}
        client.post(url, headers=headers, json=payload).raise_for_status()
        client.post(url, headers=headers, json=payload).raise_for_status()
        assert len(samples) == 3 and len(set(samples)) == 1
    assert samples[0][0].db is None
    with TestClient(app) as reopened:
        reopened.post(url, headers=headers, json=payload).raise_for_status()
        assert samples[-1][1] is not samples[0][1]
    assert samples[-1][0].db is None
    with db.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM scores').fetchone()[0] == 1


def test_pipelined_score_constraint_error_rolls_back_only_one_request(tmp_path, monkeypatch):
    from psycopg.errors import CheckViolation
    from server.review import score_in_transaction
    from server.review_writes import Operation, apply_batch

    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        admin, teachers = setup(client, 1)
        scope = seed(1)
        teacher, headers = teachers[0]
        client.post('/api/v1/assignments', headers=admin, json={**scope, 'user_ids': [teacher]}).raise_for_status()
        task = client.post('/api/v1/tasks/claim', headers=headers, json=scope).json()
        with db.connect() as conn:
            conn.execute("ALTER TABLE scores ADD CHECK (idempotency_key <> 'rejected')")
        request = SimpleNamespace(headers={'authorization': headers['Authorization']}, state=SimpleNamespace())
        batch = [
            Operation(request, score_in_transaction, (task['id'], {'score': score, 'idempotency_key': key}), None)
            for score, key in ((3, 'rejected'), (8, 'accepted'))
        ]
        with db.connect() as conn:
            failed, succeeded = apply_batch(conn, batch)
        assert isinstance(failed[1], CheckViolation)
        assert succeeded[1] is None and succeeded[0]['score_revision'] == 1
        with db.connect() as conn:
            assert conn.execute('SELECT score FROM scores').fetchall() == [(800,)]
            assert conn.execute('SELECT final_cents FROM review_results').fetchall() == [(800,)]
