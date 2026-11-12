"""Shared request dependencies; usable by workers without importing the web app."""
import hashlib
import secrets
import time
from typing import Annotated
from fastapi import Depends, Header, HTTPException, Request
from .db import connect, get


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    return salt + ':' + hashlib.scrypt(password.encode(),salt=salt.encode(),n=16384,r=8,p=1).hex()


def user(authorization: Annotated[str | None, Header()] = None,request:Request=None):
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(401,'请先登录')
    with connect() as db:
        row=db.execute('SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?',(hashlib.sha256(authorization[7:].encode()).hexdigest(),time.time())).fetchone()
    if row is None:
        raise HTTPException(401,'登录已过期')
    if request is not None:request.state.actor=row['id']
    return dict(row)


def admin(current=Depends(user)):
    if not is_manager(current):
        raise HTTPException(403,'需要管理权限')
    return current


def is_manager(current):return current['role'] in ('admin','manager')


def system_admin(current=Depends(user)):
    if current['role']!='admin':raise HTTPException(403,'需要系统管理员权限')
    return current


def scan_user(authorization:Annotated[str|None,Header()]=None,request:Request=None):
    from .scanner_auth import scan_user as authenticate
    current=authenticate(authorization)
    if request is not None:request.state.actor=current['id']
    return current


def scan_admin(current=Depends(scan_user)):
    if current['role'] not in ('admin','manager','scanner'):raise HTTPException(403,'需要管理人员或扫描设备权限')
    return current


def require(db, identifier, kind):
    obj=get(db,identifier,kind)
    if obj is None:
        raise HTTPException(404,'记录不存在')
    return obj


def scan_batch(db,identifier,current):
    value=require(db,identifier,'scan-batches')
    if current['role']=='scanner' and value.get('scanner_device_id')!=current['id']:raise HTTPException(403,'该批次不属于当前扫描设备')
    return value


