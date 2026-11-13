"""Administrator-managed S3 connections; credentials stay encrypted at rest."""
import hashlib
import io
import json
import os
import re
import time
from urllib.parse import urlsplit
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from PIL import Image

from . import db as database
from .db import connect, find, get, objects, put
from .dependencies import admin,system_admin, require

router=APIRouter(prefix='/api/v1')
PUBLIC=('id','name','kind','endpoint','bucket','prefix','region','addressing','media_url','media_enabled','revision','last_test')


def cipher(create=False):
    directory=database.ROOT/'private';path=directory/'storage.key'
    if create:
        directory.mkdir(parents=True,exist_ok=True);directory.chmod(0o700)
        try:
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        except FileExistsError:pass
        else:
            with os.fdopen(fd,'wb') as stream:stream.write(Fernet.generate_key())
    try:return Fernet(path.read_bytes())
    except (FileNotFoundError,ValueError):raise HTTPException(409,'存储凭据密钥不可用，请重新录入连接凭据')


def public(value):
    return {**{k:value.get(k) for k in PUBLIC},'credentials_saved':bool(value.get('credentials'))}


def config(identifier,connection=None):
    if connection is None:
        with connect() as db:value=require(db,identifier,'storage-connections')
    else:value=require(connection,identifier,'storage-connections')
    try:secret=json.loads(cipher().decrypt(value['credentials'].encode()))
    except (InvalidToken,KeyError):raise HTTPException(409,'存储凭据无法解密，请重新录入')
    return {**value,**secret}


def clean_url(value,label,optional=False):
    value=str(value or '').strip().rstrip('/')
    if optional and not value:return ''
    parsed=urlsplit(value)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HTTPException(422,label+'应为不含账号、查询参数的HTTP(S)地址')
    return value


def validated(body,old=None):
    from .storage import safe_key
    value={**(old or {}),**{k:v for k,v in body.items() if k in PUBLIC or k in ('access_key','secret_key')}}
    value['name']=str(value.get('name','')).strip()
    if not value['name'] or len(value['name'])>100:raise HTTPException(422,'请填写100字以内的连接名称')
    if value.get('kind') not in ('s3','ros'):raise HTTPException(422,'连接类型应为S3/MinIO或ROS')
    value['endpoint']=clean_url(value.get('endpoint'),'API端点')
    value['media_url']=clean_url(value.get('media_url'),'媒体访问地址',True)
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]',str(value.get('bucket',''))):raise HTTPException(422,'存储桶名称无效')
    prefix=str(value.get('prefix','omp')).strip('/')
    try:value['prefix']=safe_key(prefix) if prefix else ''
    except ValueError:raise HTTPException(422,'对象前缀无效')
    value['region']=str(value.get('region') or 'us-east-1')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',value['region']):raise HTTPException(422,'区域名称无效')
    value['addressing']=value.get('addressing','path')
    if value['addressing'] not in ('path','virtual'):raise HTTPException(422,'寻址方式无效')
    if not isinstance(value.get('media_enabled',False),bool):raise HTTPException(422,'媒体开关应为布尔值')
    value['media_enabled']=value.get('media_enabled',False)
    if value['media_enabled'] and not value['media_url']:raise HTTPException(422,'开启媒体处理前请填写桶的媒体访问地址')
    for field in ('access_key','secret_key'):
        value[field]=str(body.get(field) or (old or {}).get(field) or '')
        if not value[field] or len(value[field])>4096:raise HTTPException(422,'请填写Access Key与Secret Key；编辑时留空可保留原值')
    return value


@router.get('/storage-connections')
def listing(current=Depends(system_admin)):
    with connect() as db:
        projects=objects(db,'projects')
        return [{**public(v),'project_count':sum(p.get('storage_connection_id')==v['id'] for p in projects)} for v in objects(db,'storage-connections')]


@router.get('/storage-connections/choices')
def choices(current=Depends(admin)):
    with connect() as db:return [{k:v[k] for k in ('id','name','kind','bucket')} for v in objects(db,'storage-connections')]


def save(body,current,identifier=None):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        old=config(identifier,db) if identifier else None
        value=validated(body,old)
        if old and any(value.get(k)!=old.get(k) for k in ('kind','endpoint','bucket','prefix')) and find(db,'storage-assets',connection_id=identifier):
            raise HTTPException(409,'该连接已有文件登记；更换桶、端点或前缀请新增连接，原连接可更新凭据')
        saved={k:value.get(k) for k in PUBLIC if k not in ('id','last_test','revision')}
        saved['revision']=(old or {}).get('revision',0)+1
        saved['credentials']=cipher(True).encrypt(json.dumps({k:value[k] for k in ('access_key','secret_key')}).encode()).decode()
        if identifier:saved['id']=identifier
        return public(put(db,'storage-connections',saved,current['id']))


@router.post('/storage-connections',status_code=201)
def create(body:dict,current=Depends(system_admin)):return save(body,current)


@router.put('/storage-connections/{identifier}')
def update(identifier:str,body:dict,current=Depends(system_admin)):return save(body,current,identifier)


@router.delete('/storage-connections/{identifier}')
def remove(identifier:str,current=Depends(system_admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');require(db,identifier,'storage-connections')
        if find(db,'storage-assets',connection_id=identifier) or find(db,'projects',storage_connection_id=identifier):raise HTTPException(409,'连接仍被考试项目或文件引用，请保留以便读取和清理')
        put(db,'storage-connection-events',{'connection_id':identifier,'action':'deleted'},current['id'])
        db.execute('UPDATE objects SET deleted=1 WHERE id=?',(identifier,))
    return {'status':'deleted'}


@router.put('/projects/{identifier}/storage')
def bind(identifier:str,body:dict,current=Depends(admin)):
    connection_id=body.get('connection_id')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');project=require(db,identifier,'projects')
        if connection_id:require(db,connection_id,'storage-connections')
        project['storage_connection_id']=connection_id or None
        put(db,'projects',project,current['id'])
    return {'project_id':identifier,'connection_id':connection_id or None}


def probe(value,media=False):
    """Only creates/deletes a unique probe object; never lists existing objects."""
    from .storage import Storage
    provider=Storage(settings=value)
    key='_connection-tests/'+str(uuid4())+'.png'
    image=Image.new('RGB',(80,60),'white');image.paste((17,97,183),(10,20,40,40))
    buffer=io.BytesIO();image.save(buffer,'PNG');content=buffer.getvalue()
    client=provider.s3();written=False;phase='write';started=time.monotonic()
    result={'checked_at':time.time(),'object_io':'failed','media':'not_tested'}
    try:
        client.put_object(Bucket=provider.bucket,Key=provider.key(key),Body=content,ContentType='image/png');written=True
        phase='read'
        response=client.get_object(Bucket=provider.bucket,Key=provider.key(key))
        try:data=response['Body'].read()
        finally:response['Body'].close()
        if hashlib.sha256(data).digest()!=hashlib.sha256(content).digest():raise ValueError('Readback mismatch')
        result['object_io']='passed'
        result['object_io_ms']=round((time.monotonic()-started)*1000)
        if media:
            media_started=time.monotonic()
            try:
                data=provider.fetch_crop(key,(10,20,30,20),force=True)
                with Image.open(io.BytesIO(data)) as cropped:
                    if cropped.size!=(30,20) or cropped.convert('RGB').getpixel((0,0))!=(17,97,183):raise ValueError('Media result mismatch')
                result['media']='passed'
            except Exception as error:
                import httpx
                detail='媒体处理未返回预期裁切图，将使用服务器裁切'
                if isinstance(error,ValueError) and str(error).startswith('媒体裁切未生效'):detail=str(error)+'；将使用服务器裁切'
                result.update(media='unavailable',media_message=detail,media_error_type=type(error).__name__)
                if isinstance(error,httpx.HTTPStatusError):result['media_http_status']=error.response.status_code
            finally:result['media_ms']=round((time.monotonic()-media_started)*1000)
    except Exception as error:
        result.update(object_io='failed',stage=phase,error_type=type(error).__name__)
    finally:
        if written:
            try:client.delete_object(Bucket=provider.bucket,Key=provider.key(key));result['test_object_deleted']=True
            except Exception:result.update(object_io='failed',stage='delete',test_object_deleted=False,cleanup_key=provider.key(key))
    return result


@router.post('/storage-connections/test')
def draft_test(body:dict,current=Depends(system_admin)):
    old=config(body['id']) if body.get('id') else None
    return probe(validated(body,old),body.get('test_media') is True)


@router.post('/storage-connections/{identifier}/test')
def saved_test(identifier:str,body:dict,current=Depends(system_admin)):
    value=config(identifier);result=probe(value,body.get('media') is True)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');row=require(db,identifier,'storage-connections')
        if row.get('revision')==value.get('revision'):
            row['last_test']=result;put(db,'storage-connections',row,current['id'])
    return result
