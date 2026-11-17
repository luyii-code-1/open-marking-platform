"""Exam progress derived from all subjects' current result publications."""
from typing import Literal
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from .db import connect, objects, put
from .dependencies import admin, require

router = APIRouter(prefix='/api/v1')
ExamStatus = Literal['in_progress', 'completed']
ExamStatusFilter = Literal['all', 'in_progress', 'completed']
ExamStatusMode = Literal['auto', 'in_progress', 'completed']
STATUS_FIELDS = ('exam_status', 'exam_status_mode', 'auto_exam_status')


def project_views(db, projects, subjects=None, groups=None):
    subjects = objects(db, 'subjects') if subjects is None else subjects
    groups = objects(db, 'groups') if groups is None else groups
    subject_groups = {}
    for group in groups:
        subject_groups.setdefault(group.get('subject_id'), []).append(group)
    project_subjects = {}
    for subject in subjects:
        cards = subject_groups.get(subject['id'], [])
        complete = bool(cards) and all(card.get('frozen') for card in cards)
        project_subjects.setdefault(subject.get('project_id'), []).append(complete)
    result = []
    for project in projects:
        publications = project_subjects.get(project['id'], [])
        automatic = 'completed' if publications and all(publications) else 'in_progress'
        mode = project.get('exam_status_mode', 'auto')
        result.append({**project, 'exam_status_mode': mode, 'auto_exam_status': automatic,
                       'exam_status': automatic if mode == 'auto' else mode})
    return result


def filter_projects(projects, status):
    return projects if status == 'all' else [p for p in projects if p['exam_status'] == status]


class ExamStatusUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mode: ExamStatusMode


@router.put('/projects/{identifier}/exam-status')
def update_status(identifier: str, body: ExamStatusUpdate, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        project = require(db, identifier, 'projects')
        project['exam_status_mode'] = body.mode
        project = put(db, 'projects', project, current['id'])
        return project_views(db, [project])[0]
