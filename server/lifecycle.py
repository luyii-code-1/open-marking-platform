"""Fence an exam while its archived scan files are being removed."""
from contextlib import contextmanager
from contextvars import ContextVar
import json
from fastapi import HTTPException

RESULTS_REVIEW_GUIDE = ('成绩已发布。如需更正，请由系统管理员或管理教师在管理后台的「考试项目」'
                        '打开对应题卡，进入「成绩」，点击「发起成绩复核」并填写原因。')

_operation = ContextVar('omp_deletion_operation', default=None)
PARENTS = {
    'room-tags': ('project_id','group_id'),
    'subjects': ('project_id',), 'groups': ('subject_id',),
    'templates': ('group_id',), 'scan-batches': ('group_id',), 'rosters': ('group_id',),
    'pages': ('batch_id',), 'submissions': ('group_id',), 'statistics-responses': ('group_id',),
    'assignments': ('template_id',), 'tasks': ('template_id', 'submission_id'),
    'answer-slices': ('group_id', 'template_id', 'submission_id'),
    'exceptions': ('group_id', 'batch_id', 'page_id', 'submission_id', 'task_id'),
    'page-alignments': ('page_id',), 'publication-events': ('group_id',),
    'regrade-events': ('template_id', 'task_id'),
}


def project_for(db, kind, body, visited=None):
    if kind == 'projects': return body.get('id')
    visited = set() if visited is None else visited
    for field in PARENTS.get(kind, ()):
        identifier = body.get(field)
        if not identifier or identifier in visited: continue
        visited.add(identifier)
        row = db.execute('SELECT kind,body FROM objects WHERE id=? AND deleted=0', (identifier,)).fetchone()
        if row:
            project = project_for(db, row['kind'], json.loads(row['body']), visited)
            if project: return project
    return None


def project_writable(db, project_id):
    if not project_id: return
    from .db import get
    project = get(db, project_id, 'projects') or {}
    purged = project.get('scans_purged')
    owner = _operation.get()
    if purged and not (owner and owner[0] == purged.get('plan_id')):
        raise HTTPException(410, '该考试的扫描文件已清理，保留成绩查询与导出，不能再查看原卷、重新识别或复核')
    lock = db.execute('SELECT plan_id FROM deletion_locks WHERE project_id=?', (project_id,)).fetchone()
    if not lock: return
    if owner and owner[0] == lock['plan_id']:
        from .jobs import guard
        guard(db, owner[1]); return
    raise HTTPException(409, '该考试正在归档并删除，请等待任务完成；失败时请在删除任务中重试')


def writable(db, kind, body):
    checked = getattr(db, 'review_writable_templates', None)
    if checked is not None and kind == 'tasks':
        from .db import get
        template_id = body.get('template_id')
        if template_id in checked:
            return
        template = get(db, template_id, 'templates')
        if template:
            project = project_for(db, 'templates', template)
            if project:
                project_writable(db, project)
                checked.add(template_id)
                return
        # A legacy task can derive its project from the submission instead.
        # That result belongs to this task and cannot authorize its peers.
    project_writable(db, project_for(db, kind, body))


@contextmanager
def operation(plan_id, ownership):
    token = _operation.set((plan_id, ownership))
    try: yield
    finally: _operation.reset(token)
