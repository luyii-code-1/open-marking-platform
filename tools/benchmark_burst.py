"""Measure synchronized teacher bursts against disposable Uvicorn, optionally through Caddy TLS."""
import argparse
import asyncio
from collections import Counter
from contextlib import ExitStack
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from uuid import uuid4
import h11

from server import db
from server.answer_slices import sync


def seed(root, users, papers):
    db.initialize(root)
    with db.connect(root) as con:
        project = db.put(con, 'projects', {'name': '容量验证'})
        subject = db.put(con, 'subjects', {'project_id': project['id'], 'name': '科目'})
        grade = db.put(con, 'grades', {'name': '测试年级'})
        group = db.put(con, 'groups', {'subject_id': subject['id'], 'grade_id': grade['id'], 'name': '测试组'})
        room = db.put(con, 'room-tags', {'group_id': group['id'], 'grade_id': grade['id'], 'name': '测试考场'})
        question = {'id': str(uuid4()), 'number': 1, 'type': 'subjective', 'points': 20,
                    'review_mode': 'single', 'regions': [{'page': 1, 'x': 5, 'y': 60, 'width': 180, 'height': 50}]}
        template = db.put(con, 'templates', {'name': '测试卷', 'group_id': group['id'], 'status': 'published',
                                              'questions': [question]})
        db.put(con, 'groups', {**group, 'template_id': template['id']})
        people = [str(uuid4()) for _ in range(users)]
        tokens = [str(uuid4()) for _ in people]
        for person, token in zip(people, tokens):
            con.execute('INSERT INTO users VALUES(?,?,?,?,?)', (person, person, '教师', 'teacher', 'unused'))
            con.execute('INSERT INTO sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(),
                                                               person, time.time()+3600))
        db.put(con, 'assignments', {'template_id': template['id'], 'question_id': question['id'], 'user_ids': people})
        batch = db.put(con, 'scan-batches', {'group_id': group['id'], 'template_id': template['id'], 'status': 'paired'})
        for i in range(papers):
            page = db.put(con, 'pages', {'batch_id': batch['id'], 'status': 'recognized', 'side': 'front', 'sequence': i})
            submission = db.put(con, 'submissions', {'group_id': group['id'], 'template_id': template['id'],
                                      'student_id': str(uuid4()), 'pages': [page['id']], 'room_tags': [room], 'status': 'ready'})
            sync(con, submission, template)
    return tokens, template['id'], question['id']


class Teacher:
    def __init__(self, token, port, client_ssl=None):
        self.token = token
        self.port = port
        self.client_ssl = client_ssl
        self.authority = f'127.0.0.1:{port}'
        self.origin = ('https://' if client_ssl else 'http://') + self.authority
        self.task = None
        self.key = str(uuid4())
        self.writer = None
        self.http = h11.Connection(h11.CLIENT)
        self.events = None
        self.listener = None
        self.ready = False
        self.setup_error = None
        self.disconnect = None
        self.closing = False
        self.notifications = 0
        self.pongs = 0

    async def connect_events(self):
        from websockets.asyncio.client import connect
        try:
            scheme = 'wss' if self.client_ssl else 'ws'
            self.events = await connect(f'{scheme}://{self.authority}/api/v1/events',
                                        origin=self.origin, ssl=self.client_ssl, proxy=None,
                                        ping_interval=None, open_timeout=15, close_timeout=2)
            await self.events.send(json.dumps({'type': 'auth', 'token': self.token}))
            reply = await asyncio.wait_for(self.events.recv(), timeout=15)
            if json.loads(reply) != {'type': 'ready'}:
                raise ValueError('服务器未确认通知连接')
            self.ready = True
            self.listener = asyncio.create_task(self.read_events())
        except Exception as error:
            self.setup_error = type(error).__name__

    async def read_events(self):
        try:
            async for message in self.events:
                kind = json.loads(message)['type']
                if kind == 'ping':
                    await self.events.send('{"type":"pong"}')
                    self.pongs += 1
                elif kind in ('sync', 'invalidate'):
                    self.notifications += 1
        except Exception as error:
            if not self.closing:
                self.disconnect = type(error).__name__
        else:
            if not self.closing:
                self.disconnect = f'close {self.events.close_code}'

    async def close_events(self):
        self.closing = True
        if self.events is not None:
            await self.events.close()
        if self.listener is not None:
            await self.listener

    async def connect(self):
        self.reader, self.writer = await asyncio.open_connection('127.0.0.1', self.port, ssl=self.client_ssl)

    async def post(self, path, payload):
        body = json.dumps(payload).encode()
        headers = [('Host', self.authority), ('Authorization', 'Bearer '+self.token), ('Accept-Encoding', 'gzip'),
                   ('Content-Type','application/json'), ('Content-Length',str(len(body)))]
        request = h11.Request(method='POST',target='/api/v1/'+path,headers=headers)
        self.writer.write(self.http.send(request)+self.http.send(h11.Data(data=body))+self.http.send(h11.EndOfMessage()))
        await self.writer.drain()
        data = bytearray()
        while True:
            event = self.http.next_event()
            if event is h11.NEED_DATA:
                self.http.receive_data(await self.reader.read(65536))
            elif isinstance(event,h11.Response):
                code = event.status_code
                compressed = dict(event.headers).get(b'content-encoding')==b'gzip'
            elif isinstance(event,h11.Data):
                data.extend(event.data)
            elif isinstance(event,h11.EndOfMessage):
                self.http.start_next_cycle()
                break
            elif isinstance(event,h11.ConnectionClosed):
                raise ConnectionError('HTTP 连接已关闭')
        response = json.loads(gzip.decompress(data) if compressed else data)
        if code != 200:
            raise RuntimeError(f'HTTP {code}')
        return response

    async def claim(self, template_id, question_id):
        task = await self.post('tasks/claim', {'template_id': template_id, 'question_id': question_id})
        if not task or not task.get('answer_slice_id'):
            raise RuntimeError('缺少题目或作答区域')
        self.task = task['id']
        return task['submission_id']

    async def score(self):
        result = await self.post(f'tasks/{self.task}/score', {'score': 10, 'idempotency_key': self.key,
                                 'base_score_revision': 0, 'offline_protocol': 1})
        if result.get('accepted_operation') != {'id': self.key, 'score': 10}:
            raise RuntimeError('评分回执不匹配')
        return self.task


async def burst(teachers, action):
    gate = asyncio.Event()
    async def one(teacher):
        await gate.wait()
        value = await asyncio.wait_for(action(teacher), timeout=120)
        return time.perf_counter()-started, value
    tasks = [asyncio.create_task(one(t)) for t in teachers]
    await asyncio.sleep(0)
    started = time.perf_counter()
    gate.set()
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)
    times = sorted(row[0] for row in outcomes if not isinstance(row, BaseException))
    errors = {}
    for error in outcomes:
        if isinstance(error, BaseException):
            name = f'{type(error).__name__}: {error}'
            errors[name] = errors.get(name, 0)+1
    def percentile(fraction):
        return round(times[math.ceil(len(times)*fraction)-1], 4) if times else None
    return {'success': len(times), 'unique': len({row[1] for row in outcomes if not isinstance(row,BaseException)}),
            'errors': errors, 'p50_s': percentile(.5), 'p95_s': percentile(.95), 'max_s': percentile(1)}


def process_io(pid):
    path = Path(f'/proc/{pid}/io')
    if not path.is_file():
        return {}
    counters = dict(line.split(': ') for line in path.read_text().splitlines())
    total = {k: int(counters[k]) for k in ('read_bytes','write_bytes')}
    children = Path(f'/proc/{pid}/task/{pid}/children')
    for child in children.read_text().split():
        for name, value in process_io(int(child)).items():
            total[name] += value
    return total


def event_counts(teachers):
    return {'requested': len(teachers), 'ready': sum(t.ready for t in teachers),
            'setup_errors': dict(Counter(t.setup_error for t in teachers if t.setup_error)),
            'unexpected_disconnects': sum(t.disconnect is not None for t in teachers),
            'disconnect_reasons': dict(Counter(t.disconnect for t in teachers if t.disconnect)),
            'clients_with_updates': sum(t.notifications > 0 for t in teachers),
            'notifications': sum(t.notifications for t in teachers), 'pongs': sum(t.pongs for t in teachers)}


async def exercise(port, tokens, tid, qid, pid, realtime=False, client_ssl=None):
    teachers = [Teacher(token, port, client_ssl) for token in tokens]
    try:
        if realtime:
            for start in range(0, len(teachers), 25):
                await asyncio.gather(*(t.connect_events() for t in teachers[start:start+25]))
            if not all(t.ready and t.disconnect is None for t in teachers):
                return {'realtime': event_counts(teachers)}
        # Logged-in clients have an established transport before each barrier is released.
        for start in range(0,len(teachers),100):
            await asyncio.gather(*(t.connect() for t in teachers[start:start+100]))
        before = process_io(pid)
        claim = await burst(teachers, lambda teacher: teacher.claim(tid,qid))
        after_claim = process_io(pid)
        ready = [t for t in teachers if t.task]
        score = await burst(ready, Teacher.score)
        after_score = process_io(pid)
        for result, start, end in ((claim,before,after_claim),(score,after_claim,after_score)):
            if start and end:
                result['server_io_bytes'] = {k:end[k]-start[k] for k in start}
        report = {'claim': claim, 'score': score, 'replay': await burst(ready, Teacher.score)}
        if realtime:
            # Give the last committed audit rows one hub poll outside the measured bursts.
            await asyncio.sleep(1.2)
            report['realtime'] = event_counts(teachers)
        return report
    finally:
        for teacher in teachers:
            if teacher.writer:
                teacher.writer.close()
        if realtime:
            await asyncio.gather(*(t.close_events() for t in teachers), return_exceptions=True)


def run(users, papers, target, realtime=False, caddy=None, workers=1):
    with tempfile.TemporaryDirectory(prefix='omp-http-burst-') as directory, ExitStack() as layers:
        root = Path(directory)
        tokens, tid, qid = seed(root, users, papers)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        public_port, client_ssl = port, None
        if caddy:
            from tools.benchmark_proxy import caddy_proxy
            public_port, client_ssl = layers.enter_context(caddy_proxy(caddy, root, port))
        origin = ('https://' if client_ssl else 'http://') + f'127.0.0.1:{public_port}'
        env = {**os.environ, 'OMP_DATA': directory, 'OMP_TASK_MODE': 'benchmark'}
        # This private database and listening socket belong only to this run.
        command = [sys.executable,'-m','uvicorn','server.main:app','--host','127.0.0.1','--port',str(port),
                   '--no-access-log','--no-proxy-headers','--ws','websockets-sansio','--ws-max-size','2048',
                   '--ws-max-queue','4','--log-level','warning']
        if realtime:
            env['OMP_WS_ORIGINS'] = origin
            command.extend(['--ws','websockets-sansio','--ws-max-size','2048','--ws-max-queue','4'])
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=client_ssl))
        command.extend(['--workers',str(workers)])
        process_group = subprocess.CREATE_NEW_PROCESS_GROUP if os.name=='nt' and workers>1 else 0
        server = subprocess.Popen(command, env=env,creationflags=process_group)
        try:
            for _ in range(200):
                if server.poll() is not None:
                    raise RuntimeError('测试 API 启动失败')
                try:
                    with opener.open(f'{origin}/api/v1/health',timeout=1):
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise TimeoutError('测试 API 未就绪')
            report = asyncio.run(exercise(public_port,tokens,tid,qid,server.pid,realtime,client_ssl))
        finally:
            if process_group and server.poll() is None:
                try:
                    server.send_signal(signal.CTRL_BREAK_EVENT)
                    server.wait(timeout=30)
                except (OSError,subprocess.TimeoutExpired):
                    subprocess.run(['taskkill','/PID',str(server.pid),'/T','/F'],capture_output=True)
            elif server.poll() is None:
                server.terminate()
            server.wait(timeout=30)
        with db.connect(root) as con:
            score_count, distinct_tasks, distinct_teachers, total = con.execute(
                'SELECT count(*),count(distinct task_id),count(distinct user_id),sum(score) FROM scores').fetchone()
            final_count = con.execute('SELECT COUNT(*) FROM review_results WHERE question_id=? AND final_cents=1000',(qid,)).fetchone()[0]
        correct = (score_count, distinct_tasks, distinct_teachers, total, final_count) == (users,users,users,users*1000,users)
        complete = all(report.get(k, {}).get('success') == users and report[k]['unique'] == users
                       for k in ('claim', 'score', 'replay'))
        connected = not realtime or (report['realtime']['ready'] == users and report['realtime']['unexpected_disconnects'] == 0)
        passed = correct and complete and connected and report['score']['p95_s']<=target
        print(json.dumps({'users':users,'papers':papers,'api_workers':workers,'transport':'caddy-https' if caddy else 'direct-http',
                          **report,'persisted_scores':score_count,
                          'final_results':final_count,'durability_checked':correct,'score_target_s':target,'passed':passed},indent=2))
        return passed


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--users',type=int,default=1000)
    parser.add_argument('--papers',type=int,default=10800)
    parser.add_argument('--target',type=float,default=2)
    parser.add_argument('--workers',type=int,default=1)
    parser.add_argument('--realtime', action='store_true', help='在三个 HTTP 突发阶段保持每名教师的实时通知连接')
    parser.add_argument('--caddy', type=Path, help='本地 Caddy 程序路径，使用独立的 HTTPS/WSS 反向代理')
    args=parser.parse_args()
    if min(args.users,args.workers)<1 or args.papers<args.users or args.target<=0:
        parser.error('至少需要一份答卷供每位教师领取，目标时间须大于零')
    raise SystemExit(0 if run(args.users,args.papers,args.target,args.realtime,args.caddy,args.workers) else 1)
