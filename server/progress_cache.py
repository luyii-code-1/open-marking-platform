"""Cache the three shared review counters. SQLite owns their snapshot and revision."""
import os
import time
from functools import lru_cache

from redis import Redis
from redis.backoff import NoBackoff
from redis.exceptions import RedisError
from redis.retry import Retry

from . import db as database


@lru_cache(maxsize=2)
def redis_client(url):
    return Redis.from_url(url, socket_connect_timeout=0.1, socket_timeout=0.1, retry=Retry(NoBackoff(), 0))


_retry_after = 0.0


def back_off():
    global _retry_after
    _retry_after = time.monotonic() + 3


def revision(db):
    # Domain writes and the recovery event append a UUID in their own transaction.
    row = db.execute('SELECT id FROM audit ORDER BY rowid DESC LIMIT 1').fetchone()
    return row[0] if row else 'empty'


class SharedProgress:
    def __init__(self, db, template_id, question_id):
        self.template_id = template_id
        self.question_id = question_id
        self.client = None
        self.cached = None
        self.pending = None
        url = os.getenv('OMP_REDIS_URL')
        if not url or time.monotonic() < _retry_after:
            return
        try:
            stat = (database.ROOT / 'omp.sqlite3').stat()
            self.prefix = f'omp:progress:v1:{stat.st_dev}:{stat.st_ino}:{template_id}:{question_id}:'
            self.read_revision = revision(db)
            self.client = redis_client(url)
            raw = self.client.get(self.prefix + self.read_revision)
        except (OSError, RedisError, ValueError):
            self.client = None
            back_off()
            return
        if raw:
            try:
                fields = [int(value) for value in raw.split(b',' if isinstance(raw, bytes) else ',')]
                if len(fields) == 3 and min(fields) >= 0:
                    self.cached = tuple(fields)
            except ValueError:
                pass

    def counts(self, db):
        # Cache lookup precedes the request's SQLite transaction. Recheck against
        # the same snapshot used for authorization-dependent personal progress.
        current = revision(db) if self.client is not None else None
        if self.cached is not None and self.read_revision == current:
            return self.cached
        submissions = db.execute("""SELECT COUNT(*) FROM objects INDEXED BY object_submission
            WHERE kind='submissions' AND deleted=0 AND json_extract(body,'$.template_id')=?
              AND json_extract(body,'$.status')='ready'""", (self.template_id,)).fetchone()[0]
        question, paper = db.execute("""SELECT COUNT(*) FILTER (WHERE r.question_id=?), COUNT(*)
            FROM review_results r JOIN objects s ON s.id=r.submission_id
            WHERE r.final_cents IS NOT NULL AND s.deleted=0 AND json_extract(s.body,'$.template_id')=?""",
            (self.question_id, self.template_id)).fetchone()
        counts = (submissions, question, paper)
        if current is not None:
            self.pending = (self.prefix + current, ','.join(map(str, counts)))
        return counts

    def publish(self):
        if self.pending is not None:
            try:
                self.client.set(*self.pending, ex=15)
            except (OSError, RedisError):
                back_off()
