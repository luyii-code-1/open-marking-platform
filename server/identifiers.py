"""Lightweight UUID format validation and in-template question ID deduplication."""
from uuid import UUID, uuid4


class InvalidIdentifier(ValueError): pass
class IdentifierConflict(ValueError): pass


def canonical(identifier):
    try:
        if not isinstance(identifier, str) or str(UUID(identifier)) != identifier: raise ValueError()
    except (ValueError, AttributeError):
        raise InvalidIdentifier('编号必须是标准小写UUID')
    return identifier


def reserve(db, identifier, kind, owner):
    canonical(identifier)


def prepare_questions(body):
    questions = body.get('questions', [])
    if not isinstance(questions, list) or any(not isinstance(q, dict) for q in questions): raise InvalidIdentifier('题目应为对象列表')
    body['questions'] = [{**q, 'id': q.get('id', str(uuid4()))} for q in questions]


def template_questions(db, body, old):
    questions = body.get('questions', [])
    if not isinstance(questions, list) or any(not isinstance(q, dict) or 'id' not in q for q in questions):
        raise InvalidIdentifier('每道题必须具有UUID')
    ids = [canonical(q['id']) for q in questions]
    if len(set(ids)) != len(ids): raise IdentifierConflict('题目UUID重复')


def backfill_identifiers(db):
    return
