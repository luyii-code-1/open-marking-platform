"""Scanner downloads and one-time enrollment without exposing login sessions."""
import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.exceptions import UnsupportedAlgorithm
from . import db as database
from .db import connect, find, get, put
from .dependencies import admin, is_manager, require
from .scanner_auth import active, decode, encode, public

router=APIRouter(prefix='/api/v1/scanner')


@router.get('/my-devices')
def own_devices(current=Depends(admin)):
    with connect() as db:return [public(v) for v in find(db,'scanner-devices',owner_id=current['id'])]


def distribution():
    root=Path(os.getenv('OMP_SCANNER_DISTRIBUTION',database.ROOT/'scanner-distribution')).resolve()
    try:
        value=json.loads((root/'release.json').read_text(encoding='utf-8'))
        name=value['file']
        if not isinstance(name,str) or Path(name).name!=name or '/' in name or '\\' in name or not name.lower().endswith('.exe'):raise ValueError()
        path=(root/name).resolve()
        if path.parent!=root or not path.is_file() or path.stat().st_size!=value['size']:raise ValueError()
        if len(value['sha256'])!=64:raise ValueError()
        return value,path
    except (OSError,ValueError,KeyError,TypeError):raise HTTPException(404,'扫描端安装包尚未发布，请联系系统管理员')


@router.get('/distribution')
def package_info(current=Depends(admin)):
    try:value,_=distribution()
    except HTTPException:return {'available':False}
    return {**{k:value[k] for k in ('file','size','sha256','version')},'available':True}


@router.post('/download-link')
def download_link(current=Depends(admin)):
    value,_=distribution();token=secrets.token_urlsafe(32)
    with connect() as db:put(db,'scanner-downloads',{'token_hash':hashlib.sha256(token.encode()).hexdigest(),'owner_id':current['id'],'sha256':value['sha256'],'expires_at':time.time()+120},current['id'])
    return {'url':'/api/v1/scanner/download/'+token}


@router.get('/download/{token}')
def download_package(token:str):
    with connect() as db:
        ticket=next(iter(find(db,'scanner-downloads',token_hash=hashlib.sha256(token.encode()).hexdigest())),None)
        owner=db.execute('SELECT role FROM users WHERE id=?',((ticket or {}).get('owner_id'),)).fetchone()
        if not ticket or ticket['expires_at']<time.time() or not owner or not is_manager(owner):raise HTTPException(403,'下载链接已过期，请重新下载')
    value,path=distribution()
    if ticket['sha256']!=value['sha256']:raise HTTPException(409,'安装包版本已更新，请重新下载')
    return FileResponse(path,filename=value['file'],media_type='application/octet-stream',headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'})


@router.post('/pairings',status_code=201)
def create_pairing(current=Depends(admin)):
    code=''.join(secrets.choice('23456789ABCDEFGHJKLMNPQRSTUVWXYZ') for _ in range(12))
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        for old in find(db,'scanner-pairings',owner_id=current['id']):
            if not old.get('used') and old['expires_at']>time.time():old['used']=True;old['cancelled']=True;put(db,'scanner-pairings',old,current['id'])
        pairing=put(db,'scanner-pairings',{'owner_id':current['id'],'code_hash':hashlib.sha256(code.encode()).hexdigest(),'expires_at':time.time()+600,'used':False},current['id'])
    return {'id':pairing['id'],'code':'-'.join(code[i:i+4] for i in range(0,12,4)),'expires_at':pairing['expires_at'],'owner_name':current['name']}


@router.get('/pairings/{identifier}')
def pairing_status(identifier:str,current=Depends(admin)):
    with connect() as db:
        value=require(db,identifier,'scanner-pairings')
        if value['owner_id']!=current['id'] and current['role']!='admin':raise HTTPException(403,'配对请求不属于当前账号')
        device=get(db,value.get('device_id'),'scanner-devices')
        return {'id':value['id'],'status':'paired' if device else 'cancelled' if value.get('cancelled') else 'expired' if value['expires_at']<time.time() else 'waiting','device':public(device) if device else None,'expires_at':value['expires_at']}


@router.post('/pair')
def redeem(body:dict,request:Request):
    peer=hashlib.sha256((request.client.host if request.client else 'unknown').encode()).hexdigest()
    code=str(body.get('code','')).upper().replace('-','').replace(' ','')
    # Persist rate accounting before validation so failed attempts cannot roll it back.
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if sum(v['created_at']>time.time()-60 for v in find(db,'scanner-pair-attempts',peer=peer))>=20:raise HTTPException(429,'配对尝试过于频繁，请稍后重试')
        put(db,'scanner-pair-attempts',{'peer':peer,'created_at':time.time()})
    try:
        raw=decode(body.get('public_key'));key=serialization.load_der_public_key(raw)
        if not isinstance(key,ec.EllipticCurvePublicKey) or not isinstance(key.curve,ec.SECP256R1):raise ValueError()
    except (ValueError,TypeError,UnsupportedAlgorithm):raise HTTPException(422,'设备公钥无效')
    label=str(body.get('label','')).strip()
    if not 1<=len(label)<=100:raise HTTPException(422,'设备名称需1至100字')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        value=next(iter(find(db,'scanner-pairings',code_hash=hashlib.sha256(code.encode()).hexdigest())),None)
        if not value or value['used'] or value['expires_at']<time.time():raise HTTPException(403,'配对码无效、已使用或已过期')
        owner=db.execute('SELECT id,name,role FROM users WHERE id=?',(value['owner_id'],)).fetchone()
        if not owner or not is_manager(owner):raise HTTPException(403,'配对账号的管理权限已失效')
        fingerprint=hashlib.sha256(raw).hexdigest();old=find(db,'scanner-devices',fingerprint=fingerprint)
        if old:
            device=active(db,old[0]['id'])
            if device['owner_id']!=owner['id']:raise HTTPException(409,'设备已绑定其他账号，请联系系统管理员处理')
        else:device=put(db,'scanner-devices',{'label':label,'public_key':encode(raw),'fingerprint':fingerprint,'owner_id':owner['id'],'algorithm':'ES256','revoked':False,'created_at':time.time()},owner['id'])
        value.update(used=True,device_id=device['id']);put(db,'scanner-pairings',value,owner['id'])
        return {'device':public(device),'owner_name':owner['name']}
