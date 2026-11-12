import os
import time
import logging
import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from celery import Celery
from . import db as database
from .db import connect,get,objects,put,initialize

logger=logging.getLogger(__name__)
celery=Celery('omp',broker=os.getenv('OMP_REDIS_URL','redis://127.0.0.1:6379/0'))
celery.conf.update(task_ignore_result=True,task_acks_late=True,task_reject_on_worker_lost=True,worker_prefetch_multiplier=1,broker_connection_retry_on_startup=True,broker_connection_timeout=2,broker_transport_options={'visibility_timeout':900,'socket_connect_timeout':2,'socket_timeout':2},beat_schedule={'recover-pending':{'task':'omp.recover','schedule':15.0}})
local_workers=ThreadPoolExecutor(max_workers=2,thread_name_prefix='omp-job')


class LostLease(RuntimeError):pass


def guard(db,ownership):
    if ownership:
        job=get(db,ownership[0],'jobs')
        if not job or job['status']!='running' or job.get('run_token')!=ownership[1]:raise LostLease('任务执行租约已失效')


def create_job(db,kind,payload,project_id=None,actor=None):
    if kind!='delete-hierarchy':
        from .lifecycle import project_writable
        project_writable(db,job_project(db,{'project_id':project_id,'payload':payload}))
    return put(db,'jobs',{'kind':kind,'payload':payload,'project_id':project_id,'actor':actor,'status':'pending','attempts':0,'created_at':time.time(),'lease_until':0,'available_at':0},actor)


def job_project(db,job):
    payload=job.get('payload',{})
    project=job.get('project_id') or payload.get('project_id')
    if project:return project
    page=get(db,payload.get('page_id'),'pages')
    if not page and payload.get('relative','').startswith('pages/'):
        page=get(db,payload['relative'].split('/')[-1].split('.')[0],'pages')
    return project_for_page(db,page) if page else None


def queue(kind,payload,background=False):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if kind=='process-page' and not get(db,payload.get('page_id'),'pages'):return None
        if kind=='mirror' and payload.get('project_id') and not get(db,payload['project_id'],'projects'):return None
        job=create_job(db,kind,payload)
    dispatch(job['id'],background)
    return job


def dispatch(identifier,background=False):
    if os.getenv('OMP_TASK_MODE','inline')=='inline':
        if background:local_workers.submit(execute,identifier)
        else:execute(identifier)
        return
    try:run.apply_async(args=[identifier],retry=False)
    except Exception:logger.warning('任务投递失败，已持久保存等待恢复',exc_info=False)


def project_for_page(db,page):
    batch=get(db,page['batch_id'],'scan-batches');group=get(db,batch['group_id'],'groups')
    subject=get(db,group.get('subject_id'),'subjects') if group else None
    return subject.get('project_id') if subject else None


def process_page(identifier,ownership=None):
    import cv2
    from .paper import decode,recognize,absent_mark
    from .storage import materialize,mirror
    with connect() as db:
        guard(db,ownership)
        page=get(db,identifier,'pages')
        if not page or page['status']=='quarantined':return
        batch=get(db,page['batch_id'],'scan-batches');template=get(db,batch['template_id'],'templates');project_id=project_for_page(db,page)
    if page['status']!='received':
        mirror('pages/'+identifier+'.image',project_id)
        if (database.ROOT/'pages'/(identifier+'.png')).exists():mirror('pages/'+identifier+'.png',project_id)
        return
    image,_=decode(materialize('pages/'+identifier+'.image').read_bytes())
    try:normalized,candidate,selections=recognize(image,template,page['side'])
    except ValueError as error:
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            guard(db,ownership)
            page=get(db,identifier,'pages')
            if not page:return
            page['status']='needs_review';put(db,'pages',page)
            if not any(e.get('page_id')==identifier and e['kind']=='recognition' and e['status']=='open' for e in objects(db,'exceptions')):put(db,'exceptions',{'batch_id':page['batch_id'],'page_id':identifier,'kind':'recognition','status':'open','reason':str(error)})
        mirror('pages/'+identifier+'.image',project_id)
        return
    path=database.ROOT/'pages'/(identifier+'.png')
    if not cv2.imwrite(str(path),normalized):raise IOError('校正图保存失败')
    with path.open('rb') as stream:normalized_digest=hashlib.file_digest(stream,'sha256').hexdigest()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        guard(db,ownership)
        page=get(db,identifier,'pages')
        if not page:return
        if page['status']=='received':
            page.update(status='recognized',candidate_number=candidate,selections=selections,absent_mark=absent_mark(normalized,page['side'],template),normalized_sha256=normalized_digest);put(db,'pages',page)
            from .anomalies import check_candidate
            check_candidate(db,page)
    mirror('pages/'+identifier+'.image',project_id);mirror('pages/'+identifier+'.png',project_id)


class Execution:
    def __init__(self,identifier,token):
        self.identifier=identifier;self.token=token;self.stop=threading.Event();self.lost=threading.Event();self.updated=0
        self.thread=threading.Thread(target=self.heartbeat,daemon=True)
    def save(self,progress=None):
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');job=get(db,self.identifier,'jobs')
            if not job or job['status']!='running' or job.get('run_token')!=self.token:self.lost.set();raise LostLease('任务执行租约已失效')
            job['lease_until']=time.time()+600
            if progress:job.update(progress)
            put(db,'jobs',job)
    def heartbeat(self):
        while not self.stop.wait(20):
            try:self.save()
            except LostLease:return
            except Exception:logger.warning('任务租约续期暂时失败',exc_info=False)
    def progress(self,done,total,phase):
        if self.lost.is_set():raise LostLease('任务执行租约已失效')
        now=time.monotonic()
        if now-self.updated<1 and done!=total:return
        self.save({'progress_current':done,'progress_total':total,'phase':phase});self.updated=now
    def __enter__(self):self.thread.start();return self
    def __exit__(self,*args):self.stop.set();self.thread.join(timeout=1)


def execute(identifier):
    token=str(uuid4())
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');job=get(db,identifier,'jobs')
        if not job or job['status'] in ('completed','failed') or job.get('available_at',0)>time.time() or (job['status']=='running' and job['lease_until']>time.time()):return
        if job['kind']!='delete-hierarchy' and db.execute('SELECT 1 FROM deletion_locks WHERE project_id=?',(job_project(db,job),)).fetchone():
            job.update(status='pending',lease_until=0,available_at=time.time()+15);put(db,'jobs',job);return
        job.update(status='running',lease_until=time.time()+600,run_token=token,attempts=job['attempts']+1,phase='开始执行');job.pop('error',None);job.pop('error_detail',None);put(db,'jobs',job)
    result=None
    try:
        with Execution(identifier,token) as execution:
            if job['kind']=='process-page':process_page(job['payload']['page_id'],(identifier,token))
            elif job['kind']=='mirror':
                from .storage import mirror
                mirror(job['payload']['relative'],job['payload'].get('project_id'))
            elif job['kind'] in ('archive-project','preview-release','release-project','restore-archive'):
                from .storage_jobs import perform
                result=perform(job,execution.progress)
            elif job['kind']=='delete-hierarchy':
                from .deletion import perform
                result=perform(job,execution.progress)
            else:raise ValueError('任务类型无效')
    except LostLease:return
    except Exception as error:
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            job=get(db,identifier,'jobs')
            if job and job.get('run_token')==token and job['status']=='running':
                from fastapi import HTTPException
                permanent=isinstance(error,HTTPException) and not getattr(error,'retryable',False)
                retryable=not permanent and job['attempts']<10
                job.update(status='pending' if retryable else 'failed',error=type(error).__name__,error_detail=str(error.detail) if isinstance(error,HTTPException) else '执行失败，等待重试' if retryable else '执行失败，请核查后手动重试',available_at=time.time()+min(300,2**job['attempts']),lease_until=0);put(db,'jobs',job)
        return
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        job=get(db,identifier,'jobs')
        if job and job.get('run_token')==token and job['status']=='running':job.update(status='completed',lease_until=0,phase='已完成',result=result);put(db,'jobs',job)


@celery.task(name='omp.run')
def run(identifier):
    initialize();execute(identifier)


@celery.task(name='omp.recover')
def recover():
    initialize()
    with connect() as db:pending=[j['id'] for j in objects(db,'jobs') if j['status']!='completed' and j['status']!='failed' and j.get('available_at',0)<=time.time() and (j['status']!='running' or j['lease_until']<time.time())]
    for identifier in pending:dispatch(identifier,background=True)
