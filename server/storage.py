import os
import hashlib
import json
import time
import threading
from uuid import uuid4
import posixpath
from pathlib import PurePosixPath
from urllib.parse import quote, urlencode
import httpx
from . import db as database
from .db import connect,objects,put,find,get


def safe_key(key):
    path=PurePosixPath(key)
    if not key or not path.parts or path.is_absolute() or '..' in path.parts or '\\' in key or ':' in key or any(ord(c)<32 for c in key):raise ValueError('储存路径无效')
    return str(path)


def local_path(relative):
    path=(database.ROOT/safe_key(relative)).resolve()
    if not path.is_relative_to(database.ROOT.resolve()):raise ValueError('储存路径超出数据目录')
    return path


def expected_hash(db,relative):
    parts=relative.split('/')
    if len(parts)!=2 or parts[0] not in ('pages','assets') or '.' not in parts[1]:return None
    identifier,suffix=parts[1].split('.',1);record=get(db,identifier,parts[0]) or {}
    from .scan_files import hash_field
    field=hash_field('.'+suffix) if parts[0]=='pages' else 'sha256'
    return record.get(field)


def backend():return os.getenv('OMP_STORAGE','local')


def location():
    keys=('OMP_STORAGE','OMP_STORAGE_PREFIX','OMP_S3_ENDPOINT','OMP_S3_BUCKET','OMP_SFTP_HOST','OMP_SFTP_PORT','OMP_SFTP_ROOT','OMP_WEBDAV_URL')
    return hashlib.sha256(json.dumps({k:os.getenv(k,'') for k in keys},sort_keys=True).encode()).hexdigest()


class Storage:
    def __init__(self,project_id=None,connection_id=None,settings=None):
        if project_id and not connection_id:
            with connect() as db:connection_id=(get(db,project_id,'projects') or {}).get('storage_connection_id')
        if connection_id and settings is None:
            from .storage_connections import config
            settings=config(connection_id)
        self.settings=settings or {}
        self.connection_id=connection_id or self.settings.get('id')
        self.kind=self.settings.get('kind',backend())
        self.prefix=self.settings.get('prefix',os.getenv('OMP_STORAGE_PREFIX','omp')).strip('/')
        self.bucket=self.settings.get('bucket',os.getenv('OMP_S3_BUCKET'))
        if self.kind not in ('local','s3','ros','webdav','sftp'):raise ValueError('储存后端无效')
    def location(self):
        if not self.connection_id:return location()
        return hashlib.sha256(json.dumps({k:self.settings.get(k) for k in ('kind','endpoint','bucket','prefix')},sort_keys=True).encode()).hexdigest()
    def key(self,key):return '/'.join(filter(None,[self.prefix,safe_key(key)]))
    def s3(self):
        import boto3
        from botocore.config import Config
        return boto3.client('s3',endpoint_url=self.settings.get('endpoint',os.getenv('OMP_S3_ENDPOINT')) or None,region_name=self.settings.get('region',os.getenv('OMP_S3_REGION','us-east-1')),aws_access_key_id=self.settings.get('access_key') or os.environ['OMP_S3_ACCESS_KEY'],aws_secret_access_key=self.settings.get('secret_key') or os.environ['OMP_S3_SECRET_KEY'],config=Config(signature_version='s3v4',s3={'addressing_style':self.settings.get('addressing',os.getenv('OMP_S3_ADDRESSING','path'))},connect_timeout=10,read_timeout=30,retries={'max_attempts':2}))
    def dav(self):
        return httpx.Client(auth=(os.environ['OMP_WEBDAV_USER'],os.environ['OMP_WEBDAV_PASSWORD']),timeout=60,follow_redirects=False)
    def dav_url(self,key):return os.environ['OMP_WEBDAV_URL'].rstrip('/')+'/'+quote(self.key(key),safe='/')
    def ssh(self):
        import paramiko
        client=paramiko.SSHClient();client.load_system_host_keys()
        if os.getenv('OMP_SFTP_KNOWN_HOSTS'):client.load_host_keys(os.environ['OMP_SFTP_KNOWN_HOSTS'])
        client.connect(os.environ['OMP_SFTP_HOST'],port=int(os.getenv('OMP_SFTP_PORT','22')),username=os.environ['OMP_SFTP_USER'],password=os.getenv('OMP_SFTP_PASSWORD'),key_filename=os.getenv('OMP_SFTP_KEY') or None,timeout=15)
        return client
    def upload(self,source,key):
        key=safe_key(key)
        if self.kind=='local':return
        if self.kind in ('s3','ros'):
            self.s3().upload_file(str(source),self.bucket,self.key(key));return
        if self.kind=='webdav':
            with self.dav() as client:
                url=os.environ['OMP_WEBDAV_URL'].rstrip('/')
                for part in self.key(key).split('/')[:-1]:
                    url+='/'+quote(part,safe='');response=client.request('MKCOL',url)
                    if response.status_code not in (201,204,405):response.raise_for_status()
                with open(source,'rb') as stream:client.put(self.dav_url(key),content=stream).raise_for_status()
            return
        ssh=self.ssh()
        try:
            with ssh.open_sftp() as client:
                remote=posixpath.join(os.getenv('OMP_SFTP_ROOT','.'),self.key(key));directory=posixpath.dirname(remote);parts=directory.split('/');built='/' if directory.startswith('/') else ''
                for part in parts:
                    if not part:continue
                    built=posixpath.join(built,part)
                    try:client.stat(built)
                    except FileNotFoundError:client.mkdir(built)
                client.put(str(source),remote)
        finally:ssh.close()
    def download(self,key,target,expected=None):
        key=safe_key(key);target.parent.mkdir(parents=True,exist_ok=True)
        temporary=target.with_name(target.name+'.'+str(uuid4())+'.download')
        try:
            if self.kind in ('s3','ros'):self.s3().download_file(self.bucket,self.key(key),str(temporary))
            elif self.kind=='webdav':
                with self.dav() as client,client.stream('GET',self.dav_url(key)) as response:
                    response.raise_for_status()
                    with temporary.open('wb') as stream:
                        for chunk in response.iter_bytes():stream.write(chunk)
            elif self.kind=='sftp':
                ssh=self.ssh()
                try:
                    with ssh.open_sftp() as client:client.get(posixpath.join(os.getenv('OMP_SFTP_ROOT','.'),self.key(key)),str(temporary))
                finally:ssh.close()
            else:raise FileNotFoundError(key)
            if expected:
                with temporary.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
                if digest!=expected:raise FileNotFoundError('远端文件与当前记录版本不一致')
            temporary.replace(target)
        finally:temporary.unlink(missing_ok=True)
    def signed_url(self,key,expires=120):
        if self.kind not in ('s3','ros'):return None
        return self.s3().generate_presigned_url('get_object',Params={'Bucket':self.bucket,'Key':self.key(key)},ExpiresIn=expires)
    def fetch_crop(self,key,rect,force=False):
        if not (force or self.settings.get('media_enabled')) or not self.settings.get('media_url'):raise ValueError('媒体处理未启用')
        from botocore.awsrequest import AWSRequest
        from botocore.auth import S3SigV4QueryAuth
        from PIL import Image
        import io
        x,y,w,h=rect
        if any(not isinstance(v,int) for v in rect) or min(x,y)<0 or min(w,h)<=0:raise ValueError('裁切坐标无效')
        request=AWSRequest(method='GET',url=self.settings['media_url'].rstrip('/')+'/'+quote(self.key(key),safe='/')+'?'+urlencode({'rect':','.join(map(str,rect)),'fmt':'png'}))
        client=self.s3()
        S3SigV4QueryAuth(client._request_signer._credentials,'s3',self.settings.get('region','us-east-1'),expires=60).add_auth(request)
        with httpx.Client(timeout=8,follow_redirects=False) as http:
            with http.stream('GET',request.url) as response:
                response.raise_for_status();chunks=[];length=0
                for chunk in response.iter_bytes():
                    length+=len(chunk)
                    if length>30*1024*1024:raise ValueError('媒体图片过大')
                    chunks.append(chunk)
        data=b''.join(chunks)
        with Image.open(io.BytesIO(data)) as image:
            if image.size!=(w,h):raise ValueError(f'媒体裁切未生效：预期 {w}×{h}，返回 {image.width}×{image.height}')
            image.load()
        return data
    def delete(self,key):
        key=safe_key(key)
        if self.kind=='local':return
        if self.kind in ('s3','ros'):
            self.s3().delete_object(Bucket=self.bucket,Key=self.key(key));return
        if self.kind=='webdav':
            with self.dav() as client:
                response=client.delete(self.dav_url(key))
                if response.status_code!=404:response.raise_for_status()
            return
        ssh=self.ssh()
        try:
            with ssh.open_sftp() as client:
                try:client.remove(posixpath.join(os.getenv('OMP_SFTP_ROOT','.'),self.key(key)))
                except FileNotFoundError:pass
        finally:ssh.close()


def for_reference(reference):
    provider=Storage(connection_id=reference.get('connection_id'))
    if provider.kind!=reference.get('backend') or provider.location()!=reference.get('location'):raise ValueError('远端位置与文件目录不一致')
    return provider


_media_cooldowns={}
_media_lock=threading.Lock()


def media_cooldown_key(provider):
    return (provider.connection_id,provider.location(),provider.settings.get('media_url'),provider.settings.get('revision',0))


def media_available(provider):
    now=time.monotonic()
    with _media_lock:
        for key,until in list(_media_cooldowns.items()):
            if until<=now:del _media_cooldowns[key]
        return media_cooldown_key(provider) not in _media_cooldowns


def media_failed(provider):
    with _media_lock:
        if len(_media_cooldowns)>=128:_media_cooldowns.pop(next(iter(_media_cooldowns)))
        _media_cooldowns[media_cooldown_key(provider)]=time.monotonic()+60


def remote_piece(relative,region):
    # Reuse a locally available corrected page before contacting a beta service.
    if local_path(relative).is_file():return None
    with connect() as db:
        expected=expected_hash(db,relative)
        references=[r for r in find(db,'storage-assets',relative=relative) if r['status']=='stored' and r.get('sha256')==expected and expected]
    for reference in references:
        try:
            provider=for_reference(reference)
            if not provider.settings.get('media_enabled') or not media_available(provider):continue
            x,y,w,h=(region[k]*4 for k in ('x','y','width','height'))
            try:return provider.fetch_crop(reference['key'],(int(x),int(y),int(x+w)-int(x),int(y+h)-int(y)))
            except Exception:
                media_failed(provider)
                continue
        except Exception:continue
    return None


def materialize(relative):
    relative=safe_key(relative);target=local_path(relative)
    if relative.startswith('pages/'):
        from .lifecycle import writable
        with connect() as db:
            page=get(db,relative.split('/')[-1].split('.')[0],'pages')
            if page:writable(db,'pages',page)
    if target.exists():return target
    with connect() as db:
        expected=expected_hash(db,relative)
        references=[r for r in find(db,'storage-assets',relative=relative) if r['status']=='stored']
        archived=sorted(find(db,'archive-files',relative=relative),key=lambda r:r['created_at'],reverse=True)
    available=False;last_error=None
    for reference in references:
        try:provider=for_reference(reference);available=True
        except Exception:continue
        try:
            provider.download(reference['key'],target,expected)
            return target
        except Exception as error:last_error=error
    from .archive import extract_file
    for record in archived:
        if expected and record['sha256']!=expected:continue
        try:return extract_file(record['archive_id'],relative,target,{'path':relative,'size':record['size'],'sha256':record['sha256']})
        except FileNotFoundError:continue
    if last_error:raise last_error
    if references and not available:raise FileNotFoundError('文件登记的远端位置与当前存储配置不一致，请恢复原配置或从有效归档恢复')
    raise FileNotFoundError(relative)


def mirror(relative,project_id=None):
    relative=safe_key(relative)
    from .lifecycle import project_writable
    with connect() as db:project_writable(db,project_id)
    provider=Storage(project_id=project_id)
    if provider.kind=='local':return
    key=f'projects/{project_id}/{relative}' if project_id else relative
    source=local_path(relative)
    with source.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    provider.upload(source,key)
    with connect() as db:
        old=next((r for r in find(db,'storage-assets',relative=relative) if r.get('connection_id')==provider.connection_id and r.get('location')==provider.location()),{})
        put(db,'storage-assets',{**old,'relative':relative,'key':key,'project_id':project_id,'connection_id':provider.connection_id,'backend':provider.kind,'location':provider.location(),'sha256':digest,'status':'stored'})
