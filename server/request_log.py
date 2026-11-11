"""Batch HTTP metadata logging, separate from transactional business auditing."""
import asyncio
from datetime import datetime,timezone
import logging
from pathlib import Path
import queue
import threading
import time
from uuid import UUID,uuid4
from .db import connect

logger=logging.getLogger(__name__)


class Journal:
    def __init__(self,root):
        self.root=Path(root);self.queue=queue.Queue(maxsize=2000);self.errors=0;self.closed=False
        self.thread=threading.Thread(target=self.run,daemon=True,name='omp-request-log');self.thread.start()

    def write(self,batch):
        if not batch:return True
        try:
            with connect(self.root) as db:
                db.execute('BEGIN IMMEDIATE')
                db.executemany('INSERT INTO request_log(id,actor,method,route,object_id,status,duration_ms,peer,created) VALUES(:id,:actor,:method,:route,:object_id,:status,:duration_ms,:peer,:created)',batch)
            return True
        except Exception:
            self.errors+=1;logger.error('HTTP访问日志写入失败',exc_info=True);return False

    def record(self,value):
        if self.closed:return
        try:self.queue.put_nowait(value)
        except queue.Full:self.write([value])

    def flush(self):
        event=threading.Event();self.queue.put(event);return event.wait(6)

    def close(self):
        self.closed=True
        try:self.queue.put_nowait(None)
        except queue.Full:pass
        self.thread.join()

    def run(self):
        pending=[];last=time.monotonic()
        while True:
            if len(pending)>=200:
                if self.write(pending):pending=[]
                elif self.closed:return
                else:time.sleep(.2);continue
            try:item=self.queue.get(timeout=.2)
            except queue.Empty:item='tick'
            if item is None:
                self.write(pending);return
            if isinstance(item,threading.Event):
                if self.write(pending):pending=[]
                item.set();last=time.monotonic()
            elif isinstance(item,dict):pending.append(item)
            if pending and (len(pending)>=200 or time.monotonic()-last>=.2):
                if self.write(pending):pending=[]
                last=time.monotonic()


def target_id(request):
    for value in [request.path_params.get('identifier'),*[request.query_params.get(k) for k in ('object_id','project_id','group_id','template_id','question_id')]]:
        try:
            if isinstance(value,str):return str(UUID(value))
        except ValueError:pass
    return None


async def record_request(request,call_next):
    started=time.monotonic();status=500;journal=getattr(request.app.state,'request_journal',None)
    try:
        response=await call_next(request);status=response.status_code;return response
    finally:
        if journal:
            route=getattr(request.scope.get('route'),'path',None) or '<unmatched>'
            value={'id':str(uuid4()),'actor':getattr(request.state,'actor',None),'method':request.method,'route':route,
                'object_id':target_id(request),'status':status,'duration_ms':round((time.monotonic()-started)*1000,3),
                'peer':request.client.host if request.client else None,'created':datetime.now(timezone.utc).isoformat(timespec='milliseconds')}
            await asyncio.to_thread(journal.record,value)
