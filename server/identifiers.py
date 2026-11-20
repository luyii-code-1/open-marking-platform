"""Permanent business identifiers, including questions nested inside templates."""
import json
from uuid import UUID,uuid4


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
    db.execute('INSERT OR IGNORE INTO identifiers(id,kind,owner_id) VALUES(?,?,?)', (identifier,kind,owner))
    row=db.execute('SELECT kind,owner_id,retired FROM identifiers WHERE id=?', (identifier,)).fetchone()
    if row['kind']!=kind or row['owner_id']!=owner or row['retired']:
        raise IdentifierConflict('编号已被使用或已退役，不能复用：'+identifier)


def prepare_questions(body):
    questions=body.get('questions',[])
    if not isinstance(questions,list) or any(not isinstance(q,dict) for q in questions):raise InvalidIdentifier('题目应为对象列表')
    body['questions']=[{**q,'id':q.get('id',str(uuid4()))} for q in questions]


def template_questions(db, body, old):
    questions=body.get('questions',[])
    if not isinstance(questions,list) or any(not isinstance(q,dict) or 'id' not in q for q in questions):
        raise InvalidIdentifier('每道题必须具有UUID')
    ids=[canonical(q['id']) for q in questions]
    if len(set(ids))!=len(ids):raise IdentifierConflict('题目UUID重复')
    for identifier in ids:reserve(db,identifier,'questions',body['id'])
    for question in (old or {}).get('questions',[]):
        if question['id'] not in ids:
            db.execute("UPDATE identifiers SET retired=1 WHERE id=? AND kind='questions' AND owner_id=?",(question['id'],body['id']))


def backfill_identifiers(db):
    for row in db.execute('SELECT id FROM users').fetchall():reserve(db,row['id'],'users',row['id'])
    rows=db.execute('SELECT id,kind,body,deleted FROM objects').fetchall()
    for row in rows:reserve(db,row['id'],row['kind'],row['id'])
    for row in rows:
        if row['kind']=='templates':template_questions(db,json.loads(row['body']),None)
    # Older drafts may already have removed questions. Their history also reserves IDs.
    for row in db.execute("SELECT a.body,o.id FROM audit a JOIN objects o ON o.id=a.object_id WHERE o.kind='templates'").fetchall():
        for q in json.loads(row['body']).get('questions',[]):reserve(db,q['id'],'questions',row['id'])
    for row in rows:
        if row['kind']=='templates':
            active={q['id'] for q in json.loads(row['body']).get('questions',[])}
            for q in db.execute("SELECT id FROM identifiers WHERE kind='questions' AND owner_id=?",(row['id'],)).fetchall():
                if row['deleted'] or q['id'] not in active:db.execute('UPDATE identifiers SET retired=1 WHERE id=?',(q['id'],))
        if row['deleted']:db.execute('UPDATE identifiers SET retired=1 WHERE id=?',(row['id'],))
