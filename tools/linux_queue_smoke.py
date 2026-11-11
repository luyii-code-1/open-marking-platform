"""Native Linux API/Redis/Celery integration in an isolated disposable data directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

import cv2
import httpx


def free_port():
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        return reservation.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--image', help='Run API/worker/scheduler in this built Docker image using host networking')
    parser.add_argument('--redis-image', default='redis:7-alpine')
    args = parser.parse_args()
    if sys.platform != 'linux':
        raise RuntimeError('Run this check with a native Linux Python environment')
    docker = shutil.which('docker') if args.image else None
    if args.image and not docker:
        raise RuntimeError('docker must be available on PATH')
    redis = 'redis-server' if args.image else shutil.which('redis-server')
    renderer = shutil.which('pdftoppm')
    if not redis or not renderer:
        raise RuntimeError('redis-server and pdftoppm must be available on PATH')
    repo = Path(__file__).resolve().parents[1]
    processes = []
    logs = []
    containers = []
    with tempfile.TemporaryDirectory(prefix='omp-linux-queue-') as directory:
        root = Path(directory)
        api_port, redis_port = free_port(), free_port()
        while redis_port == api_port:
            redis_port = free_port()
        environment = {**os.environ, 'OMP_DATA': str(root / 'data'), 'OMP_STORAGE': 'local',
                       'OMP_TASK_MODE': 'celery', 'OMP_REDIS_URL': f'redis://127.0.0.1:{redis_port}/0',
                       'OMP_NUM_THREADS': '1', 'PYTHONUNBUFFERED': '1'}

        def start(name, command):
            if args.image:
                container = 'omp-check-' + root.name.removeprefix('omp-linux-queue-').replace('_', '-') + '-' + name
                containers.append(container)
                inner = command if name == 'redis' else ['python', *command[1:]]
                command = [docker, 'run', '--rm', '--name', container, '--network=host']
                if name == 'redis':
                    # The official image drops to its redis user and owns its /data volume.
                    inner = list(inner)
                    inner[inner.index('--dir')+1] = '/data'
                else:
                    command += ['--mount', f'type=bind,source={root},target={root}']
                for key in ('OMP_DATA', 'OMP_STORAGE', 'OMP_TASK_MODE', 'OMP_REDIS_URL', 'OMP_NUM_THREADS', 'PYTHONUNBUFFERED'):
                    command.extend(['--env', key + '=' + environment[key]])
                command += [args.redis_image if name == 'redis' else args.image, *inner]
            log = (root / (name + '.log')).open('w', encoding='utf-8')
            logs.append(log)
            process = subprocess.Popen(command, cwd=repo, env=environment, stdout=log,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            processes.append((name, process))
            return process

        def wait_for(check, timeout=90):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                for name, process in processes:
                    if process.poll() is not None:
                        raise RuntimeError(f'{name} exited with {process.returncode}')
                try:
                    result = check()
                    if result:
                        return result
                except httpx.TransportError:
                    pass
                time.sleep(.2)
            raise TimeoutError('Timed out waiting for cross-process state')

        started = time.monotonic()
        try:
            start('api', [sys.executable, '-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1',
                          '--port', str(api_port), '--no-access-log'])
            with httpx.Client(base_url=f'http://127.0.0.1:{api_port}/api/v1/', timeout=30) as client:
                wait_for(lambda: client.get('health').is_success, 30)

                def post(path, value=None):
                    response = client.post(path, json=value)
                    response.raise_for_status()
                    return response.json()

                credentials = {'username': 'linux-smoke-admin', 'password': secrets.token_urlsafe(24), 'name': '联调管理员'}
                post('auth/bootstrap', credentials)
                client.headers['Authorization'] = 'Bearer ' + post('auth/login', credentials)['token']
                project = post('projects', {'name': 'Linux独立联调'})
                subject = post('subjects', {'project_id': project['id'], 'name': '测试科目'})
                group = post('groups', {'subject_id': subject['id'], 'name': '测试组'})
                cls = post('classes', {'name': '测试班', 'grade': '10'})
                post('students', {'name': '测试学生', 'candidate_number': '123', 'class_id': cls['id']})
                template = post('templates', {'name': 'Linux smoke', 'group_id': group['id'], 'paper': 'A4',
                    'sides': 1, 'candidate_length': 3, 'questions': [{'number': 1, 'type': 'single', 'options': 4,
                    'points': 3, 'answer': ['B'], 'regions': [{'page': 1, 'x': 15, 'y': 110, 'width': 90, 'height': 20}]}]})
                template = post(f"templates/{template['id']}/publish")
                response = client.get(f"templates/{template['id']}/pdf")
                response.raise_for_status()
                (root / 'sheet.pdf').write_bytes(response.content)
                subprocess.run([renderer, '-r', '150', '-singlefile', '-png', str(root / 'sheet.pdf'),
                                str(root / 'sheet')], check=True, capture_output=True)
                image = cv2.imread(str(root / 'sheet.png'), cv2.IMREAD_GRAYSCALE)
                sx, sy = image.shape[1] / 210, image.shape[0] / 297

                def fill(x, y):
                    cv2.rectangle(image, (round((x-1.5)*sx), round((y-1)*sy)),
                                  (round((x+1.5)*sx), round((y+1)*sy)), 0, -1)

                for column, digit in enumerate('123'):
                    fill(18+column*6, 57+int(digit)*3.5)
                from server.paper import bubbles
                _, x, y = bubbles(template['questions'][0], template['questions'][0]['regions'][0])[1]
                fill(x, y)
                encoded = cv2.imencode('.jpg', image)[1].tobytes()
                batch = post('scan-batches', {'group_id': group['id'], 'room': '原生联调'})
                # Deliberately upload before Redis exists: the SQLite job must survive failed delivery.
                response = client.post(f"scan-batches/{batch['id']}/pages", files={'file': ('scan.jpg', encoded, 'image/jpeg')},
                    data={'capture_id': str(uuid4()), 'side': 'front', 'sequence': '1'})
                response.raise_for_status()
                page_id = response.json()['id']
                response = client.get('jobs'); response.raise_for_status()
                pending = [j for j in response.json() if j['kind'] == 'process-page']
                assert len(pending) == 1 and pending[0]['status'] == 'pending'
                job_id = pending[0]['id']
                start('redis', [redis, '--bind', '127.0.0.1', '--port', str(redis_port), '--dir', str(root),
                                '--appendonly', 'yes', '--save', '', '--protected-mode', 'yes'])
                start('worker', [sys.executable, '-m', 'celery', '-A', 'server.jobs:celery', 'worker',
                                 '--loglevel=INFO', '--concurrency=2', '--hostname=omp-linux-smoke@%h'])
                start('scheduler', [sys.executable, '-m', 'celery', '-A', 'server.jobs:celery', 'beat',
                                    '--loglevel=INFO', '--schedule=' + str(root / 'beat')])

                def completed():
                    response = client.get('jobs'); response.raise_for_status()
                    item = next(j for j in response.json() if j['id'] == job_id)
                    if item['status'] == 'failed':
                        raise RuntimeError('Image job failed: ' + str(item.get('error_detail')))
                    return item if item['status'] == 'completed' else None

                job = wait_for(completed)
                response = client.get(f"scan-batches/{batch['id']}/pages"); response.raise_for_status()
                page = next(p for p in response.json() if p['id'] == page_id)
                assert page['status'] == 'recognized' and page['candidate_number'] == '123'
                post(f"scan-batches/{batch['id']}/pair")
                response = client.get('results', params={'group_id': group['id']}); response.raise_for_status()
                assert len(response.json()) == 1 and response.json()[0]['total'] == 3
                post('results/publish', {'group_id': group['id']})
                archive_job = post(f"projects/{project['id']}/archive-jobs")

                def archived():
                    response = client.get('jobs'); response.raise_for_status()
                    item = next(j for j in response.json() if j['id'] == archive_job['id'])
                    if item['status'] == 'failed':
                        raise RuntimeError('Archive job failed: ' + str(item.get('error_detail')))
                    return item if item['status'] == 'completed' else None

                archived_job = wait_for(archived)
                assert archived_job['result']['status'] == 'verified'
                python_version = subprocess.check_output([docker, 'run', '--rm', args.image, 'python', '-c', 'import platform; print(platform.python_version())'], text=True).strip() if args.image else platform.python_version()
                redis_version = subprocess.check_output([docker, 'run', '--rm', args.redis_image, 'redis-server', '--version'], text=True).strip() if args.image else subprocess.check_output([redis, '--version'], text=True).strip()
                report = {'status': 'passed', 'platform': platform.platform(), 'python': python_version,
                          'deployment': 'docker-host-network' if args.image else 'native',
                          'redis': redis_version,
                          'worker_pool': 'prefork', 'worker_concurrency': 2, 'broker_failure_persisted': True,
                          'scheduler_recovered': True, 'recognized_candidate': page['candidate_number'],
                          'final_score': 3, 'archive_verified': True, 'image_job_attempts': job['attempts'],
                          'upload_sha256': hashlib.sha256(encoded).hexdigest(),
                          'duration_seconds': round(time.monotonic()-started, 2)}
                if args.image:
                    report['image'] = args.image
                    report['image_id'] = subprocess.check_output([docker, 'image', 'inspect', '--format', '{{.Id}}', args.image], text=True).strip()
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
        except Exception:
            for name, _ in processes:
                print((root / (name + '.log')).read_text(encoding='utf-8')[-3000:], file=sys.stderr)
            raise
        finally:
            for _, process in reversed(processes):
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
            for log in logs:
                log.close()
            for container in containers:
                subprocess.run([docker, 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)


if __name__ == '__main__':
    main()
