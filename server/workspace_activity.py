"""Small summaries for workspace activity and service-wide latency notifications."""
import time
import json
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends
from .db import connect, objects
from .dependencies import user, admin

router=APIRouter(prefix='/api/v1')


@router.get('/workspace/activity')
def activity(current=Depends(admin)):
    with connect() as db:
        projects=objects(db,'projects');subjects={s['id']:s for s in objects(db,'subjects')}
        groups=objects(db,'groups');templates={t['id']:t for t in objects(db,'templates')}
        tasks=objects(db,'tasks');progress={}
        group_map={g['id']:g for g in groups}
        for task in tasks:
            group=group_map.get(templates.get(task.get('template_id'),{}).get('group_id'))
            if not group:continue
            pid=subjects.get(group.get('subject_id'),{}).get('project_id')
            counts=progress.setdefault(pid,{'completed':0,'total':0});counts['total']+=1
            if task.get('status')=='completed':counts['completed']+=1
        exams=[]
        for project in projects:
            cohort=[g for g in groups if subjects.get(g.get('subject_id'),{}).get('project_id')==project['id']]
            counts=progress.get(project['id'],{'completed':0,'total':0})
            exams.append({'id':project['id'],'name':project['name'],'exam_status':project.get('exam_status','in_progress'),
                          'cards':len(cohort),'published':sum(bool(g.get('frozen')) for g in cohort),**counts})
        # Only administrators see all users' activity. Summaries omit audit payloads.
        events=[]
        if current['role']=='admin':
            for row in db.execute('SELECT a.rowid AS cursor,a.action,a.created,a.body,o.kind,u.name AS actor_name FROM audit a LEFT JOIN objects o ON o.id=a.object_id LEFT JOIN users u ON u.id=a.actor ORDER BY a.rowid DESC LIMIT 30'):
                item=dict(row);body=json.loads(item.pop('body'))
                if item.get('kind')=='tasks' and body.get('status')=='completed':
                    amount=body.get('score_cents')
                    item['detail']='评阅 '+str(amount/100)+' 分' if isinstance(amount,(int,float)) else '完成评阅'
                events.append(item)
        jobs=[j for j in objects(db,'jobs') if j.get('status') in ('pending','running','failed')]
        return {'exams':exams,'events':events,'jobs':jobs[-50:]}


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
