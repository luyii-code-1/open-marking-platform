import base64
import hashlib
import hmac
import re
import secrets
import time
from fastapi import APIRouter,Depends,HTTPException,Request
from cryptography.hazmat.primitives import serialization,hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.exceptions import InvalidSignature,UnsupportedAlgorithm
from .db import connect,find,get,objects,put
from .dependencies import admin,system_admin,user,require,password_hash

router=APIRouter(prefix='/api/v1/scanner')


def encode(value):return base64.urlsafe_b64encode(value).decode().rstrip('=')


def decode(value,limit=500):
    if not isinstance(value,str) or not 1<=len(value)<=limit or not re.fullmatch(r'[A-Za-z0-9_-]+',value):raise ValueError('编码无效')
    return base64.urlsafe_b64decode(value+'='*(-len(value)%4))


def active(db,identifier):
    device=require(db,identifier,'scanner-devices')
    owner=db.execute('SELECT role FROM users WHERE id=?',(device['owner_id'],)).fetchone()
    if device.get('revoked') or not owner or owner['role'] not in ('admin','manager'):raise HTTPException(403,'扫描设备授权已停用，请联系管理员')
    return device


def public(device):return {k:v for k,v in device.items() if k!='public_key'}


@router.get('/devices')
def devices(current=Depends(system_admin)):
    with connect() as db:return [public(d) for d in objects(db,'scanner-devices')]


@router.post('/devices')
def enroll(body:dict,current=Depends(admin)):
    try:
        encoded=decode(body.get('public_key'))
        key=serialization.load_der_public_key(encoded)
        if not isinstance(key,ec.EllipticCurvePublicKey) or not isinstance(key.curve,ec.SECP256R1):raise ValueError('需要P-256公钥')
    except (ValueError,TypeError,UnsupportedAlgorithm):raise HTTPException(422,'设备公钥无效，需要P-256 SPKI DER')
    label=str(body.get('label','')).strip()
    if not 1<=len(label)<=100:raise HTTPException(422,'请填写设备名称，最多100字')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        stored=db.execute('SELECT password FROM users WHERE id=?',(current['id'],)).fetchone()[0]
        if not hmac.compare_digest(stored,password_hash(str(body.get('password','')),stored.split(':')[0])):raise HTTPException(403,'需要重新验证管理员密码')
        fingerprint=hashlib.sha256(encoded).hexdigest()
        old=find(db,'scanner-devices',fingerprint=fingerprint)
        if old:return public(active(db,old[0]['id']))
        return public(put(db,'scanner-devices',{'label':label,'public_key':encode(encoded),'fingerprint':fingerprint,'owner_id':current['id'],'algorithm':'ES256','revoked':False,'created_at':time.time()},current['id']))


@router.post('/devices/{identifier}/status')
def set_status(identifier:str,body:dict,current=Depends(system_admin)):
    if type(body.get('enabled')) is not bool or not str(body.get('reason','')).strip():raise HTTPException(422,'请明确启用状态并填写原因')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');device=require(db,identifier,'scanner-devices')
        if body['enabled']:
            stored=db.execute('SELECT password FROM users WHERE id=?',(current['id'],)).fetchone()[0]
            if not hmac.compare_digest(stored,password_hash(str(body.get('password','')),stored.split(':')[0])):raise HTTPException(403,'重新启用需要验证管理员密码')
            device['owner_id']=current['id']
        device.update(revoked=not body['enabled'],status_reason=body['reason'])
        for session in find(db,'scanner-sessions',device_id=identifier):
            if not session.get('revoked'):session['revoked']=True;put(db,'scanner-sessions',session,current['id'])
        return public(put(db,'scanner-devices',device,current['id']))


@router.post('/devices/{identifier}/adopt-batches')
def adopt(identifier:str,body:dict,current=Depends(system_admin)):
    ids=body.get('batch_ids',[])
    if not isinstance(ids,list) or len(ids)>1000 or any(not isinstance(i,str) for i in ids):raise HTTPException(422,'批次列表无效')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');active(db,identifier)
        batches=[require(db,i,'scan-batches') for i in set(ids)]
        for batch in batches:
            if batch.get('scanner_device_id') in (None,identifier):continue
            old=get(db,batch['scanner_device_id'],'scanner-devices')
            if not old or not old.get('revoked') or body.get('migrate_revoked') is not True or not str(body.get('reason','')).strip():raise HTTPException(409,'批次归属其他设备；迁移需先停用旧设备并由管理员明确确认')
        for batch in batches:
            if batch.get('scanner_device_id')!=identifier:
                batch['scanner_device_id']=identifier
                if body.get('migrate_revoked'):batch['device_migration_reason']=body['reason']
                put(db,'scan-batches',batch,current['id'])
    return {'adopted':len(batches)}


@router.post('/challenge')
def challenge(body:dict):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');device=active(db,body.get('device_id'))
        recent=[c for c in find(db,'scanner-challenges',device_id=device['id']) if c['created_at']>time.time()-60]
        if len(recent)>=5:raise HTTPException(429,'设备验证请求过于频繁，请稍后重试')
        value=put(db,'scanner-challenges',{'device_id':device['id'],'nonce':secrets.token_urlsafe(32),'created_at':time.time(),'expires_at':time.time()+60,'used':False})
        return {k:value[k] for k in ('id','device_id','nonce','expires_at')}


def message(challenge):return ('OMP-SCANNER-1\n'+challenge['id']+'\n'+challenge['nonce']+'\n'+challenge['device_id']).encode('utf-8')


@router.post('/authenticate')
def authenticate(body:dict,request:Request=None):
    # Consume the challenge in its own committed transaction, including failures.
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');value=require(db,body.get('challenge_id'),'scanner-challenges');device=active(db,value['device_id'])
        if value['used'] or value['expires_at']<time.time():raise HTTPException(409,'设备挑战已使用或过期')
        value['used']=True;put(db,'scanner-challenges',value)
    try:
        key=serialization.load_der_public_key(decode(device['public_key']))
        key.verify(decode(body.get('signature'),200),message(value),ec.ECDSA(hashes.SHA256()))
    except (InvalidSignature,ValueError,TypeError):raise HTTPException(403,'设备签名验证失败')
    token=secrets.token_urlsafe(40)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');device=active(db,device['id'])
        put(db,'scanner-sessions',{'device_id':device['id'],'token_hash':hashlib.sha256(token.encode()).hexdigest(),'expires_at':time.time()+900},device['id'])
        device['last_authenticated_at']=time.time();put(db,'scanner-devices',device,device['id'])
    if request is not None:request.state.actor=device['id']
    return {'token':token,'expires_in':900,'device':public(device)}


def scan_user(authorization):
    try:return user(authorization)
    except HTTPException as error:
        if error.status_code!=401:raise
    if not authorization or not authorization.startswith('Bearer '):raise HTTPException(401,'请连接已注册扫描设备')
    digest=hashlib.sha256(authorization[7:].encode()).hexdigest()
    with connect() as db:
        sessions=find(db,'scanner-sessions',token_hash=digest)
        if not sessions or sessions[0]['expires_at']<time.time():raise HTTPException(401,'设备连接已过期，请重新连接')
        device=active(db,sessions[0]['device_id'])
        if sessions[0].get('revoked'):raise HTTPException(401,'旧设备连接已失效，请重新连接')
        return {'id':device['id'],'role':'scanner','device_id':device['id'],'owner_id':device['owner_id']}
