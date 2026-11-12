"""Validate deletion using a new isolated exam, reusing existing test personnel."""
from pathlib import Path
import hashlib
import shutil
import subprocess
import tempfile
import time
import cv2
import httpx
from server import paper


def validate(api, revision):
    renderer = shutil.which('pdftoppm')
    if not renderer: raise RuntimeError('需要Poppler验证实际扫描链路')
    def post(path, body=None, status=200):
        response = api.post(path, json=body)
        assert response.status_code == status, (path, response.status_code, response.text[:200])
        return response.json()
    def wait(path, finished):
        print('等待已创建任务：' + path, flush=True)
        next_report = time.monotonic() + 15
        while True:
            try: response = api.get(path)
            except httpx.TransportError:
                print('任务观测连接暂时失败，继续查询原任务：' + path, flush=True); time.sleep(1); continue
            if response.status_code >= 500:
                time.sleep(1); continue
            response.raise_for_status(); value = response.json()
            if finished(value): return value
            if value.get('status') in ('failed', 'needs_review', 'quarantined'): raise RuntimeError('隔离验证任务未完成：' + str(value.get('status')))
            if time.monotonic() >= next_report:
                print('原任务状态：' + path + ' ' + str(value.get('status')), flush=True); next_report = time.monotonic() + 15
            time.sleep(.4)
    response = api.get('students'); response.raise_for_status()
    student = next(s for s in response.json() if str(s['candidate_number']).isdigit() and 1 <= len(str(s['candidate_number'])) <= 20)
    candidate = str(student['candidate_number'])
    project = post('projects', {'name': '删除验证-' + revision[:10]})
    print('隔离验证考试：' + project['id'], flush=True)
    subject = post('subjects', {'project_id': project['id'], 'name': '验证科目', 'group_mode': 'default'})
    group_id = subject['default_group_id']
    template = post('templates', {'name': '隔离验证卷', 'group_id': group_id, 'paper': 'A4', 'sides': 1, 'candidate_length': len(candidate), 'questions': [{'number': 1, 'type': 'single', 'options': 4, 'points': 1, 'answer': ['B'], 'regions': [{'page': 1, 'x': 15, 'y': 110, 'width': 90, 'height': 20}]}]})
    template = post(f"templates/{template['id']}/publish")
    batch = post('scan-batches', {'group_id': group_id, 'back_order': 'same'})
    with tempfile.TemporaryDirectory(prefix='omp-deletion-lan-') as temporary:
        root = Path(temporary)
        response = api.get(f"templates/{template['id']}/pdf"); response.raise_for_status()
        source = root / 'sheet.pdf'; source.write_bytes(response.content)
        subprocess.run([renderer, '-r', '150', '-singlefile', '-png', str(source), str(root / 'sheet')], check=True, capture_output=True, timeout=30)
        image = cv2.imread(str(root / 'sheet.png'), cv2.IMREAD_GRAYSCALE); sx = image.shape[1] / 210; sy = image.shape[0] / 297
        def fill(x, y): cv2.rectangle(image, (round((x - 1.5) * sx), round((y - 1) * sy)), (round((x + 1.5) * sx), round((y + 1) * sy)), 0, -1)
        for col, digit in enumerate(candidate): fill(18 + col * 6, 57 + int(digit) * 3.5)
        _, x, y = paper.bubbles(template['questions'][0], template['questions'][0]['regions'][0])[1]; fill(x, y)
        from uuid import uuid4
        page_id = str(uuid4())
        response = api.post(f"scan-batches/{batch['id']}/pages", files={'file': ('scan.png', cv2.imencode('.png', image)[1].tobytes(), 'image/png')}, data={'capture_id': page_id, 'side': 'front', 'sequence': '1'})
        response.raise_for_status()
    response = api.get('jobs'); response.raise_for_status()
    process_job = next(job for job in response.json() if job['kind'] == 'process-page' and job.get('payload', {}).get('page_id') == page_id)
    wait('jobs/' + process_job['id'], lambda job: job.get('status') == 'completed')
    response = api.get(f"scan-batches/{batch['id']}/pages"); response.raise_for_status(); page = response.json()[0]
    assert page['status'] == 'recognized'
    assert page['candidate_number'] == candidate
    post(f"scan-batches/{batch['id']}/pair")
    response = api.get('results', params={'group_id': group_id}); response.raise_for_status()
    assert len(response.json()) == 1 and response.json()[0]['total'] == 1
    post('results/publish', {'group_id': group_id})
    job = post(f"projects/{project['id']}/archive-jobs", status=202)
    finished = wait('jobs/' + job['id'], lambda row: row.get('status') == 'completed')
    archive = finished['result']
    response = api.get(f"archives/{archive['id']}/download"); response.raise_for_status()
    digest = hashlib.sha256(response.content).hexdigest(); assert digest == archive['sha256']
    print('Linux Worker识读、配页、结分及归档通过，正在核对隔离考试删除范围', flush=True)
    plan = post(f"projects/{project['id']}/deletion-preview")
    assert not plan['blockers'] and plan['retained_archives'] == 1
    response = api.get(f"deletion-plans/{plan['id']}/manifest"); response.raise_for_status()
    assert len(response.json()['records']) == plan['record_count'] and len(response.json()['questions']) == 1
    result = post(f"deletion-plans/{plan['id']}/confirm", {'confirm': True, 'reason': '隔离部署验证完成'})
    assert result['status'] == 'completed'
    assert api.get(f"scan-batches/{batch['id']}").status_code == 404
    response = api.get('projects'); response.raise_for_status()
    assert project['id'] not in {p['id'] for p in response.json()}
    response = api.get(f"archives/{archive['id']}/download"); response.raise_for_status()
    assert hashlib.sha256(response.content).hexdigest() == digest
    response = api.get('archives'); response.raise_for_status()
    assert next(a for a in response.json() if a['id'] == archive['id'])['project_deleted']
    return {'status': 'passed', 'isolated_project_id': project['id'], 'deleted_records': plan['record_count'], 'candidate_recognition': 'passed', 'final_score': 1, 'archive_preserved': True, 'existing_personnel_reused': True}
