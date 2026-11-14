"""Persistent weighted allocations; caller holds the SQLite write transaction."""
import hashlib
import json
import time

from fastapi import HTTPException
from .db import find


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
    ready = db.execute("SELECT COUNT(*),MAX(rowid) FROM objects INDEXED BY object_submission WHERE kind='submissions' AND deleted=0 AND json_extract(body,'$.template_id')=? AND json_extract(body,'$.status')='ready'", (tid,)).fetchone()
    signature = hashlib.sha256(json.dumps(['equal-v1',assignment, list(ready), question.get('review_mode', 'single')], sort_keys=True).encode()).hexdigest()
    old = db.execute('SELECT signature FROM allocation_state WHERE question_id=?', (qid,)).fetchone()
    if old and old[0] == signature:
        return
    validate(assignment, question)
    ordinary, arbiters = pools(assignment)
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
    for sid, pinned in records:
        chosen = [t['user_id'] for t in pinned]
        while len(chosen) < slots:
            eligible = [u for u in ordinary if u not in chosen and (slots == 1 or set(arbiters) - set(chosen) - {u})]
            if not eligible:
                raise HTTPException(409, '现有评分与仲裁配置冲突，请调整教师范围')
            selected = min(eligible, key=lambda u: (counts[u],ordinary.index(u)))
            chosen.append(selected)
            counts[selected] += 1
        db.executemany('INSERT INTO review_allocations VALUES(?,?,?,?,?)', [(tid, qid, sid, i+1, u) for i, u in enumerate(chosen)])
        if len(active.get(sid, [])) > slots:
            db.execute('INSERT INTO review_allocations VALUES(?,?,?,?,?)', (tid, qid, sid, 3, active[sid][2]['user_id']))
    db.execute('INSERT INTO allocation_state VALUES(?,?) ON CONFLICT(question_id) DO UPDATE SET signature=excluded.signature', (qid, signature))


def allocate_arbitration(db, template, question, assignment):
    if question.get('review_mode', 'single') != 'double':
        return
    _, arbiters = pools(assignment)
    rows = db.execute('''SELECT r.submission_id FROM review_results r JOIN objects s ON s.id=r.submission_id
        WHERE r.question_id=? AND r.final_cents IS NULL AND s.deleted=0
        AND json_extract(s.body,'$.template_id')=? AND json_extract(s.body,'$.status')='ready'
        AND NOT EXISTS(SELECT 1 FROM review_allocations a WHERE a.submission_id=r.submission_id AND a.question_id=r.question_id AND a.round=3)''', (question['id'], template['id'])).fetchall()
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
