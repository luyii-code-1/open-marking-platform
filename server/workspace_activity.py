"""Small summaries for workspace activity and service-wide latency notifications."""
import time
import json
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends
from .db import connect, objects
from .dependencies import user, admin

router=APIRouter(prefix='/api/v1')


_activity_cache = {}


@router.get('/workspace/activity')
def activity(current=Depends(admin)):
    role = current['role']
    now = time.monotonic()
    cached = _activity_cache.get(role)
    if cached and now - cached[0] < 3:
        return cached[1]
    with connect() as db:
        projects=objects(db,'projects');subjects={s['id']:s for s in objects(db,'subjects')}
        groups=objects(db,'groups')
        template_to_group={r[0]:r[1] for r in db.execute("SELECT id,json_extract(body,'$.group_id') FROM objects WHERE kind='templates' AND deleted=0")}
        group_map={g['id']:g for g in groups}
        progress={}
        for tid, status, cnt in db.execute("SELECT json_extract(body,'$.template_id'),json_extract(body,'$.status'),COUNT(*) FROM objects WHERE kind='tasks' AND deleted=0 GROUP BY 1,2"):
            group=group_map.get(template_to_group.get(tid))
            if not group:continue
            pid=subjects.get(group.get('subject_id'),{}).get('project_id')
            counts=progress.setdefault(pid,{'completed':0,'total':0});counts['total']+=cnt
            if status=='completed':counts['completed']+=cnt
        exams=[]
        for project in projects:
            cohort=[g for g in groups if subjects.get(g.get('subject_id'),{}).get('project_id')==project['id']]
            counts=progress.get(project['id'],{'completed':0,'total':0})
            exams.append({'id':project['id'],'name':project['name'],'exam_status':project.get('exam_status','in_progress'),
                          'cards':len(cohort),'published':sum(bool(g.get('frozen')) for g in cohort),**counts})
        # Only administrators see all users' activity. Summaries omit audit payloads.
        events=[]
        if role=='admin':
            for row in db.execute('SELECT a.rowid AS cursor,a.action,a.created,a.body,o.kind,u.name AS actor_name FROM audit a LEFT JOIN objects o ON o.id=a.object_id LEFT JOIN users u ON u.id=a.actor ORDER BY a.rowid DESC LIMIT 10'):
                item=dict(row);body=json.loads(item.pop('body'))
                if item.get('kind')=='tasks' and body.get('status')=='completed':
                    amount=body.get('score_cents')
                    item['detail']='评阅 '+str(amount/100)+' 分' if isinstance(amount,(int,float)) else '完成评阅'
                events.append(item)
        job_rows=db.execute("SELECT body FROM objects WHERE kind='jobs' AND deleted=0 AND json_extract(body,'$.status') IN ('pending','running','failed') ORDER BY rowid DESC LIMIT 50").fetchall()
        jobs=[json.loads(r['body']) for r in reversed(job_rows)]
        payload={'exams':exams,'events':events,'jobs':jobs}
        _activity_cache[role]=(now,payload)
        return payload


_cached=(0,None)


@router.get('/system/service-status')
def service_status(current=Depends(user)):
    global _cached
    now=time.monotonic()
    if _cached[1] is not None and now-_cached[0]<10:return _cached[1]
    cutoff=(datetime.now(timezone.utc)-timedelta(seconds=90)).isoformat(timespec='milliseconds')
    with connect() as db:
        recent=db.execute('SELECT duration_ms,status,created,route FROM request_log ORDER BY seq DESC LIMIT 2000').fetchall()
    samples=[r for r in recent if r['created']>=cutoff and r['route'] not in ('/api/v1/system/service-status','/api/v1/system/build')]
    durations=sorted(r['duration_ms'] for r in samples)
    p95=durations[min(len(durations)-1,int(len(durations)*.95))] if durations else 0
    errors=sum(r['status']>=500 for r in samples)
    slow=len(samples)>=10 and (p95>=1500 or errors/max(1,len(samples))>=.2)
    result={'state':'slow' if slow else 'normal','p95_ms':round(p95),'samples':len(samples),'checked_at':time.time()}
    _cached=(now,result)
    return result
