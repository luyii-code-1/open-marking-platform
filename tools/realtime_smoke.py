"""Native WebSocket/HTTP integration on an isolated temporary Uvicorn server."""
import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from uuid import uuid4
import httpx
from websockets.sync.client import connect
from websockets.exceptions import ConnectionClosed,InvalidStatus
from server import db


def message(ws,timeout=5):
    deadline=time.monotonic()+timeout
    while True:
        value=json.loads(ws.recv(timeout=max(0,deadline-time.monotonic())))
        if value.get('type')!='ping':return value
        ws.send('{"type":"pong"}')


def run(count=2):
    repo=Path(__file__).resolve().parents[1];previous_root=db.ROOT
    with tempfile.TemporaryDirectory(prefix='omp-realtime-smoke-') as temporary:
        root=Path(temporary);db.ROOT=root/'data'
        with socket.socket() as reservation:reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
        origin=f'http://127.0.0.1:{port}';url=f'ws://127.0.0.1:{port}/api/v1/events'
        env={**os.environ,'OMP_DATA':str(db.ROOT),'OMP_TASK_MODE':'inline','OMP_WS_ORIGINS':origin}
        with (root/'server.log').open('w',encoding='utf-8') as log:
            process=subprocess.Popen([sys.executable,'-m','uvicorn','server.main:app','--host','127.0.0.1','--port',str(port),'--ws','websockets-sansio','--ws-max-size','2048','--ws-max-queue','4','--log-level','warning'],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            try:
                with httpx.Client(base_url=origin+'/api/v1/',timeout=30) as api:
                    deadline=time.monotonic()+15
                    while True:
                        try:
                            if api.get('health').is_success:break
                        except httpx.HTTPError:pass
                        if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('临时服务未能启动')
                        time.sleep(.05)
                    password=secrets.token_urlsafe(24);account={'username':'admin','name':'管理员','password':password}
                    api.post('auth/bootstrap',json=account).raise_for_status()
                    admin=api.post('auth/login',json=account).json()['token'];api.headers['Authorization']='Bearer '+admin
                    def create(kind,body):
                        response=api.post(kind,json=body);response.raise_for_status();return response.json()
                    project=create('projects',{'name':'实时联调'})
                    subject=create('subjects',{'project_id':project['id'],'name':'测试科目','group_mode':'default'})
                    group=subject['default_group_id']
                    template=create('templates',{'group_id':group,'name':'测试题卡','paper':'A4','sides':1,'questions':[{'number':1,'type':'subjective','points':10,'review_mode':'single','regions':[{'page':1,'x':15,'y':110,'width':160,'height':60}]}]})
                    api.post(f"templates/{template['id']}/publish").raise_for_status();qid=template['questions'][0]['id']
                    users=[];tokens=[]
                    for index in range(count+1):
                        user=create('users',{'username':f't{index}','name':f'教师{index}','password':password});users.append(user)
                        tokens.append(api.post('auth/login',json={'username':user['username'],'password':password}).json()['token'])
                    create('assignments',{'template_id':template['id'],'question_id':qid,'user_ids':[u['id'] for u in users[:count]]})
                    with db.connect() as connection:
                        cls=db.put(connection,'classes',{'name':'自检班'})
                        for index in range(count):
                            student=db.put(connection,'students',{'name':f'学生{index}','candidate_number':f'{index:03}','class_id':cls['id']})
                            db.put(connection,'submissions',{'group_id':group,'template_id':template['id'],'student_id':student['id'],'pages':[],'status':'ready'})
                    try:
                        with connect(url,origin='https://foreign.example',proxy=None):raise AssertionError('跨来源连接未被拒绝')
                    except InvalidStatus as error:assert error.response.status_code==403
                    with ExitStack() as stack:
                        sockets=[]
                        for token in tokens:
                            ws=stack.enter_context(connect(url,origin=origin,proxy=None,open_timeout=5,close_timeout=2));ws.send(json.dumps({'type':'auth','token':token}));assert message(ws)=={'type':'ready'};sockets.append(ws)
                        admin_socket=stack.enter_context(connect(url,origin=origin,proxy=None,close_timeout=2));admin_socket.send(json.dumps({'type':'auth','token':admin}));assert message(admin_socket)=={'type':'ready'}
                        teacher={'Authorization':'Bearer '+tokens[0]}
                        claimed=api.post('tasks/claim',json={'template_id':template['id'],'question_id':qid},headers=teacher);claimed.raise_for_status();task=claimed.json()
                        for ws in sockets[:count]:
                            event=message(ws);assert event['type']=='invalidate' and 'review-progress' in event['roots']
                        message(admin_socket)
                        started=time.monotonic()
                        scored=api.post(f"tasks/{task['id']}/score",json={'score':10,'idempotency_key':'realtime-smoke-score'},headers=teacher);scored.raise_for_status()
                        for ws in sockets[:count]:
                            event=message(ws);assert set(event)=={'type','roots'} and 'review-progress' in event['roots']
                            assert not any(secret in json.dumps(event) for secret in (tokens[0],users[0]['id'],task['id']))
                        elapsed=time.monotonic()-started
                        with db.connect() as connection:db.put(connection,'exceptions',{'group_id':group,'kind':'exception','status':'open','reason':'private-worker-evidence'})
                        deadline=time.monotonic()+5
                        while True:
                            event=message(admin_socket,max(0,deadline-time.monotonic()))
                            if 'exceptions' in event.get('roots',[]):break
                        assert 'private-worker-evidence' not in json.dumps(event)
                        try:message(sockets[-1],1.2);raise AssertionError('无关教师收到了业务变更提示')
                        except TimeoutError:pass
                        progress=api.get('review-progress',params={'template_id':template['id'],'question_id':qid},headers=teacher);progress.raise_for_status();assert progress.json()['question_progress']==round(100/count,1)
                        api.post('auth/logout',headers=teacher).raise_for_status()
                        try:message(sockets[0]);raise AssertionError('退出后的实时连接未撤销')
                        except ConnectionClosed as error:assert error.rcvd.code==4401
                        fresh=api.post('auth/login',json={'username':users[0]['username'],'password':password}).json()['token']
                        with connect(url,origin=origin,proxy=None,close_timeout=2) as reconnected:
                            reconnected.send(json.dumps({'type':'auth','token':fresh}));assert message(reconnected)=={'type':'ready'}
                        print(json.dumps({'status':'passed','teacher_connections':count,'unrelated_teacher_excluded':True,'score_to_all_notifications_seconds':round(elapsed,3),'checks':['origin','first-frame authentication','scope','score progress fanout','cross-process committed change','session revocation','reconnect']},ensure_ascii=False))
            finally:
                db.ROOT=previous_root;process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--clients',type=int,default=2);args=parser.parse_args()
    if not 1<=args.clients<=100:parser.error('--clients应为1至100')
    run(args.clients)
