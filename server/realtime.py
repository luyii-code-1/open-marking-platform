"""Authenticated refresh hints from committed audit rows; no business payloads."""
import asyncio
import hashlib
import json
import logging
import os
import time
from contextlib import suppress
from dataclasses import dataclass,field
from fastapi import APIRouter,WebSocket,WebSocketDisconnect
from .db import connect,objects

router=APIRouter(prefix='/api/v1')
logger=logging.getLogger(__name__)
POLL_SECONDS=1
ADMIN_ROOTS={
    'grades':{'grades','classes','students','groups','room-tags','tasks','results','analysis'},
    'classes':{'classes','students','groups','results','analysis','room-tags'},
    'students':{'students','groups','results','analysis','room-tags'},
    'room-tags':{'room-tags','groups','scan-batches','submissions','exceptions','tasks','results','analysis'},
    'tasks':{'tasks','review-progress','dashboard','results','analysis'},
    'assignments':{'assignments','templates','groups','subjects','projects','review-progress','dashboard'},
    'groups':{'groups','results','analysis','review-progress','dashboard'},
    'pages':{'scan-batches','submissions','exceptions','review-progress','results','analysis','dashboard'},
    'scan-batches':{'scan-batches','dashboard'},
    'submissions':{'submissions','scan-batches','exceptions','review-progress','results','analysis','dashboard'},
    'exceptions':{'exceptions','dashboard'},
    'jobs':{'jobs','archives','release-plans','projects'},
    'account-events':{'users','auth'},
    'templates':{'templates','groups','review-progress'},
    'score-conversions':{'score-conversions','groups','analysis','results'},
}


def permissions(db,people):
    scopes={uid:{k:set() for k in ('templates','groups','subjects','projects','classes')} for uid in people}
    templates={t['id']:t for t in objects(db,'templates')}
    groups={g['id']:g for g in objects(db,'groups')}
    subjects={s['id']:s for s in objects(db,'subjects')}
    for assignment in objects(db,'assignments'):
        for uid in set(assignment.get('user_ids',[])+assignment.get('arbitrator_ids',[]))&scopes.keys():
            scope=scopes[uid];tid=assignment['template_id'];scope['templates'].add(tid)
            gid=templates.get(tid,{}).get('group_id');scope['groups'].add(gid)
            sid=groups.get(gid,{}).get('subject_id');scope['subjects'].add(sid)
            scope['projects'].add(subjects.get(sid,{}).get('project_id'))
    for cls in objects(db,'classes'):
        for uid in set(cls.get('teacher_ids',[]))&scopes.keys():scopes[uid]['classes'].add(cls['id'])
    return scopes


def topics(person,scope,previous,kind,body):
    if person['role']=='manager' and kind in ('storage-connections','scanner-devices','score-conversions','database-backups','request-log'):return set()
    if person['role'] in ('admin','manager'):return ADMIN_ROOTS.get(kind,{kind})
    uid=person['id'];merged={k:scope[k]|previous[k] for k in scope}
    tid=body.get('template_id') if kind!='templates' else body.get('id')
    assigned=tid in merged['templates'];own=body.get('user_id')==uid
    if kind=='account-events' and own:return {'auth'}
    if kind=='assignments' and (assigned or uid in body.get('user_ids',[])+body.get('arbitrator_ids',[])):
        return ADMIN_ROOTS['assignments']
    if kind=='tasks' and (assigned or own):return {'review-progress','dashboard','results','analysis'}|({'tasks'} if own else set())
    if kind in ('submissions','templates') and assigned:return {'templates','review-progress','dashboard','results','analysis'}
    if kind=='groups' and (body.get('id') in merged['groups'] or scope['classes']):return {'groups','subjects','projects','review-progress','results','analysis'}
    if kind in ('subjects','projects') and body.get('id') in merged[kind]:return {kind}
    if kind=='classes' and (body.get('id') in merged['classes'] or uid in body.get('teacher_ids',[])):return {'classes','groups','subjects','projects','results','analysis'}
    if kind in ('students','grades','room-tags') and (scope['classes'] or scope['templates']):return {'groups','subjects','projects','tasks','results','analysis','room-tags'}
    if kind=='score-conversions' and scope['classes']:return {'results','analysis'}
    return set()


@dataclass(eq=False)
class Client:
    digest:str
    person:dict
    scope:dict
    start_cursor:int=0
    queue:asyncio.Queue=field(default_factory=lambda:asyncio.Queue(maxsize=2))

    def offer(self,value):
        if self.queue.full():
            while not self.queue.empty():self.queue.get_nowait()
            if value['type']=='invalidate':value={'type':'sync'}
        self.queue.put_nowait(value)


def authenticate(token):
    digest=hashlib.sha256(token.encode()).hexdigest()
    with connect() as db:
        row=db.execute('SELECT u.id,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?',(digest,time.time())).fetchone()
        if not row or row['role'] not in ('admin','manager','teacher'):return None
        person=dict(row)
        scope=permissions(db,{person['id']})[person['id']]
        cursor=db.execute('SELECT COALESCE(MAX(rowid),0) FROM audit').fetchone()[0]
        return Client(digest,person,scope,start_cursor=cursor)


class Hub:
    def __init__(self):self.clients=set();self.cursor=0;self.task=None;self.read_task=None

    async def start(self):
        def latest():
            with connect() as db:return db.execute('SELECT COALESCE(MAX(rowid),0) FROM audit').fetchone()[0]
        self.cursor=await asyncio.to_thread(latest)
        self.task=asyncio.create_task(self.run())
        return self

    async def stop(self):
        for client in tuple(self.clients):client.offer({'type':'closing','code':1001})
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):await self.task
        if self.read_task:
            with suppress(Exception):await self.read_task

    def collect(self,clients):
        with connect() as db:
            people={}
            digests=list({c.digest for c in clients})
            for offset in range(0,len(digests),400):
                chunk=digests[offset:offset+400]
                sql='SELECT s.token,u.id,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires>? AND s.token IN ('+','.join('?' for _ in chunk)+')'
                for row in db.execute(sql,[time.time(),*chunk]):people[row['token']]={k:row[k] for k in ('id','name','role')}
            rows=db.execute('SELECT a.rowid,a.body,o.kind FROM audit a LEFT JOIN objects o ON o.id=a.object_id WHERE a.rowid>? ORDER BY a.rowid LIMIT 1500',(self.cursor,)).fetchall()
            scopes=permissions(db,{p['id'] for p in people.values()}) if rows else {}
            changes=[]
            events=[(r['kind'],json.loads(r['body'])) for r in rows if r['kind']]
            for client in clients:
                person=people.get(client.digest)
                if not person or person['role']!=client.person['role']:
                    changes.append((client,None,None,None));continue
                scope=scopes.get(person['id'],client.scope);roots=set()
                if person['name']!=client.person['name']:roots.add('auth')
                for kind,body in events:roots.update(topics(person,scope,client.scope,kind,body))
                changes.append((client,person,scope,roots))
            return rows[-1]['rowid'] if rows else self.cursor,changes

    async def run(self):
        while True:
            await asyncio.sleep(POLL_SECONDS)
            clients=tuple(self.clients)
            if not clients:continue
            try:
                self.read_task=asyncio.create_task(asyncio.to_thread(self.collect,clients))
                cursor,changes=await asyncio.shield(self.read_task)
            except Exception:
                logger.warning('实时通知读取暂时失败，保留位置后重试',exc_info=False);continue
            self.cursor=cursor
            for client,person,scope,roots in changes:
                if client not in self.clients:continue
                if person is None:
                    client.offer({'type':'closing','code':4401});self.clients.discard(client)
                else:
                    client.person=person;client.scope=scope
                    if roots:client.offer({'type':'invalidate','roots':sorted(roots)})


def allowed_origin(origin):
    domain=os.getenv('OMP_DOMAIN','localhost')
    defaults='http://localhost:5173,http://localhost:8000,http://127.0.0.1:5173,http://127.0.0.1:8000,https://localhost' if domain=='localhost' else 'https://'+domain
    allowed={v.strip() for v in os.getenv('OMP_WS_ORIGINS',defaults).split(',') if v.strip()}
    return origin in allowed


@router.websocket('/events')
async def events(socket:WebSocket):
    if not allowed_origin(socket.headers.get('origin')) or socket.query_params:
        await socket.close(code=1008);return
    await socket.accept()
    client=None;workers=[]
    try:
        text=await asyncio.wait_for(socket.receive_text(),timeout=5)
        if len(text)>2048:await socket.close(code=1009);return
        try:body=json.loads(text)
        except (ValueError,TypeError,RecursionError):await socket.close(code=1008);return
        if not isinstance(body,dict) or body.get('type')!='auth' or not isinstance(body.get('token'),str) or not 1<=len(body['token'])<=256:
            await socket.close(code=4401);return
        client=await asyncio.to_thread(authenticate,body['token'])
        if not client:await socket.close(code=4401);return
        hub=socket.app.state.event_hub
        if not hub.clients:hub.cursor=max(hub.cursor,client.start_cursor)
        hub.clients.add(client)
        await socket.send_json({'type':'ready'})
        async def sender():
            while True:
                try:value=await asyncio.wait_for(client.queue.get(),timeout=20)
                except asyncio.TimeoutError:value={'type':'ping'}
                if value['type']=='closing':await socket.close(code=value['code']);return
                await asyncio.wait_for(socket.send_json(value),timeout=5)
        async def receiver():
            while True:
                value=await socket.receive_text()
                if len(value)>2048:await socket.close(code=1009);return
                if value!='{"type":"pong"}':await socket.close(code=1008);return
        workers=[asyncio.create_task(sender()),asyncio.create_task(receiver())]
        done,_=await asyncio.wait(workers,return_when=asyncio.FIRST_COMPLETED)
        for task in done:task.result()
    except (WebSocketDisconnect,asyncio.TimeoutError,KeyError,UnicodeDecodeError):
        with suppress(RuntimeError,WebSocketDisconnect):await socket.close(code=1008)
    finally:
        if client:socket.app.state.event_hub.clients.discard(client)
        for task in workers:task.cancel()
        if workers:await asyncio.gather(*workers,return_exceptions=True)
