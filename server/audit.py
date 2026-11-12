import json
from fastapi import APIRouter,Depends,Query,Request
from .db import connect
from .dependencies import system_admin,admin

router=APIRouter(prefix='/api/v1/system')
HIDDEN={'password','new_password','token','token_hash','digest','public_key','private_key','challenge','nonce','credential_id','secret','secret_key'}


def redact(value):
    if isinstance(value,dict):return {k:'[已隐藏]' if k.lower() in HIDDEN else redact(v) for k,v in value.items()}
    if isinstance(value,list):return [redact(v) for v in value]
    return value


def filters(before,actor,object_id):
    clauses=[];params=[]
    if before is not None:clauses.append('a.rowid<?');params.append(before)
    if actor:clauses.append('a.actor=?');params.append(actor)
    if object_id:clauses.append('a.object_id=?');params.append(object_id)
    return clauses,params


@router.get('/audit')
def audits(before:int|None=Query(None,ge=1),limit:int=Query(50,ge=1,le=200),actor:str=Query('',max_length=100),object_id:str=Query('',max_length=100),kind:str=Query('',max_length=100),action:str=Query('',max_length=100),current=Depends(system_admin)):
    clauses,params=filters(before,actor,object_id)
    if kind:clauses.append('o.kind=?');params.append(kind)
    if action:clauses.append('a.action=?');params.append(action)
    where=' WHERE '+' AND '.join(clauses) if clauses else ''
    with connect() as db:
        rows=db.execute('SELECT a.rowid AS cursor,a.*,o.kind,u.name AS actor_name FROM audit a LEFT JOIN objects o ON o.id=a.object_id LEFT JOIN users u ON u.id=a.actor'+where+' ORDER BY a.rowid DESC LIMIT ?',[*params,limit+1]).fetchall()
    items=[{**dict(row),'body':redact(json.loads(row['body']))} for row in rows[:limit]]
    return {'items':items,'next_before':items[-1]['cursor'] if len(rows)>limit else None}


@router.get('/requests')
def requests(request:Request,before:int|None=Query(None,ge=1),limit:int=Query(50,ge=1,le=200),actor:str=Query('',max_length=100),object_id:str=Query('',max_length=100),status:int|None=Query(None,ge=100,le=599),current=Depends(system_admin)):
    journal=request.app.state.request_journal;journal.flush()
    clauses,params=filters(before,actor,object_id)
    if status is not None:clauses.append('a.status=?');params.append(status)
    where=' WHERE '+' AND '.join(clauses) if clauses else ''
    with connect() as db:
        rows=db.execute('SELECT a.seq AS cursor,a.*,u.name AS actor_name FROM request_log a LEFT JOIN users u ON u.id=a.actor'+where+' ORDER BY a.seq DESC LIMIT ?',[*params,limit+1]).fetchall()
    items=[dict(row) for row in rows[:limit]]
    return {'items':items,'next_before':items[-1]['cursor'] if len(rows)>limit else None,'writer_errors':journal.errors,'queued':journal.queue.qsize()}
