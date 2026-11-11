"""Exercise the repository Compose stack through certificate-verified Caddy HTTPS/WSS."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

import cv2
import httpx
from websockets.sync.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='Previously built project image')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or not shutil.which('docker') or not shutil.which('pdftoppm'):
        raise RuntimeError('Requires native Linux, Docker Compose, Python dependencies and pdftoppm')
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='omp-compose-smoke-') as directory:
        root = Path(directory)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0)); port = reservation.getsockname()[1]
        origin = f'https://localhost:{port}'
        project = 'omp-check-' + secrets.token_hex(5)
        environment = root / '.env'
        environment.write_text(f'OMP_HOST_DATA={root}/data\nOMP_DOMAIN=localhost\nOMP_STORAGE=local\nOMP_WS_ORIGINS={origin}\nOMP_WEBAUTHN_ORIGINS={origin}\n')
        override = root / 'override.yaml'
        override.write_text('services:\n' + ''.join(
            f'  {service}:\n    image: {json.dumps(args.image)}\n    pull_policy: never\n    env_file: !override [{json.dumps(str(environment))}]\n'
            for service in ('api', 'worker', 'scheduler')) +
            f'  proxy:\n    ports: !override ["127.0.0.1:{port}:443"]\n')
        command = ['docker', 'compose', '--project-name', project, '--project-directory', str(repo),
                   '--env-file', str(environment), '-f', str(repo / 'compose.yaml'), '-f', str(override)]

        def compose(*parts, check=True):
            return subprocess.run([*command, *parts], cwd=repo, text=True, capture_output=True, check=check)

        def wait_for(check, timeout=60):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                result = check()
                if result:
                    return result
                time.sleep(.2)
            raise TimeoutError('Timed out waiting for Compose workflow state')

        started = time.monotonic()
        try:
            compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120')
            compose('cp', 'proxy:/data/caddy/pki/authorities/local/root.crt', str(root / 'ca.crt'))
            trust = ssl.create_default_context(cafile=str(root / 'ca.crt'))
            with httpx.Client(base_url=origin + '/api/v1/', verify=trust, trust_env=False, timeout=30) as api:
                api.get('health').raise_for_status()
                shell = api.get(origin + '/')
                assert shell.status_code == 200 and '<html' in shell.text.lower()
                credentials = {'username': 'compose-admin', 'password': secrets.token_urlsafe(24), 'name': '联调管理员'}

                def post(path, value=None):
                    response = api.post(path, json=value); response.raise_for_status(); return response.json()

                post('auth/bootstrap', credentials)
                token = post('auth/login', credentials)['token']
                api.headers['Authorization'] = 'Bearer ' + token
                wss = origin.replace('https:', 'wss:') + '/api/v1/events'
                try:
                    with connect(wss, ssl=trust, origin='https://foreign.example', proxy=None):
                        raise AssertionError('Foreign WebSocket origin accepted through proxy')
                except InvalidStatus as error:
                    assert error.response.status_code == 403
                with connect(wss, ssl=trust, origin=origin, proxy=None, close_timeout=2) as ws:
                    ws.send(json.dumps({'type': 'auth', 'token': token}))
                    assert json.loads(ws.recv(timeout=5)) == {'type': 'ready'}
                    exam = post('projects', {'name': 'Compose HTTPS联调'})
                    deadline = time.monotonic() + 5
                    while True:
                        event = json.loads(ws.recv(timeout=max(.1, deadline-time.monotonic())))
                        if event.get('type') == 'ping':
                            ws.send('{"type":"pong"}'); continue
                        if 'projects' in event.get('roots', []):
                            assert set(event) == {'type', 'roots'}; break
                    subject = post('subjects', {'project_id': exam['id'], 'name': '测试科目'})
                    group = post('groups', {'subject_id': subject['id'], 'name': '测试组'})
                    cls = post('classes', {'name': '测试班', 'grade': '10'})
                    post('students', {'name': '测试学生', 'candidate_number': '123', 'class_id': cls['id']})
                    template = post('templates', {'name': 'Compose smoke', 'group_id': group['id'], 'paper': 'A4', 'sides': 1,
                        'candidate_length': 3, 'questions': [{'number': 1, 'type': 'single', 'options': 4, 'points': 3,
                        'answer': ['B'], 'regions': [{'page': 1, 'x': 15, 'y': 110, 'width': 90, 'height': 20}]}]})
                    template = post(f"templates/{template['id']}/publish")
                    response = api.get(f"templates/{template['id']}/pdf"); response.raise_for_status()
                    (root / 'sheet.pdf').write_bytes(response.content)
                    subprocess.run(['pdftoppm', '-r', '150', '-singlefile', '-png', str(root / 'sheet.pdf'), str(root / 'sheet')], check=True, capture_output=True)
                    image = cv2.imread(str(root / 'sheet.png'), cv2.IMREAD_GRAYSCALE)
                    sx, sy = image.shape[1]/210, image.shape[0]/297

                    def fill(x, y):
                        cv2.rectangle(image, (round((x-1.5)*sx), round((y-1)*sy)), (round((x+1.5)*sx), round((y+1)*sy)), 0, -1)

                    for column, digit in enumerate('123'):
                        fill(18+column*6, 57+int(digit)*3.5)
                    from server.paper import bubbles
                    _, x, y = bubbles(template['questions'][0], template['questions'][0]['regions'][0])[1]; fill(x, y)
                    encoded = cv2.imencode('.jpg', image)[1].tobytes()
                    batch = post('scan-batches', {'group_id': group['id']})
                    response = api.post(f"scan-batches/{batch['id']}/pages", files={'file': ('scan.jpg', encoded, 'image/jpeg')},
                        data={'capture_id': str(uuid4()), 'side': 'front', 'sequence': '1'})
                    response.raise_for_status()
                    page_id = response.json()['id']

                    def job_done(kind, identifier=None):
                        response = api.get('jobs'); response.raise_for_status()
                        rows = [j for j in response.json() if j['kind'] == kind and (identifier is None or j['id'] == identifier)]
                        if any(j['status'] == 'failed' for j in rows):
                            raise RuntimeError('Background job failed')
                        return next((j for j in rows if j['status'] == 'completed'), None)

                    wait_for(lambda: job_done('process-page'))
                    response = api.get(f"scan-batches/{batch['id']}/pages"); response.raise_for_status()
                    page = next(p for p in response.json() if p['id'] == page_id)
                    assert page['status'] == 'recognized' and page['candidate_number'] == '123'
                    post(f"scan-batches/{batch['id']}/pair")
                    response = api.get('results', params={'group_id': group['id']}); response.raise_for_status()
                    assert response.json()[0]['total'] == 3
                    post('results/publish', {'group_id': group['id']})
                    archive_job = post(f"projects/{exam['id']}/archive-jobs")
                    archive = wait_for(lambda: job_done('archive-project', archive_job['id']))['result']
                    assert archive['status'] == 'verified'
                    api_id = compose('ps', '-q', 'api').stdout.strip()
                    inspected = json.loads(subprocess.check_output(['docker', 'inspect', api_id], text=True))[0]
                    assert not any(inspected['NetworkSettings']['Ports'].values())
                    networks = inspected['NetworkSettings']['Networks']
                    assert project + '_default' in networks
                    network = json.loads(subprocess.check_output(['docker', 'network', 'inspect', project + '_default'], text=True))[0]
                    assert network['Driver'] == 'bridge'
                    post('auth/logout')
                    try:
                        while True:
                            event = json.loads(ws.recv(timeout=5))
                            if event.get('type') == 'ping': ws.send('{"type":"pong"}')
                    except ConnectionClosed as error:
                        assert error.rcvd.code == 4401
                    report = {'status': 'passed', 'compose': subprocess.check_output(['docker', 'compose', 'version', '--short'], text=True).strip(),
                        'image': args.image, 'network_driver': network['Driver'], 'api_port_published': False,
                        'https_certificate_verified': True, 'web_shell_served': True, 'wss_upgrade_and_auth': True,
                        'foreign_origin_rejected': True, 'committed_change_received': True, 'logout_closed_socket': True,
                        'redis_service_dns_and_worker': True, 'recognized_candidate': page['candidate_number'], 'final_score': 3,
                        'archive_verified': True, 'upload_sha256': hashlib.sha256(encoded).hexdigest(),
                        'duration_seconds': round(time.monotonic()-started, 2)}
                    args.report.parent.mkdir(parents=True, exist_ok=True)
                    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
        except subprocess.CalledProcessError as error:
            print((error.stdout or '') + (error.stderr or ''), file=sys.stderr)
            print(compose('logs', '--no-color', '--tail', '40', check=False).stdout, file=sys.stderr)
            raise
        except Exception:
            print(compose('logs', '--no-color', '--tail', '40', check=False).stdout, file=sys.stderr)
            raise
        finally:
            compose('down', '--volumes', '--remove-orphans')


if __name__ == '__main__':
    main()
