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


def initialize(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS identifiers(id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner_id TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS identifier_owner ON identifiers(owner_id,kind);
        CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY);
    ''')
    if not db.execute("SELECT 1 FROM schema_migrations WHERE name='identifiers-v1'").fetchone():
        db.execute('BEGIN IMMEDIATE')
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
        db.execute("INSERT INTO schema_migrations VALUES('identifiers-v1')")
        db.commit()
    # Enforce cross-table ownership even for direct SQL, and keep hard-delete tombstones.
    db.executescript('''
        CREATE TRIGGER IF NOT EXISTS object_identifier_insert BEFORE INSERT ON objects BEGIN
          SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id)!=36 OR lower(NEW.id)!=NEW.id OR NEW.id GLOB '*[^0-9a-f-]*' OR length(replace(NEW.id,'-',''))!=32 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-' THEN RAISE(ABORT,'invalid UUID') END;
          SELECT CASE WHEN EXISTS(SELECT 1 FROM identifiers WHERE id=NEW.id AND (kind!=NEW.kind OR owner_id!=NEW.id OR retired!=0)) THEN RAISE(ABORT,'identifier conflict') END;
          INSERT OR IGNORE INTO identifiers(id,kind,owner_id) VALUES(NEW.id,NEW.kind,NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS object_identifier_update BEFORE UPDATE ON objects BEGIN
          SELECT CASE WHEN OLD.id!=NEW.id OR OLD.kind!=NEW.kind OR (OLD.deleted!=0 AND NEW.deleted=0) THEN RAISE(ABORT,'identifier immutable') END;
        END;
        CREATE TRIGGER IF NOT EXISTS object_identifier_retire AFTER UPDATE OF deleted ON objects WHEN NEW.deleted!=0 BEGIN
          UPDATE identifiers SET retired=1 WHERE id=NEW.id OR (kind='questions' AND owner_id=NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS object_identifier_delete AFTER DELETE ON objects BEGIN
          UPDATE identifiers SET retired=1 WHERE id=OLD.id OR (kind='questions' AND owner_id=OLD.id);
        END;
        CREATE TRIGGER IF NOT EXISTS user_identifier_insert BEFORE INSERT ON users BEGIN
          SELECT CASE WHEN NEW.id IS NULL OR length(NEW.id)!=36 OR lower(NEW.id)!=NEW.id OR NEW.id GLOB '*[^0-9a-f-]*' OR length(replace(NEW.id,'-',''))!=32 OR substr(NEW.id,9,1)!='-' OR substr(NEW.id,14,1)!='-' OR substr(NEW.id,19,1)!='-' OR substr(NEW.id,24,1)!='-' THEN RAISE(ABORT,'invalid UUID') END;
          SELECT CASE WHEN EXISTS(SELECT 1 FROM identifiers WHERE id=NEW.id AND (kind!='users' OR owner_id!=NEW.id OR retired!=0)) THEN RAISE(ABORT,'identifier conflict') END;
          INSERT OR IGNORE INTO identifiers(id,kind,owner_id) VALUES(NEW.id,'users',NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS user_identifier_update BEFORE UPDATE OF id ON users WHEN OLD.id!=NEW.id BEGIN
          SELECT RAISE(ABORT,'identifier immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS user_identifier_delete AFTER DELETE ON users BEGIN
          UPDATE identifiers SET retired=1 WHERE id=OLD.id;
        END;
    ''')
