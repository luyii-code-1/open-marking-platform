import os
import hashlib
import json
from uuid import uuid4
import posixpath
from pathlib import PurePosixPath
from urllib.parse import quote
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
    identifier,suffix=parts[1].rsplit('.',1);record=get(db,identifier,parts[0]) or {}
    field='normalized_sha256' if parts[0]=='pages' and suffix=='png' else 'sha256'
    return record.get(field)


def backend():return os.getenv('OMP_STORAGE','local')


def location():
    keys=('OMP_STORAGE','OMP_STORAGE_PREFIX','OMP_S3_ENDPOINT','OMP_S3_BUCKET','OMP_SFTP_HOST','OMP_SFTP_PORT','OMP_SFTP_ROOT','OMP_WEBDAV_URL')
    return hashlib.sha256(json.dumps({k:os.getenv(k,'') for k in keys},sort_keys=True).encode()).hexdigest()


class Storage:
    def __init__(self):
        self.kind=backend()
        self.prefix=os.getenv('OMP_STORAGE_PREFIX','omp').strip('/')
        if self.kind not in ('local','s3','ros','webdav','sftp'):raise ValueError('储存后端无效')
    def key(self,key):return '/'.join(filter(None,[self.prefix,safe_key(key)]))
    def s3(self):
        import boto3
        from botocore.config import Config
        return boto3.client('s3',endpoint_url=os.getenv('OMP_S3_ENDPOINT') or None,region_name=os.getenv('OMP_S3_REGION','us-east-1'),aws_access_key_id=os.environ['OMP_S3_ACCESS_KEY'],aws_secret_access_key=os.environ['OMP_S3_SECRET_KEY'],config=Config(signature_version='s3v4',s3={'addressing_style':os.getenv('OMP_S3_ADDRESSING','path')},connect_timeout=10,read_timeout=60,retries={'max_attempts':3}))
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
            self.s3().upload_file(str(source),os.environ['OMP_S3_BUCKET'],self.key(key));return
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
            if self.kind in ('s3','ros'):self.s3().download_file(os.environ['OMP_S3_BUCKET'],self.key(key),str(temporary))
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
        return self.s3().generate_presigned_url('get_object',Params={'Bucket':os.environ['OMP_S3_BUCKET'],'Key':self.key(key)},ExpiresIn=expires)
    def delete(self,key):
        key=safe_key(key)
        if self.kind=='local':return
        if self.kind in ('s3','ros'):
            self.s3().delete_object(Bucket=os.environ['OMP_S3_BUCKET'],Key=self.key(key));return
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


def materialize(relative):
    relative=safe_key(relative);target=local_path(relative)
    if target.exists():return target
    with connect() as db:
        expected=expected_hash(db,relative)
        references=[r for r in find(db,'storage-assets',relative=relative) if r['status']=='stored']
        reference=next((r for r in references if r.get('backend')==backend() and r.get('location')==location()),None)
        archived=sorted(find(db,'archive-files',relative=relative),key=lambda r:r['created_at'],reverse=True)
    if reference:
        try:
            Storage().download(reference['key'],target,expected)
            return target
        except Exception:
            if not archived:raise
    from .archive import extract_file
    for record in archived:
        if expected and record['sha256']!=expected:continue
        try:return extract_file(record['archive_id'],relative,target,{'path':relative,'size':record['size'],'sha256':record['sha256']})
        except FileNotFoundError:continue
    if references and not reference:raise FileNotFoundError('文件登记的远端位置与当前存储配置不一致，请恢复原配置或从有效归档恢复')
    raise FileNotFoundError(relative)


def mirror(relative,project_id=None):
    relative=safe_key(relative)
    if backend()=='local':return
    key=f'projects/{project_id}/{relative}' if project_id else relative
    source=local_path(relative)
    Storage().upload(source,key)
    with connect() as db:
        old=next(iter(find(db,'storage-assets',relative=relative)),{})
        put(db,'storage-assets',{**old,'relative':relative,'key':key,'project_id':project_id,'backend':backend(),'location':location(),'status':'stored'})
