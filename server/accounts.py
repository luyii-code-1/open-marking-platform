import hashlib
import hmac
import secrets
import time
from fastapi import APIRouter,Depends,HTTPException,Header,Request
from .db import connect,find,put
from .dependencies import user,require,password_hash

router=APIRouter(prefix='/api/v1')


def session(db,person,method):
    token=secrets.token_urlsafe(40)
    db.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),person['id'],time.time()+43200))
    put(db,'account-events',{'user_id':person['id'],'action':'login','method':method},person['id'])
    return {'token':token,'user':{k:person[k] for k in ('id','username','name','role')}}


def verify_password(db,current,password):
    if not isinstance(password,str) or len(password)>200:raise HTTPException(422,'密码无效')
    row=db.execute('SELECT password FROM users WHERE id=?',(current['id'],)).fetchone()
    if not row or not hmac.compare_digest(row['password'],password_hash(password,row['password'].split(':')[0])):raise HTTPException(403,'当前密码不正确')


@router.post('/auth/logout')
def logout(authorization:str=Header(),current=Depends(user)):
    with connect() as db:
        db.execute('DELETE FROM sessions WHERE token=?',(hashlib.sha256(authorization[7:].encode()).hexdigest(),))
        put(db,'account-events',{'user_id':current['id'],'action':'logout'},current['id'])
    return {'status':'logged_out'}


@router.put('/auth/profile')
def profile(body:dict,current=Depends(user)):
    name=str(body.get('name','')).strip()
    if not 1<=len(name)<=100:raise HTTPException(422,'姓名长度应为1至100字符')
    with connect() as db:
        db.execute('UPDATE users SET name=? WHERE id=?',(name,current['id']))
        put(db,'account-events',{'user_id':current['id'],'action':'rename','name':name},current['id'])
    return {**current,'name':name}


@router.post('/auth/password')
def change_password(body:dict,current=Depends(user)):
    new=body.get('new_password','')
    if not isinstance(new,str) or not 10<=len(new)<=200:raise HTTPException(422,'新密码需10至200字符')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');verify_password(db,current,body.get('password',''))
        db.execute('UPDATE users SET password=? WHERE id=?',(password_hash(new),current['id']))
        db.execute('DELETE FROM sessions WHERE user_id=?',(current['id'],))
        put(db,'account-events',{'user_id':current['id'],'action':'password_changed'},current['id'])
    return {'status':'changed'}


@router.post('/auth/recovery-codes')
def recovery_codes(body:dict,current=Depends(user)):
    codes=[secrets.token_hex(10) for _ in range(8)]
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');verify_password(db,current,body.get('password',''))
        for old in find(db,'recovery-code',user_id=current['id']):old['used']=True;put(db,'recovery-code',old,current['id'])
        for code in codes:put(db,'recovery-code',{'user_id':current['id'],'digest':hashlib.sha256(code.encode()).hexdigest(),'used':False},current['id'])
    return {'codes':codes}


@router.post('/auth/recovery-login')
def recovery_login(body:dict,request:Request=None):
    code=body.get('code','')
    if not isinstance(code,str) or len(code)>100:raise HTTPException(401,'账号或恢复码错误')
    digest=hashlib.sha256(code.encode()).hexdigest()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('SELECT id,username,name,role FROM users WHERE username=?',(str(body.get('username','')),)).fetchone()
        match=next((r for r in find(db,'recovery-code',user_id=row['id']) if not r['used'] and hmac.compare_digest(r['digest'],digest)),None) if row else None
        if not match:raise HTTPException(401,'账号或恢复码错误')
        match['used']=True;put(db,'recovery-code',match,row['id'])
        if request is not None:request.state.actor=row['id']
        return session(db,dict(row),'recovery_code')
