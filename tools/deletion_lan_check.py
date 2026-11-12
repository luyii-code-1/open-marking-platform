"""Validate deletion using a new isolated exam, reusing existing test personnel."""
from pathlib import Path
import hashlib
import shutil
import subprocess
import tempfile
import time
from uuid import uuid4
import cv2
import httpx
from server import paper


def validate(api, revision, inspect_files=None, local_recognition=False, storage_connection_id=None, remote_check=None, forward_check=None, resume_project_id=None):
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
    if resume_project_id:
        response=api.get('projects');response.raise_for_status();project=next(p for p in response.json() if p['id']==resume_project_id)
        response=api.get('subjects');response.raise_for_status();subject=next(s for s in response.json() if s['project_id']==project['id'])
        group_id=subject['default_group_id']
        response=api.get('templates');response.raise_for_status();template=next(t for t in response.json() if t['group_id']==group_id and t['status']=='published')
        questions=template['questions']
        response=api.get('scan-batches');response.raise_for_status();batch=next(b for b in response.json() if b['group_id']==group_id)
        response=api.get('scan-batches/'+batch['id']+'/pages');response.raise_for_status();page_id=response.json()[0]['id']
    else:
        project = post('projects', {'name': '删除验证-' + revision[:10]})
        if storage_connection_id:
            response=api.put(f"projects/{project['id']}/storage",json={'connection_id':storage_connection_id});response.raise_for_status()
        print('隔离验证考试：' + project['id'], flush=True)
        subject = post('subjects', {'project_id': project['id'], 'name': '验证科目', 'group_mode': 'default'})
        group_id = subject['default_group_id']
        questions=[{'number': 1, 'type': 'single', 'options': 4, 'points': 1, 'answer': ['B'], 'regions': [{'page': 1, 'x': 15, 'y': 110, 'width': 90, 'height': 20}]}]
        if forward_check:questions.append({'number':2,'type':'subjective','points':1,'review_mode':'single','regions':[{'page':1,'x':15,'y':150,'width':80,'height':20}]})
        template = post('templates', {'name': '隔离验证卷', 'group_id': group_id, 'paper': 'A4', 'sides': 1, 'candidate_length': len(candidate), 'questions': questions})
        template = post(f"templates/{template['id']}/publish")
        if local_recognition:
            response=api.get(f"scanner/projects/{project['id']}/package");response.raise_for_status();config=response.json()['groups'][0]
            batch=post('scanner/batches/'+str(uuid4()),{'group_id':group_id,'template_id':template['id'],'template_revision':template['revision'],'config_sha256':config['config_sha256'],'capture_mode':'separate','back_order':'same'})
        else:batch = post('scan-batches', {'group_id': group_id, 'back_order': 'same'})
        with tempfile.TemporaryDirectory(prefix='omp-deletion-lan-') as temporary:
            root = Path(temporary)
            response = api.get(f"templates/{template['id']}/pdf"); response.raise_for_status()
            source = root / 'sheet.pdf'; source.write_bytes(response.content)
            subprocess.run([renderer, '-r', '150', '-singlefile', '-png', str(source), str(root / 'sheet')], check=True, capture_output=True, timeout=30)
            image = cv2.imread(str(root / 'sheet.png'), cv2.IMREAD_GRAYSCALE); sx = image.shape[1] / 210; sy = image.shape[0] / 297
            def fill(x, y): cv2.rectangle(image, (round((x - 1.5) * sx), round((y - 1) * sy)), (round((x + 1.5) * sx), round((y + 1) * sy)), 0, -1)
            for col, digit in enumerate(candidate): fill(18 + col * 6, 57 + int(digit) * 3.5)
            _, x, y = paper.bubbles(template['questions'][0], template['questions'][0]['regions'][0])[1]; fill(x, y)
            page_id = str(uuid4())
            if local_recognition:
                from scanner_engine.main import process
                source=root/'pages'/batch['id']/(page_id+'.jpg');source.parent.mkdir(parents=True);content=cv2.imencode('.jpg',image)[1].tobytes();source.write_bytes(content)
                recognized=process(root,{'batch_id':batch['id'],'capture_id':page_id,'side':'front','template':config['template'],'config_sha256':config['config_sha256'],'source_sha256':hashlib.sha256(content).hexdigest()})
                import json
                derived=root/'processed'/page_id
                response=api.post(f"scanner/batches/{batch['id']}/pages",data={'capture_id':page_id,'side':'front','sequence':'1','manifest':json.dumps(recognized)},files={'file':('scan.jpg',content,'image/jpeg'),'normalized':('normalized.png',(derived/'normalized.png').read_bytes(),'image/png'),'cuts':('cuts.zip',(derived/'cuts.zip').read_bytes(),'application/zip')})
            else:response = api.post(f"scan-batches/{batch['id']}/pages", files={'file': ('scan.png', cv2.imencode('.png', image)[1].tobytes(), 'image/png')}, data={'capture_id': page_id, 'side': 'front', 'sequence': '1'})
            response.raise_for_status()
    response = api.get('jobs'); response.raise_for_status()
    if local_recognition:
        assert not any(job['kind']=='process-page' and job.get('payload',{}).get('page_id')==page_id for job in response.json())
    else:
        process_job = next(job for job in response.json() if job['kind'] == 'process-page' and job.get('payload', {}).get('page_id') == page_id)
        wait('jobs/' + process_job['id'], lambda job: job.get('status') == 'completed')
    response = api.get(f"scan-batches/{batch['id']}/pages"); response.raise_for_status(); page = response.json()[0]
    assert page['status'] == 'recognized'
    assert page['candidate_number'] == candidate
    if storage_connection_id:
        response=api.get('jobs');response.raise_for_status()
        for job in response.json():
            if job['kind']=='mirror' and job.get('project_id')==project['id']:wait('jobs/'+job['id'],lambda j:j['status']=='completed')
    if remote_check:remote_check(project['id'],page_id,True,local_recognition)
    if inspect_files:
        state=inspect_files(page_id)
        assert all(state[s] for s in ('.image','.png')+(('.cuts.zip',) if local_recognition else ()))
    post(f"scan-batches/{batch['id']}/pair")
    if forward_check:
        response=api.get('auth/me');response.raise_for_status();person=response.json()
        response=api.get('assignments');response.raise_for_status()
        if not any(a['template_id']==template['id'] and a['question_id']==template['questions'][1]['id'] for a in response.json()):
            post('assignments',{'template_id':template['id'],'question_id':template['questions'][1]['id'],'user_ids':[person['id']]})
        task=post('tasks/claim',{'template_id':template['id'],'question_id':template['questions'][1]['id']})
        forward_check(project,page_id,task,storage_connection_id)
        post('tasks/'+task['id']+'/score',{'score':0,'idempotency_key':str(uuid4())})
    response = api.get('results', params={'group_id': group_id}); response.raise_for_status()
    assert len(response.json()) == 1 and response.json()[0]['total'] == 1
    post('results/publish', {'group_id': group_id})
    job = post(f"projects/{project['id']}/archive-jobs", status=202)
    finished = wait('jobs/' + job['id'], lambda row: row.get('status') == 'completed')
    archive = finished['result']
    response = api.get(f"archives/{archive['id']}/download"); response.raise_for_status()
    digest = hashlib.sha256(response.content).hexdigest(); assert digest == archive['sha256']
    print(('本地识读、服务端校验及后台归档通过' if local_recognition else 'Linux Worker识读、配页、结分及归档通过')+'，正在核对隔离考试删除范围', flush=True)
    plan = post(f"projects/{project['id']}/deletion-preview")
    assert not plan['blockers'] and plan['retained_archives'] == 1
    response = api.get(f"deletion-plans/{plan['id']}/manifest"); response.raise_for_status()
    assert len(response.json()['records']) == plan['record_count'] and len(response.json()['questions']) == len(questions)
    result = post(f"deletion-plans/{plan['id']}/confirm", {'confirm': True, 'reason': '隔离部署验证完成'},status=202)
    finished=wait('jobs/'+result['job_id'],lambda row:row.get('status')=='completed')
    result=finished['result']
    assert result['status']=='completed' and result['file_count']==(3 if local_recognition else 2)
    if inspect_files:assert not any(inspect_files(page_id).values())
    if remote_check:remote_check(project['id'],page_id,False,local_recognition)
    response=api.get(f"archives/{result['archive_id']}/download");response.raise_for_status()
    assert response.content
    assert api.get(f"scan-batches/{batch['id']}").status_code == 404
    response = api.get('projects'); response.raise_for_status()
    assert project['id'] not in {p['id'] for p in response.json()}
    response = api.get(f"archives/{archive['id']}/download"); response.raise_for_status()
    assert hashlib.sha256(response.content).hexdigest() == digest
    response = api.get('archives'); response.raise_for_status()
    assert next(a for a in response.json() if a['id'] == archive['id'])['project_deleted']
    return {'status': 'passed', 'isolated_project_id': project['id'], 'deleted_records': plan['record_count'], 'candidate_recognition': 'passed','local_recognition':local_recognition, 'final_score': 1, 'archive_preserved': True, 'fresh_archive_id':result['archive_id'],'deleted_scan_files':result['file_count'],'physical_local_cleanup_verified':inspect_files is not None, 'physical_remote_cleanup_verified':remote_check is not None,'authenticated_forward_verified':forward_check is not None, 'existing_personnel_reused': True}
