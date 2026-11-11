"""ASGI API workload using a disposable SQLite database; no production data."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import statistics
import sqlite3
import os
from collections import defaultdict
import tempfile
import time
from uuid import uuid4
from fastapi.testclient import TestClient
from server import db
from server.main import app


def run(users=100,submissions=10800,rate=0):
    with tempfile.TemporaryDirectory(prefix='omp-load-') as temporary:
        db.ROOT=Path(temporary);db.initialize()
        people=[{'id':str(uuid4()),'role':'teacher','name':f'教师{i}','username':f't{i}'} for i in range(users)]
        tokens=[str(uuid4()) for _ in people]
        with db.connect() as connection:
            for person,token in zip(people,tokens):
                connection.execute('INSERT INTO users VALUES(?,?,?,?,?)',(person['id'],person['username'],person['name'],'teacher','unused'))
                connection.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),person['id'],time.time()+3600))
            templates=[]
            for subject in range(9):
                group=db.put(connection,'groups',{'name':f'组{subject}'})
                question={'id':str(uuid4()),'number':1,'type':'subjective','points':20,'regions':[{'page':1,'x':15,'y':110,'width':150,'height':60}],'review_mode':'single'}
                template=db.put(connection,'templates',{'name':f'科目{subject}','group_id':group['id'],'questions':[question]})
                templates.append((group,template,question))
                db.put(connection,'assignments',{'template_id':template['id'],'question_id':question['id'],'user_ids':[p['id'] for p in people]})
            for index in range(submissions):
                group,template,question=templates[index%9]
                submission=db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':str(uuid4()),'pages':[],'status':'ready'})
                # Additional historical task traffic in another question must not
                # be loaded by a current-question claim.
                db.put(connection,'tasks',{'submission_id':submission['id'],'template_id':template['id'],'question_id':'historical','user_id':people[index%users]['id'],'status':'completed','score_cents':100,'created_at':0})
        group,template,question=templates[0]
        timings=defaultdict(list)
        original_connect=sqlite3.connect
        class TimedConnection(db.Connection):
            def execute(self,sql,*args,**kwargs):
                start=time.perf_counter()
                try:return super().execute(sql,*args,**kwargs)
                finally:timings[' '.join(sql.split())[:120]].append(time.perf_counter()-start)
            def __exit__(self,*args):
                start=time.perf_counter()
                try:return super().__exit__(*args)
                finally:timings['COMMIT/ROLLBACK'].append(time.perf_counter()-start)
            def close(self):
                start=time.perf_counter()
                try:return super().close()
                finally:timings['CLOSE'].append(time.perf_counter()-start)
        if os.getenv('OMP_SQL_PROFILE'):
            sqlite3.connect=lambda *args,**kwargs:original_connect(*args,**{**kwargs,'factory':TimedConnection})
        latencies=[];score_latencies=[];claim_ids=[];failures=[]
        with TestClient(app,raise_server_exceptions=False) as client:
            def teacher(index):
                if rate:time.sleep(index/rate)
                headers={'Authorization':'Bearer '+tokens[index]};start=time.perf_counter()
                claim=client.post('/api/v1/tasks/claim',json={'template_id':template['id'],'question_id':question['id']},headers=headers)
                if claim.status_code!=200 or not claim.json():return {'error':claim.text}
                task=claim.json()
                score_start=time.perf_counter()
                score=client.post('/api/v1/tasks/'+task['id']+'/score',json={'score':10,'idempotency_key':str(uuid4())},headers=headers)
                return {'id':task['id'],'status':score.status_code,'seconds':time.perf_counter()-start,'score_seconds':time.perf_counter()-score_start,'error':score.text if score.status_code!=200 else None}
            with ThreadPoolExecutor(max_workers=users) as executor:
                for result in executor.map(teacher,range(users)):
                    if result.get('error'):failures.append(result['error'])
                    else:claim_ids.append(result['id']);latencies.append(result['seconds']);score_latencies.append(result['score_seconds'])
        report={'users':users,'submissions':submissions,'historical_tasks':submissions,'successful_claim_and_score':len(claim_ids),'unique_tasks':len(set(claim_ids)),'errors':failures,'combined_p50_seconds':round(statistics.median(latencies),3) if latencies else None,'combined_p95_seconds':round(sorted(latencies)[int((len(latencies)-1)*.95)],3) if latencies else None,'note':'In-process ASGI API benchmark; excludes real images, network, Redis and production hardware.'}
        report['arrival_rate_per_second']=rate or 'burst'
        report['score_confirmation_p95_seconds']=round(sorted(score_latencies)[int((len(score_latencies)-1)*.95)],3) if score_latencies else None
        print(json.dumps(report,ensure_ascii=False,indent=2))
        sqlite3.connect=original_connect
        if timings:
            print(json.dumps([{'query':query,'calls':len(values),'total':round(sum(values),4)} for query,values in sorted(timings.items(),key=lambda item:sum(item[1]),reverse=True)][:8],indent=2))
        return not failures and len(claim_ids)==users and len(set(claim_ids))==users


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--users',type=int,default=100);parser.add_argument('--submissions',type=int,default=10800);parser.add_argument('--rate',type=float,default=0);args=parser.parse_args()
    raise SystemExit(0 if run(args.users,args.submissions,args.rate) else 1)
