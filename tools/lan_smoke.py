"""Validate an explicitly prepared LAN instance with synthetic exams and teachers."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import AsyncExitStack
import asyncio
import hashlib
import json
import math
from pathlib import Path
import ssl
import subprocess
import tempfile
import time
from uuid import UUID, uuid5

import cv2
import httpx
from websockets.asyncio.client import connect


def run(url, ca_file, credentials, state_file, report_file, clients=100):
    if not 1 <= clients <= 100:
        raise ValueError('clients must be between 1 and 100')
    state_file, report_file = Path(state_file), Path(report_file)
    state = json.loads(state_file.read_text(encoding='utf-8')) if state_file.exists() else {'url': url, 'clients': clients, 'objects': {}, 'checks': {}}
    if state['url'] != url or state['clients'] != clients:
        raise ValueError('State belongs to another validation instance')
    started = time.monotonic()
    trust = ssl.create_default_context(cafile=str(ca_file))

    def save():
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')

    def stats(values):
        ordered = sorted(values)
        return {'count': len(ordered), 'p50_ms': round(ordered[len(ordered)//2]*1000, 2),
                'p95_ms': round(ordered[math.ceil(len(ordered)*.95)-1]*1000, 2), 'max_ms': round(ordered[-1]*1000, 2)}

    with httpx.Client(base_url=url+'/api/v1/', verify=trust, trust_env=False, timeout=90,
                      limits=httpx.Limits(max_connections=120, max_keepalive_connections=100)) as api:
        api.get('health').raise_for_status()
        login = api.post('auth/login', json={'username': credentials['username'], 'password': credentials['password']})
        if login.status_code == 401:
            response = api.post('auth/bootstrap', json={**{k: credentials[k] for k in ('username', 'password')}, 'name': '内网验证管理员'})
            response.raise_for_status()
            login = api.post('auth/login', json={k: credentials[k] for k in ('username', 'password')})
        login.raise_for_status()
        api.headers['Authorization'] = 'Bearer '+login.json()['token']

        def request(method, path, value=None, token=None, **kwargs):
            headers = {'Authorization': 'Bearer '+token} if token else None
            response = api.request(method, path, json=value, headers=headers, **kwargs)
            response.raise_for_status()
            return response

        def post(path, value=None, token=None):
            return request('POST', path, value, token).json()

        def own(key, kind, body):
            if key not in state['objects']:
                state['objects'][key] = post(kind, body); save()
            return state['objects'][key]

        def job(identifier, timeout=180):
            deadline = time.monotonic()+timeout
            while time.monotonic() < deadline:
                item = next(j for j in request('GET', 'jobs').json() if j['id'] == identifier)
                if item['status'] == 'completed':
                    return item['result']
                if item['status'] == 'failed':
                    raise RuntimeError('Job failed: '+str(item.get('error_detail')))
                time.sleep(1)
            raise TimeoutError('Background job did not finish: '+identifier)

        print(f'Preparing {clients} synthetic students and teacher accounts', flush=True)
        project = own('project', 'projects', {'name': f'内网验证 · {clients}人协同阅卷'})
        subject = own('subject', 'subjects', {'project_id': project['id'], 'name': '综合验证科目'})
        group = own('group', 'groups', {'subject_id': subject['id'], 'name': '测试题卡组'})
        cls = own('class', 'classes', {'name': '验证班', 'grade': '10'})
        users, tokens = [], []
        for index in range(clients):
            user = own('teacher-'+str(index), 'users', {'username': f'validation-teacher-{index:03}', 'name': f'验证教师{index:03}', 'password': credentials['teacher_password']})
            users.append(user)
            tokens.append(post('auth/login', {'username': user['username'], 'password': credentials['teacher_password']})['token'])
            own('student-'+str(index), 'students', {'name': f'验证学生{index:03}', 'candidate_number': f'{index:03}', 'class_id': cls['id']})
        request('PUT', f"classes/{cls['id']}", {'teacher_ids': [u['id'] for u in users]})
        template = own('template', 'templates', {'name': '局域网验证题卡', 'group_id': group['id'], 'paper': 'A4', 'sides': 1, 'candidate_length': 3,
            'questions': [{'number': 1, 'type': 'single', 'options': 4, 'points': 3, 'answer': ['B'], 'regions': [{'page': 1, 'x': 15, 'y': 110, 'width': 90, 'height': 20}]},
                          {'number': 2, 'type': 'subjective', 'points': 10, 'review_mode': 'single', 'regions': [{'page': 1, 'x': 15, 'y': 150, 'width': 170, 'height': 60}]}]})
        if not state['checks'].get('template_published'):
            template = post(f"templates/{template['id']}/publish")
            state['objects']['template'] = template
            request('PUT', f"groups/{group['id']}/roster", {'class_ids': [cls['id']]})
            state['checks']['template_published'] = True; save()
        batch = own('batch', 'scan-batches', {'group_id': group['id'], 'room': 'LAN验证批次'})
        if not state['checks'].get('paired'):
            pages = request('GET', f"scan-batches/{batch['id']}/pages").json()
            existing = {p['id'] for p in pages}
            with tempfile.TemporaryDirectory(prefix='omp-lan-sheets-') as temporary:
                root = Path(temporary)
                (root/'sheet.pdf').write_bytes(request('GET', f"templates/{template['id']}/pdf").content)
                subprocess.run(['pdftoppm', '-r', '150', '-singlefile', '-png', str(root/'sheet.pdf'), str(root/'sheet')], capture_output=True, check=True)
                base = cv2.imread(str(root/'sheet.png'), cv2.IMREAD_GRAYSCALE)
                sx, sy = base.shape[1]/210, base.shape[0]/297
                from server.paper import bubbles
                _, choice_x, choice_y = bubbles(template['questions'][0], template['questions'][0]['regions'][0])[1]
                for index in range(clients):
                    capture = str(uuid5(UUID(template['id']), f'lan-validation-{index}'))
                    if capture in existing:
                        continue
                    image = base.copy()
                    def fill(x, y):
                        cv2.rectangle(image, (round((x-1.5)*sx), round((y-1)*sy)), (round((x+1.5)*sx), round((y+1)*sy)), 0, -1)
                    for column, digit in enumerate(f'{index:03}'):
                        fill(18+column*6, 57+int(digit)*3.5)
                    fill(choice_x, choice_y)
                    encoded = cv2.imencode('.jpg', image)[1].tobytes()
                    response = api.post(f"scan-batches/{batch['id']}/pages", files={'file': ('scan.jpg', encoded, 'image/jpeg')},
                        data={'capture_id': capture, 'side': 'front', 'sequence': str(index+1)})
                    response.raise_for_status()
                    if (index+1)%10 == 0:
                        print(f'Uploaded {index+1}/{clients} synthetic scans', flush=True)
            deadline = time.monotonic()+300
            while True:
                pages = request('GET', f"scan-batches/{batch['id']}/pages").json()
                if any(p['status'] in ('quarantined', 'needs_review') for p in pages):
                    raise RuntimeError('Synthetic scan needs review')
                if len(pages) == clients and all(p['status'] == 'recognized' for p in pages):
                    assert {p['candidate_number'] for p in pages} == {f'{i:03}' for i in range(clients)}; break
                if time.monotonic() > deadline:
                    raise TimeoutError('Scan recognition did not finish')
                time.sleep(1)
            post(f"scan-batches/{batch['id']}/pair")
            state['checks']['paired'] = True; save()
            print('All scans recognized and paired', flush=True)
        question = template['questions'][1]
        own('assignment', 'assignments', {'template_id': template['id'], 'question_id': question['id'], 'user_ids': [u['id'] for u in users]})
        if not state['checks'].get('scored'):
            def claim(index):
                existing = request('GET', 'tasks', token=tokens[index]).json()
                task = next((t for t in existing if t['template_id'] == template['id'] and t['question_id'] == question['id'] and t.get('expires_at',0)>time.time()), None)
                if task is None:
                    previous = request('GET', 'tasks/history', token=tokens[index], params={'template_id': template['id'], 'question_id': question['id']}).json()
                    task = previous[0] if previous else None
                began = time.monotonic()
                fresh = task is None
                task = task or post('tasks/claim', {'template_id': template['id'], 'question_id': question['id']}, tokens[index])
                assert task and task['id']
                return task, time.monotonic()-began, fresh
            with ThreadPoolExecutor(max_workers=clients) as pool:
                claimed = list(pool.map(claim, range(clients)))
            tasks = [t for t, _, _ in claimed]
            assert len({t['submission_id'] for t in tasks}) == clients
            state['tasks'] = tasks; save()
            def image(index):
                response = request('GET', tasks[index]['image_url'].removeprefix('/api/v1/'), token=tokens[index])
                assert response.headers['content-type'].startswith('image/') and len(response.content)>100
            with ThreadPoolExecutor(max_workers=min(20, clients)) as pool:
                list(pool.map(image, range(clients)))
            print(f'{clients} distinct tasks and authenticated answer images verified', flush=True)
            async def concurrent_review():
                async with AsyncExitStack() as stack:
                    sockets=[]
                    for token in tokens:
                        ws=await stack.enter_async_context(connect(url.replace('https:','wss:')+'/api/v1/events',ssl=trust,origin=url,proxy=None,ping_interval=None,open_timeout=30,close_timeout=2))
                        await ws.send(json.dumps({'type':'auth','token':token}))
                        assert json.loads(await asyncio.wait_for(ws.recv(),10))=={'type':'ready'}
                        sockets.append(ws)
                        if len(sockets)%10==0:print(f'Authenticated WSS connections: {len(sockets)}/{clients}',flush=True)
                    async def heartbeat(ws):
                        async with asyncio.timeout(35):
                            while True:
                                event=json.loads(await ws.recv())
                                if event.get('type')=='ping':
                                    await ws.send('{"type":"pong"}');return
                    await asyncio.gather(*(heartbeat(ws) for ws in sockets))
                    print('Application heartbeat acknowledged on every WSS connection',flush=True)
                    began=time.monotonic()
                    async with httpx.AsyncClient(base_url=url+'/api/v1/',verify=trust,trust_env=False,timeout=90,
                            limits=httpx.Limits(max_connections=120,max_keepalive_connections=100)) as scoring:
                        async def score(index):
                            sent=time.monotonic()
                            response=await scoring.post(f"tasks/{tasks[index]['id']}/score",headers={'Authorization':'Bearer '+tokens[index]},
                                json={'score':10,'idempotency_key':'lan-score-'+tasks[index]['id']})
                            response.raise_for_status();return time.monotonic()-sent
                        confirmations=await asyncio.gather(*(score(index) for index in range(clients)))
                    async def notified(ws):
                        async with asyncio.timeout(15):
                            while True:
                                event=json.loads(await ws.recv())
                                if event.get('type')=='ping':
                                    await ws.send('{"type":"pong"}');continue
                                assert set(event)<={'type','roots'}
                                if event.get('type')=='sync' or 'review-progress' in event.get('roots',[]):return
                    await asyncio.gather(*(notified(ws) for ws in sockets))
                    fresh_claims=[elapsed for _,elapsed,fresh in claimed if fresh]
                    state['checks'].update(claim_timings=stats(fresh_claims) if fresh_claims else {'count':0,'note':'Reused valid existing task leases; not a claim latency benchmark'},score_timings=stats(confirmations),
                        teacher_wss_connections=clients,client_protocol_ping=False,application_heartbeat=True,
                        score_and_notification_seconds=round(time.monotonic()-began,3),scored=True)
            asyncio.run(concurrent_review())
            save(); print(f'{clients} claims, private images, scores and WSS notifications passed', flush=True)
        rows = request('GET', 'results', params={'group_id': group['id']}).json()
        assert len(rows) == clients and all(r['status'] == 'completed' and r['total'] == 13 for r in rows)
        if not state['checks'].get('published'):
            post('results/publish', {'group_id': group['id']}); state['checks']['published'] = True; save()
        visible = request('GET', 'results', token=tokens[0], params={'group_id': group['id']}).json()
        assert len(visible) == clients
        exported = request('GET', 'analysis/group/export', params={'group_id': group['id'], 'view': 'students'})
        assert len(exported.content.decode('utf-8-sig').splitlines()) == clients+1
        if 'archive' not in state:
            state['archive'] = job(post(f"projects/{project['id']}/archive-jobs")['id']); save()
        archive = state['archive']; assert archive['status'] == 'verified'
        digest = hashlib.sha256()
        with api.stream('GET', archive['download_url'].removeprefix('/api/v1/')) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes(): digest.update(chunk)
        assert digest.hexdigest() == archive['sha256']
        if not state['checks'].get('released'):
            plan = job(post(f"projects/{project['id']}/release-preview-jobs", {'archive_id': archive['id'], 'mode': 'local'})['id'])
            released = job(post(f"projects/{project['id']}/release-jobs", {'plan_id': plan['id'], 'confirm': True})['id'])
            assert released['status'] == 'completed'
            state['checks']['released'] = True; save()
        # Retrieve a released answer through its authenticated image route, then restore all files.
        response = request('GET', state['tasks'][0]['image_url'].removeprefix('/api/v1/'), token=tokens[0])
        assert response.headers['content-type'].startswith('image/')
        if not state['checks'].get('restored'):
            restored = job(post(f"archives/{archive['id']}/restore-jobs")['id'])
            state['checks'].update(restored=True, restored_files=restored['restored_files']); save()
        final = request('GET', 'results', params={'group_id': group['id']}).json()
        assert len(final) == clients and all(r['total'] == 13 for r in final)
        report = {'status': 'passed', 'url': url, 'fixture': 'synthetic', 'students': clients, 'teachers': clients,
                  'https_certificate_verified': True, 'recognized_candidates': clients, 'completed_scores': clients,
                  'final_score_each': 13, 'csv_rows': clients, 'archive_download_sha256_verified': True,
                  **state['checks'], 'duration_seconds_this_run': round(time.monotonic()-started, 2)}
        report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
        return report


if __name__ == '__main__':
    import argparse
    import getpass
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',required=True)
    parser.add_argument('--ca-file',type=Path,required=True)
    parser.add_argument('--username',default='validation-admin')
    parser.add_argument('--clients',type=int,default=100)
    parser.add_argument('--state',type=Path,default=Path('dist/lan-validation-state.json'))
    parser.add_argument('--report',type=Path,default=Path('dist/lan-report.json'))
    arguments=parser.parse_args()
    credentials={'username':arguments.username,'password':getpass.getpass('Validation administrator password: '),
                 'teacher_password':getpass.getpass('Synthetic teacher password: ')}
    run(arguments.url.rstrip('/'),arguments.ca_file,credentials,arguments.state,arguments.report,arguments.clients)
