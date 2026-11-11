"""Capture class labels with exam identity, independently of later promotion."""
from .db import get


def snapshot(db, student):
    value = dict(student)
    if 'class_name' not in value or 'grade' not in value:
        cls = get(db, value['class_id'], 'classes') or {}
        value.setdefault('class_name', cls.get('name', value['class_id']))
        value.setdefault('grade', cls.get('grade'))
    return value
