"""Fence an exam while its archived scan files are being removed."""
from contextlib import contextmanager
from contextvars import ContextVar
from fastapi import HTTPException

_operation = ContextVar('omp_deletion_operation', default=None)
PARENTS = {
    'subjects': ('project_id',), 'groups': ('subject_id',),
    'templates': ('group_id',), 'scan-batches': ('group_id',), 'rosters': ('group_id',),
    'pages': ('batch_id',), 'submissions': ('group_id',),
    'assignments': ('template_id',), 'tasks': ('template_id', 'submission_id'),
    'answer-slices': ('group_id', 'template_id', 'submission_id'),
    'exceptions': ('group_id', 'batch_id', 'page_id', 'submission_id', 'task_id'),
    'page-alignments': ('page_id',), 'publication-events': ('group_id',),
    'regrade-events': ('template_id', 'task_id'),
}


def project_for(db, kind, body, visited=None):
    from .db import get
    if kind == 'projects': return body.get('id')
    visited = set() if visited is None else visited
    for field in PARENTS.get(kind, ()):
        identifier = body.get(field)
        if not identifier or identifier in visited: continue
        visited.add(identifier)
        row = db.execute('SELECT kind FROM objects WHERE id=? AND deleted=0', (identifier,)).fetchone()
        if row:
            project = project_for(db, row['kind'], get(db, identifier), visited)
            if project: return project
    return None


def project_writable(db, project_id):
    if not project_id: return
    lock = db.execute('SELECT plan_id FROM deletion_locks WHERE project_id=?', (project_id,)).fetchone()
    if not lock: return
    owner = _operation.get()
    if owner and owner[0] == lock['plan_id']:
        from .jobs import guard
        guard(db, owner[1]); return
    raise HTTPException(409, '该考试正在归档并删除，请等待任务完成；失败时请在删除任务中重试')


def writable(db, kind, body):
    project_writable(db, project_for(db, kind, body))


@contextmanager
def operation(plan_id, ownership):
    token = _operation.set((plan_id, ownership))
    try: yield
    finally: _operation.reset(token)
