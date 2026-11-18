"""Persistent weighted allocations; caller holds the SQLite write transaction."""
import hashlib
import heapq
import json
import time

from fastapi import HTTPException
from .db import connect, find


def initialize_invalidation(db):
    # The ready roster can change without changing its size or largest rowid.
    # Invalidate in the transaction which actually changes its membership.
    def invalidate(template):
        return f"""DELETE FROM allocation_state WHERE question_id IN (
            SELECT json_extract(q.value,'$.id') FROM objects t, json_each(t.body,'$.questions') q
            WHERE t.id=json_extract({template}.body,'$.template_id'));"""

    db.executescript(f"""
        CREATE TRIGGER IF NOT EXISTS allocation_ready_insert AFTER INSERT ON objects
        WHEN NEW.kind='submissions' AND NEW.deleted=0 AND json_extract(NEW.body,'$.status')='ready'
        BEGIN {invalidate('NEW')} END;
        CREATE TRIGGER IF NOT EXISTS allocation_ready_delete AFTER DELETE ON objects
        WHEN OLD.kind='submissions' AND OLD.deleted=0 AND json_extract(OLD.body,'$.status')='ready'
        BEGIN {invalidate('OLD')} END;
        CREATE TRIGGER IF NOT EXISTS allocation_ready_update AFTER UPDATE OF body,deleted ON objects
        WHEN NEW.kind='submissions'
          AND (OLD.deleted<>NEW.deleted OR json_extract(OLD.body,'$.status') IS NOT json_extract(NEW.body,'$.status')
               OR json_extract(OLD.body,'$.template_id') IS NOT json_extract(NEW.body,'$.template_id'))
          AND ((OLD.deleted=0 AND json_extract(OLD.body,'$.status')='ready')
               OR (NEW.deleted=0 AND json_extract(NEW.body,'$.status')='ready'))
        BEGIN {invalidate('OLD')} {invalidate('NEW')} END;
        CREATE INDEX IF NOT EXISTS review_unresolved_question ON review_results(question_id,submission_id)
        WHERE final_cents IS NULL;
    """)


def config_signature(question, assignment):
    fields = ['equal-v2', assignment, question.get('review_mode', 'single')]
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()


def allocation_current(db, question, assignment, signature):
    old = db.execute('SELECT signature FROM allocation_state WHERE question_id=?', (question['id'],)).fetchone()
    if not old:
        return False
    if old[0] == signature:
        return True
    if old[0] != 'retained:' + signature:
        return False
    # A removed teacher keeps an active paper until the lease ends.
    ordinary, arbiters = pools(assignment)
    stale = db.execute("""SELECT 1 FROM review_allocations a WHERE a.question_id=?
        AND ((a.round<3 AND a.user_id NOT IN (SELECT value FROM json_each(?)))
            OR (a.round=3 AND a.user_id NOT IN (SELECT value FROM json_each(?))))
        AND NOT EXISTS(SELECT 1 FROM objects t INDEXED BY object_task_answer WHERE t.kind='tasks' AND t.deleted=0
            AND json_extract(t.body,'$.submission_id')=+a.submission_id AND json_extract(t.body,'$.question_id')=+a.question_id
            AND json_extract(t.body,'$.user_id')=a.user_id AND (json_extract(t.body,'$.status')='completed'
                OR (json_extract(t.body,'$.status')='claimed' AND json_extract(t.body,'$.expires_at')>?))) LIMIT 1""",
        (question['id'], json.dumps(ordinary), json.dumps(arbiters), time.time())).fetchone()
    return stale is None


def participants(assignment):
    return set(assignment.get('user_ids', [])) | set(assignment.get('arbitrator_ids', []))


def pools(assignment):
    ordinary = [u for u in assignment['user_ids'] if assignment.get('weights', {}).get(u, 1) > 0]
    mode = assignment.get('arbitration_mode', 'designated_random' if assignment.get('arbitrator_ids') else 'random')
    arbiters = assignment.get('arbitrator_ids', []) if mode != 'random' else ordinary
    return ordinary, [u for u in dict.fromkeys(arbiters) if assignment.get('arbitrator_weights', {}).get(u, 1) > 0]


def validate(assignment, question):
    ordinary, arbiters = pools(assignment)
    mode = assignment.get('arbitration_mode', 'designated_random' if assignment.get('arbitrator_ids') else 'random')
    if mode not in ('random', 'designated_random', 'fixed', 'weighted'):
        raise HTTPException(422, '仲裁方式无效')
    if mode == 'fixed' and len(arbiters) != 1:
        raise HTTPException(422, '固定仲裁需要指定一名教师')
    if not ordinary:
        raise HTTPException(422, '至少一名阅卷教师的权重需大于0')
    if question.get('review_mode', 'single') == 'double':
        if len(ordinary) < 2 or not arbiters or len(set(ordinary) | set(arbiters)) < 3:
            raise HTTPException(422, '双评需要两名有效阅卷教师及一名可回避前两评的仲裁教师')
        if mode == 'fixed' and len(set(ordinary) - set(arbiters)) < 2:
            raise HTTPException(422, '固定仲裁之外还需两名有效阅卷教师')


def ensure(db, template, question, assignment):
    """Build once per configuration or ready-submission change, preserving live work."""
    tid, qid = template['id'], question['id']
    signature = config_signature(question, assignment)
    if allocation_current(db, question, assignment, signature):
        return
    ordinary, arbiters = pools(assignment)
    validate(assignment, question)
    slots = 2 if question.get('review_mode', 'single') == 'double' else 1
    rows = db.execute("SELECT id FROM objects INDEXED BY object_submission WHERE kind='submissions' AND deleted=0 AND json_extract(body,'$.template_id')=? AND json_extract(body,'$.status')='ready'", (tid,)).fetchall()
    # Randomized paper order with stable teacher quotas across restarts.
    submissions = sorted((r[0] for r in rows), key=lambda s: hashlib.sha256((qid+s).encode()).digest())
    tasks = find(db, 'tasks', template_id=tid, question_id=qid)
    active = {}
    now = time.time()
    for task in sorted(tasks, key=lambda t: t['created_at']):
        if task['status'] == 'completed' or (task['status'] == 'claimed' and task['expires_at'] > now):
            active.setdefault(task['submission_id'], []).append(task)
    db.execute('DELETE FROM review_allocations WHERE question_id=?', (qid,))
    counts = {u: 0 for u in ordinary}
    records = []
    for sid in submissions:
        pinned = active.get(sid, [])[:slots]
        for task in pinned:
            if task['user_id'] in counts:
                counts[task['user_id']] += 1
        records.append((sid, pinned))
    # Balance by current count; retain the original assignment order for ties.
    # Re-scanning the entire teacher roster for each paper made cold starts
    # particularly expensive when a large exam opened.
    ranked = [(counts[u], position, u) for position, u in enumerate(dict.fromkeys(ordinary))]
    heapq.heapify(ranked)
    arbiter_ids = set(arbiters)
    ordinary_ids = set(ordinary)
    retained = False
    for sid, pinned in records:
        chosen = [t['user_id'] for t in pinned]
        if any(uid not in ordinary_ids for uid in chosen):
            retained = True
        while len(chosen) < slots:
            skipped = []
            available_arbiters = len(arbiter_ids) - len(arbiter_ids.intersection(chosen))
            while ranked:
                count, position, teacher = heapq.heappop(ranked)
                if teacher not in chosen and (slots == 1 or available_arbiters > int(teacher in arbiter_ids)):
                    break
                skipped.append((count, position, teacher))
            else:
                raise HTTPException(409, '现有评分与仲裁配置冲突，请调整教师范围')
            chosen.append(teacher)
            heapq.heappush(ranked, (count + 1, position, teacher))
            for entry in skipped:
                heapq.heappush(ranked, entry)
        db.executemany('INSERT INTO review_allocations VALUES(?,?,?,?,?)', [(tid, qid, sid, i+1, u) for i, u in enumerate(chosen)])
        if len(active.get(sid, [])) > slots:
            uid = active[sid][2]['user_id']
            if uid not in arbiter_ids:
                retained = True
            db.execute('INSERT INTO review_allocations VALUES(?,?,?,?,?)', (tid, qid, sid, 3, uid))
    if retained:
        signature = 'retained:' + signature
    db.execute('INSERT INTO allocation_state VALUES(?,?) ON CONFLICT(question_id) DO UPDATE SET signature=excluded.signature', (qid, signature))


def arbitration_needed(db, template, question):
    return db.execute("""SELECT r.submission_id FROM review_results r JOIN objects s ON s.id=r.submission_id
        WHERE r.question_id=? AND r.final_cents IS NULL AND s.deleted=0
        AND json_extract(s.body,'$.template_id')=? AND json_extract(s.body,'$.status')='ready'
        AND NOT EXISTS(SELECT 1 FROM review_allocations a WHERE a.submission_id=r.submission_id AND a.question_id=r.question_id AND a.round=3)
        AND (SELECT COUNT(*) FROM objects t INDEXED BY object_task_answer
             WHERE t.kind='tasks' AND t.deleted=0 AND json_extract(t.body,'$.submission_id')=+r.submission_id
             AND json_extract(t.body,'$.question_id')=+r.question_id AND json_extract(t.body,'$.status')='completed')=2""",
        (question['id'], template['id']))


def allocate_arbitration(db, template, question, assignment):
    if question.get('review_mode', 'single') != 'double':
        return
    _, arbiters = pools(assignment)
    rows = arbitration_needed(db, template, question).fetchall()
    if not rows:return
    counts=dict(db.execute('SELECT user_id,COUNT(*) FROM review_allocations WHERE question_id=? AND round=3 GROUP BY user_id',(question['id'],)))
    for row in rows:
        done = find(db, 'tasks', submission_id=row[0], question_id=question['id'], status='completed')
        if len(done) != 2:
            continue
        used = {t['user_id'] for t in done}
        eligible = set(arbiters) - used
        if not eligible:
            raise HTTPException(409, '仲裁教师均参与了前两评，请管理员调整分配')
        selected=min(eligible,key=lambda u:(counts.get(u,0),u))
        counts[selected]=counts.get(selected,0)+1
        db.execute('INSERT INTO review_allocations VALUES(?,?,?,?,?)', (template['id'], question['id'], row[0], 3, selected))


def progress(db, template_id, question_id, assignment, user_id=None):
    """Report ordinary and arbitration work separately, including retained work."""
    sql = """SELECT a.user_id,a.round,a.submission_id FROM review_allocations a
        JOIN objects s ON s.id=a.submission_id AND s.deleted=0
        WHERE a.template_id=? AND a.question_id=? AND json_extract(s.body,'$.status')='ready'"""
    params = [template_id, question_id]
    filters = dict(template_id=template_id, question_id=question_id, status='completed')
    if user_id is not None:
        sql += ' AND a.user_id=?'
        params.append(user_id)
        filters['user_id'] = user_id
    rows = db.execute(sql, params)
    done = {(t['submission_id'], t['user_id']) for t in find(db,'tasks',**filters)}
    user_ids = participants(assignment)
    if user_id is not None:
        user_ids.intersection_update([user_id])
    teachers={uid:{'user_id':uid,'ordinary_total':0,'ordinary_completed':0,'arbitration_total':0,'arbitration_completed':0} for uid in user_ids}
    for row in rows:
        uid=row['user_id']
        record=teachers.setdefault(uid,{'user_id':uid,'ordinary_total':0,'ordinary_completed':0,'arbitration_total':0,'arbitration_completed':0})
        kind='arbitration' if row['round']==3 else 'ordinary'
        record[kind+'_total']+=1
        record[kind+'_completed']+=int((row['submission_id'],uid) in done)
    for record in teachers.values():
        for kind in ('ordinary','arbitration'):
            record[kind+'_pending']=record[kind+'_total']-record[kind+'_completed']
    return list(teachers.values())


class PreparationRequired(Exception):
    """Retry the entire read against a current write snapshot."""


def check_prepared(db, template, question, assignment):
    if not allocation_current(db, question, assignment, config_signature(question, assignment)):
        raise PreparationRequired
    if question.get('review_mode') == 'double' and arbitration_needed(db, template, question).fetchone():
        raise PreparationRequired


def prepare(db, template, question, assignment):
    ensure(db, template, question, assignment)
    allocate_arbitration(db, template, question, assignment)


def read_progress(reader):
    with connect() as db:
        db.execute('BEGIN')
        try:
            return reader(db, check_prepared)
        except PreparationRequired:
            db.rollback()
        # Re-read both permissions and configuration under the write lock;
        # a deferred SQLite snapshot cannot safely be promoted here.
        db.execute('BEGIN IMMEDIATE')
        return reader(db, prepare)
