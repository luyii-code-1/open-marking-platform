"""Remove unused school records while retaining audit history."""
import json
from typing import Literal
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, get
from .dependencies import admin, require
from .lifecycle import writable

router = APIRouter(prefix='/api/v1')
KINDS = Literal['room-tags', 'grades', 'classes', 'students', 'users']
LABELS = {'subjects':'科目','groups':'题卡','classes':'班级','students':'学生',
          'rosters':'应考名单','scan-batches':'扫描批次','submissions':'答卷',
          'assignments':'阅卷分工','tasks':'阅卷任务','room-tags':'考场'}


@router.delete('/records/{kind}/{identifier}')
def delete_record(kind: KINDS, identifier: str, current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if kind == 'users':
            row = db.execute('SELECT name,role FROM users WHERE id=?',(identifier,)).fetchone()
            if not row: raise HTTPException(404,'账号不存在')
            if row['role'] != 'teacher': raise HTTPException(403,'只可删除普通教师账号')
            for table in ('scores','review_allocations','regrade_queue'):
                if db.execute(f'SELECT 1 FROM {table} WHERE user_id=? LIMIT 1',(identifier,)).fetchone():
                    raise HTTPException(409,'教师已参与评分或分配了阅卷任务')
        else:
            row = require(db,identifier,kind)
            writable(db,kind,row)
        if kind=='students':
            cls=get(db,row.get('class_id'),'classes') or {}
            if cls.get('grade_id') and any(g.get('roster_mode')!='selected' for g in find(db,'groups',grade_id=cls['grade_id'])):
                raise HTTPException(409,'学生已纳入题卡的年级应考名单')
        # References may be nested in snapshots, lists or maps keyed by the record ID.
        refs=db.execute("""SELECT DISTINCT o.kind FROM objects o,json_tree(o.body) j
            WHERE o.deleted=0 AND o.id<>? AND o.kind NOT IN ('account-events','passkey','auth-challenge','recovery-code')
            AND (j.atom=? OR j.key=?)""",(identifier,identifier,identifier)).fetchall()
        if refs:
            raise HTTPException(409,'记录已被引用：'+'、'.join(LABELS.get(r[0],r[0]) for r in refs))
        if kind=='users':
            db.execute("UPDATE objects SET deleted=1 WHERE kind IN ('passkey','auth-challenge','recovery-code') AND json_extract(body,'$.user_id')=?",(identifier,))
            db.execute('DELETE FROM sessions WHERE user_id=?',(identifier,))
            db.execute('DELETE FROM users WHERE id=?',(identifier,))
        else:
            db.execute('UPDATE objects SET deleted=1 WHERE id=?',(identifier,))
            db.execute('UPDATE identifiers SET retired=1 WHERE id=?',(identifier,))
        db.execute('INSERT INTO audit(id,actor,action,object_id,body) VALUES(?,?,?,?,?)',
                   (str(uuid4()),current['id'],'delete',identifier,json.dumps({'kind':kind,'name':row['name']},ensure_ascii=False)))
        return {'deleted':True}
