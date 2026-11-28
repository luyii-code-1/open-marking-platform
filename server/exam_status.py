"""Exam progress derived from all subjects' current result publications."""
from datetime import datetime, timezone
import time
from typing import Literal
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from .db import connect, objects, put
from .dependencies import admin, require

router = APIRouter(prefix='/api/v1')
ExamStatus = Literal['in_progress', 'pending_review', 'completed']
ExamStatusFilter = Literal['all', 'in_progress', 'pending_review', 'completed']
ExamStatusMode = Literal['auto', 'in_progress', 'pending_review', 'completed']
RECENT_COMPLETED_SECONDS = 7 * 86400
STATUS_FIELDS = ('exam_status', 'exam_status_mode', 'auto_exam_status', 'created_at', 'completed_at', 'recently_completed')


def _parse_utc(value):
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def _audit_times(db, project_ids):
    created, updated = {}, {}
    if not project_ids:
        return created, updated
    rows = db.execute(
        "SELECT object_id, action, created FROM audit WHERE object_id=ANY(?::text[]) AND action IN ('create','update') ORDER BY rowid ASC",
        (list(project_ids),),
    )
    for object_id, action, stamp in rows:
        ts = _parse_utc(stamp)
        if ts is None:
            continue
        if action == 'create' and object_id not in created:
            created[object_id] = ts
        if action == 'update':
            updated[object_id] = ts
    return created, updated


def project_views(db, projects, subjects=None, groups=None):
    subjects = objects(db, 'subjects') if subjects is None else subjects
    groups = objects(db, 'groups') if groups is None else groups
    subject_groups = {}
    for group in groups:
        subject_groups.setdefault(group.get('subject_id'), []).append(group)
    project_subjects = {}
    project_published = {}
    for subject in subjects:
        cards = subject_groups.get(subject['id'], [])
        complete = bool(cards) and all(card.get('frozen') for card in cards)
        pid = subject.get('project_id')
        project_subjects.setdefault(pid, []).append(complete)
        for card in cards:
            if card.get('published_at'):
                project_published.setdefault(pid, []).append(card['published_at'])
    need_audit = [p['id'] for p in projects if not p.get('created_at') or not p.get('completed_at')]
    created_map, updated_map = _audit_times(db, need_audit)
    now = time.time()
    result = []
    for project in projects:
        publications = project_subjects.get(project['id'], [])
        automatic = ('completed' if project.get('category')=='statistics' else 'pending_review') if publications and all(publications) else 'in_progress'
        mode = project.get('exam_status_mode', 'auto')
        status = automatic if mode == 'auto' else mode
        created_at = project.get('created_at') or created_map.get(project['id'])
        if status == 'completed':
            pub_times = project_published.get(project['id'], [])
            completed_at = project.get('completed_at') or (max(pub_times) if mode == 'auto' and pub_times else updated_map.get(project['id']) or created_at)
        else:
            completed_at = None
        recently_completed = status == 'completed' and completed_at is not None and (now - completed_at) <= RECENT_COMPLETED_SECONDS
        result.append({
            **project,
            'exam_status_mode': mode,
            'auto_exam_status': automatic,
            'exam_status': status,
            'created_at': created_at,
            'completed_at': completed_at,
            'recently_completed': recently_completed,
        })
    return result


def filter_projects(projects, status):
    if status == 'all':
        return projects
    if status == 'in_progress':
        return [p for p in projects if p['exam_status'] == 'in_progress' or p.get('recently_completed')]
    return [p for p in projects if p['exam_status'] == status]


class ExamStatusUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mode: ExamStatusMode


@router.put('/projects/{identifier}/exam-status')
def update_status(identifier: str, body: ExamStatusUpdate, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        project = require(db, identifier, 'projects')
        project['exam_status_mode'] = body.mode
        if body.mode == 'completed':
            project['completed_at'] = time.time()
        else:
            project.pop('completed_at', None)
        project = put(db, 'projects', project, current['id'])
        return project_views(db, [project])[0]
