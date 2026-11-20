"""Group simultaneous review operations into durable PostgreSQL commits."""
import asyncio
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from dataclasses import dataclass
import logging

from fastapi import HTTPException, Request

from . import db as database
from .dependencies import authenticate_session

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class Operation:
    request: Request
    handler: Callable
    args: tuple
    result: asyncio.Future


def apply_batch(db, batch):
    from .review import score_in_transaction
    outcomes = []
    # Other writers cannot change assignments, sessions or the frozen state
    # during this transaction. Never reuse the preparation cache after COMMIT.
    prepared = {}
    with db:
        db.execute('BEGIN IMMEDIATE')
        # Claim and score never change the exam hierarchy or its room labels.
        db.review_writable_templates = set()
        db.review_reference_rows = {}
        for op in batch:
            try:
                # A read flushes its preceding commands. At the end, RELEASE
                # travels with the final writes. PostgreSQL skips RELEASE if
                # an earlier statement fails, so the savepoint remains usable.
                # Cold allocation can issue COPY, which needs a non-pipelined connection.
                with db.raw.pipeline() if op.handler is score_in_transaction else nullcontext():
                    db.execute('SAVEPOINT review_operation')
                    current = authenticate_session(db, op.request.headers.get('authorization'), op.request)
                    value = op.handler(db, prepared, current, *op.args)
                    db.execute('RELEASE review_operation')
            except Exception as error:
                db.execute('ROLLBACK TO review_operation')
                db.execute('RELEASE review_operation')
                prepared.clear()
                db.review_writable_templates.clear()
                db.review_reference_rows.clear()
                outcomes.append((None, error))
            else:
                outcomes.append((value, None))
        del db.review_reference_rows
        del db.review_writable_templates
    return outcomes


def commit_batch(root, batch):
    with database.connect(root) as db:
        return apply_batch(db, batch)


class ReviewConnection:
    """Created, used and closed on the API worker's dedicated write thread."""

    def __init__(self, root):
        self.root = root
        self.db = None

    def commit(self, batch):
        try:
            if self.db is None:
                self.db = database.open_connection(self.root)
            return apply_batch(self.db, batch)
        except BaseException:
            # Closing also releases the application write lock if BEGIN or
            # COMMIT failed. A subsequent batch obtains a fresh connection.
            self.close()
            raise

    def close(self):
        if self.db is not None:
            try:
                self.db.close()
            finally:
                self.db = None


class ReviewWriter:
    def __init__(self, root, persistent=False):
        self.root = root
        self.pending = deque()
        self.worker = None
        self.closing = None
        self.connection = ReviewConnection(root) if persistent else None
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='omp-review-writer') if persistent else None

    async def submit(self, request, handler, *args):
        if self.closing is not None:
            raise HTTPException(503, '阅卷服务正在关闭，请重试')
        if len(self.pending) >= 4096:
            raise HTTPException(503, '阅卷请求正在排队，请稍后重试', headers={'Retry-After': '1'})
        result = asyncio.get_running_loop().create_future()
        self.pending.append(Operation(request, handler, args, result))
        if self.worker is None:
            self.worker = asyncio.create_task(self.drain())
        return await result

    async def drain(self):
        batch = []
        try:
            await asyncio.sleep(.002)
            while self.pending:
                batch = [self.pending.popleft() for _ in range(min(128, len(self.pending)))]
                try:
                    if self.executor is None:
                        outcomes = await asyncio.to_thread(commit_batch, self.root, batch)
                    else:
                        loop = asyncio.get_running_loop()
                        outcomes = await loop.run_in_executor(self.executor, self.connection.commit, batch)
                except Exception:
                    logger.exception('阅卷事务未确认提交')
                    outcomes = [(None, HTTPException(503, '阅卷事务未确认，请重试')) for _ in batch]
                for op, (value, error) in zip(batch, outcomes):
                    if not op.result.done():
                        if error is None:
                            op.result.set_result(value)
                        else:
                            op.result.set_exception(error)
                batch = []
        finally:
            for op in [*batch, *self.pending]:
                if not op.result.done():
                    op.result.cancel()
            self.pending.clear()
            self.worker = None

    async def close(self):
        if self.closing is None:
            self.closing = asyncio.create_task(self.finish())
        await asyncio.shield(self.closing)

    async def finish(self):
        try:
            if self.worker is not None:
                await asyncio.shield(self.worker)
        finally:
            if self.executor is not None:
                try:
                    await asyncio.get_running_loop().run_in_executor(self.executor, self.connection.close)
                finally:
                    self.executor.shutdown(wait=True)


async def submit(request, handler, *args):
    authorization = request.headers.get('authorization', '')
    if not authorization.startswith('Bearer '):
        raise HTTPException(401, '请先登录')
    writer = getattr(request.state, 'review_writer', None)
    if writer is not None:
        return await writer.submit(request, handler, *args)
    # ASGI clients which omit application lifespan still get grouped commits
    # without retaining a thread or a database connection after their burst.
    loop = asyncio.get_running_loop()
    state = request.app.state
    entry = getattr(state, 'review_writer', None)
    if entry is None or entry[0] is not loop or entry[1].root != database.ROOT:
        entry = state.review_writer = (loop, ReviewWriter(database.ROOT))
    return await entry[1].submit(request, handler, *args)
