import json
import shutil
import subprocess
from uuid import uuid4

import cv2
import pytest

from server import statistics_sheet
from server.statistics_projects import aggregate, design


def legacy_project(project):
    from server import db
    with db.connect() as connection:
        subject = db.put(connection, 'subjects', {'project_id': project['id'], 'name': '统计题卡'})
        group = db.put(connection, 'groups', {'subject_id': subject['id'], 'name': '统计题卡',
                                             'statistics_group': True, 'roster_mode': 'open'})
        db.put(connection, 'projects', {**project, 'statistics_group_id': group['id']})
    return project['id'], group['id']


def definition(count=11):
    return [{'title': f'第 {i + 1} 题说明', 'type': 'multiple' if i == 1 else 'single', 'options': 26}
            for i in range(count)]


def test_statistics_layout_and_counting():
    questions, sides = design(definition())
    assert sides == 2
    q = questions[0]
    cells = statistics_sheet.bubbles(q, q['regions'][0])
    assert ''.join(c[0] for c in cells) == 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    assert cells[0][2] == cells[12][2] < cells[13][2] == cells[-1][2]
    with pytest.raises(ValueError, match='容量'):
        design(definition(21))
    first, second = (question['id'] for question in questions[:2])
    counts = aggregate({'questions': questions}, [
        {'selections': {first: ['A', 'Z'], second: ['B', 'Z']}},
        {'selections': {first: ['Z'], second: []}},
    ])
    assert counts['total'] == 2
    assert counts['rows'][0]['counts']['Z'] == 1 and counts['rows'][0]['invalid'] == 1
    assert counts['rows'][1]['counts']['B'] == counts['rows'][1]['counts']['Z'] == counts['rows'][1]['blank'] == 1


def test_anonymous_card_print_scan_export_and_idempotent_confirmation(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from server import db, jobs
    from server.main import app
    from server.scanner_pipeline import config_hash

    renderer = shutil.which('pdftoppm')
    if not renderer:
        pytest.skip('Poppler is required to verify printed cards')
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setattr(jobs, 'dispatch', lambda *args, **kwargs: None)
    with TestClient(app) as client:
        account = {'username': 'admin', 'password': 'administrator-password', 'name': '管理员'}
        assert client.post('/api/v1/auth/bootstrap', json=account).is_success
        token = client.post('/api/v1/auth/login', json=account).json()['token']
        client.headers['Authorization'] = f'Bearer {token}'
        project = client.post('/api/v1/projects', json={'name': '选项统计', 'category': 'statistics'})
        assert project.is_success, project.text
        pid, group = legacy_project(project.json())
        url = f'/api/v1/projects/{pid}/statistics'
        preview = client.post(url + '/paper-preview', params={'page': 2}, json={'questions': definition()})
        assert preview.is_success and preview.json()['image'].startswith('data:image/')
        assert (preview.json()['page'],preview.json()['sides']) == (2,2)
        assert client.get(url).json()['draft'] is None
        draft = client.put(url, json={'questions': definition(), 'draft_version': 0})
        assert draft.is_success and draft.json()['template'] is None, draft.text
        assert client.get(url + '/preview').content.startswith(b'%PDF')
        published = client.put(url, json={'questions': definition(), 'draft_version': 1, 'publish': True})
        assert published.is_success, published.text
        t = published.json()['template']
        assert t['sides'] == 2
        pdf = client.get(f"/api/v1/templates/{t['id']}/pdf")
        assert pdf.is_success, pdf.text[:200]
        (tmp_path / 'card.pdf').write_bytes(pdf.content)
        subprocess.run([renderer, '-scale-to-x', '840', '-scale-to-y', '1188', '-gray', '-png',
                        str(tmp_path / 'card.pdf'), str(tmp_path / 'card')], check=True)
        images = [cv2.imread(str(tmp_path / f'card-{i}.png'), cv2.IMREAD_GRAYSCALE) for i in (1, 2)]
        for i, labels in ((0, {'A', 'Z'}), (1, {'B', 'Z'}), (10, {'Z'})):
            q = t['questions'][i]
            region = q['regions'][0]
            for letter, x, y in statistics_sheet.bubbles(q, region):
                if letter in labels:
                    cv2.circle(images[region['page'] - 1], (round(x * 4), round(y * 4)), 5, 0, -1)
        package = f'/api/v1/scanner/projects/{pid}/package'
        assert client.get(package).json()['groups'] == []
        configured = client.get(package, params={'capability': statistics_sheet.CAPABILITY}).json()['groups'][0]
        assert configured['roster'] == [] and configured['config_sha256'] == config_hash(t)
        batch = client.post('/api/v1/scan-batches', json={'group_id': group})
        assert batch.is_success, batch.text
        batch_url = '/api/v1/scan-batches/' + batch.json()['id']
        pages = []
        for side, image in zip(('front', 'back'), images):
            capture = str(uuid4())
            reply = client.post(batch_url + '/pages', data={'side': side, 'sequence': 1, 'capture_id': capture},
                                files={'file': ('scan.png', cv2.imencode('.png', image)[1].tobytes())})
            assert reply.is_success, reply.text
            jobs.process_page(capture)
            pages.append(capture)
        assert client.get(url + '/results').json()['total'] == 0
        assert client.put(url + '/collection', json={'closed': True}).status_code == 409
        assert client.put(url, json={'questions': definition(1), 'draft_version': 2}).status_code == 409
        payload = {'local_pairs': [{'candidate_number': None, 'pages': pages}]}
        for _ in range(2):
            confirmed = client.post(batch_url + '/pair', json=payload)
            assert confirmed.is_success, confirmed.text
        results = client.get(url + '/results').json()
        assert results['total'] == 1 and results['rows'][0]['invalid'] == 1
        assert results['rows'][1]['counts']['Z'] == results['rows'][10]['counts']['Z'] == 1
        assert results['rows'][2]['blank'] == 1
        assert client.get(url + '/export').content.startswith(b'PK')
        assert client.put(url + '/collection', json={'closed': True}).json() == {'closed': True}
        assert client.post('/api/v1/scan-batches', json={'group_id': group}).status_code == 409
        assert client.get(url + '/results').json() == results
        assert client.put(url + '/collection', json={'closed': False}).json() == {'closed': False}
        with db.connect() as connection:
            assert not db.objects(connection, 'students')
            assert not db.objects(connection, 'submissions')


@pytest.mark.parametrize('mode', ['blank', 'completed'])
def test_external_statistics_template_trials_and_counts(monkeypatch, tmp_path, mode):
    from fastapi.testclient import TestClient
    from server import db, jobs
    from server.main import app
    from test_compatible_sheet import box, fill, sheet

    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setattr(jobs, 'dispatch', lambda *args, **kwargs: None)
    template, (image,) = sheet('A4', 1)
    external = template['external_sheet']
    external['mode'] = mode
    external['pages']['1'].pop('candidate', None)
    external['pages']['1'].pop('absent', None)
    cells=[box(14+14*(i%13),140+8*(i//13),4,4) for i in range(26)]
    question=template['questions'][0]
    question.update(number=1, title='匿名多选', type='multiple', options=26, external_options=cells,
                    regions=[{**box(14,140,172,12), 'page':1}])
    template.update(questions=[question], statistics_sheet=True, candidate_length=0)
    original=cv2.imencode('.png',image)[1].tobytes()
    fill(image,cells[0])
    fill(image,cells[-1])
    marked=cv2.imencode('.png',image)[1].tobytes()
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        assert client.post('/api/v1/auth/bootstrap',json=account).is_success
        token=client.post('/api/v1/auth/login',json=account).json()['token']
        client.headers['Authorization']=f'Bearer {token}'
        project=client.post('/api/v1/projects',json={'name':'外部统计','category':'statistics'}).json()
        pid,group=legacy_project(project)
        template['group_id']=group
        stats=f'/api/v1/projects/{pid}/statistics'
        ref=client.post(f'/api/v1/groups/{group}/compatible/reference',data={'paper':'A4'},
                        files={'files':('reference.png',original if mode=='blank' else marked)})
        assert ref.is_success
        if mode=='blank':
            asset=client.post('/api/v1/assets',files={'file':('reference.png',original)})
            assert asset.is_success,asset.text
            template['background_assets']={'1':asset.json()['id']}
        draft=client.put(f"/api/v1/groups/{group}/drafts/{template['id']}",
                         json={'value':template,'base_version':0,'request_id':str(uuid4())})
        assert draft.is_success,draft.text
        assert client.get(stats).json()['external_draft']['id']==template['id']
        path=f"/api/v1/templates/{template['id']}"
        assert client.post(path+'/publish').status_code==422
        trial=client.post(path+'/compatible/trial',data={'side':'front'},files={'file':('trial.png',marked)})
        assert trial.is_success,trial.text[:400]
        assert trial.json()['candidate'] is None
        assert trial.json()['selections'][question['id']]==['A','Z']
        assert client.post(path+'/publish').is_success
        assert client.get(stats).json()['external_draft'] is None
        assert client.get(path+'/pdf').status_code==(200 if mode=='blank' else 422)
        package=f'/api/v1/scanner/projects/{pid}/package'
        assert not client.get(package,params={'capability':'external-sheet-1,statistics-sheet-1'}).json()['groups']
        configured=client.get(package,params={'capability':'external-sheet-1,statistics-sheet-1,statistics-external-1'}).json()['groups'][0]
        assert configured['template']['statistics_sheet'] and configured['roster']==[]
        batch=client.post('/api/v1/scan-batches',json={'group_id':group})
        assert batch.is_success,batch.text
        url='/api/v1/scan-batches/'+batch.json()['id']
        capture=str(uuid4())
        page=client.post(url+'/pages',data={'side':'front','sequence':1,'capture_id':capture},
                         files={'file':('scan.png',marked)})
        assert page.is_success,page.text
        jobs.process_page(capture)
        result=client.post(url+'/pair')
        assert result.is_success,result.text
        row=client.get(stats+'/results').json()['rows'][0]
        assert row['counts']['A']==row['counts']['Z']==1
        with db.connect() as connection:
            assert len(db.objects(connection,'assets'))==(1 if mode=='blank' else 0)


@pytest.mark.parametrize('mode', ['native', 'blank', 'completed'])
def test_statistics_reuses_exam_roster_and_scanner(monkeypatch, tmp_path, mode):
    from fastapi.testclient import TestClient
    from scanner_engine.main import digest, process
    from server import db, jobs
    from server.main import app
    from server.omr import bubbles
    from test_compatible_sheet import box, fill, sheet

    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setattr(jobs, 'dispatch', lambda *args, **kwargs: None)
    with TestClient(app) as client:
        account = {'username': 'admin', 'password': 'administrator-password', 'name': '管理员'}
        client.post('/api/v1/auth/bootstrap', json=account).raise_for_status()
        token = client.post('/api/v1/auth/login', json=account).json()['token']
        client.headers['Authorization'] = f'Bearer {token}'
        project = client.post('/api/v1/projects', json={'name': '选项统计', 'category': 'statistics'}).json()
        assert 'statistics_group_id' not in project
        subject = client.post('/api/v1/subjects', json={'project_id': project['id'], 'name': '问卷'}).json()
        group = client.post('/api/v1/groups', json={'subject_id': subject['id'], 'name': '调查题卡'}).json()
        with db.connect() as connection:
            classroom = db.put(connection, 'classes', {'name': '一班'})
            student = db.put(connection, 'students', {'class_id': classroom['id'], 'name': '考生',
                                                     'candidate_number': '012'})
        if mode == 'native':
            q = {'id': str(uuid4()), 'number': 1, 'type': 'multiple', 'options': 26, 'choice_style': 'compact',
                 'regions': [dict(box(12, 100, 186, 4.6), page=1)]}
            template = {'id': str(uuid4()), 'name': '调查题卡', 'paper': 'A4', 'sides': 2, 'candidate_length': 3,
                        'layout_version': 3, 'print_style': 'standard-v2', 'notice_template': 'none',
                        'notice_layout': 2, 'questions': [q]}
        else:
            template, (image,) = sheet('A4', 1)
            template['external_sheet']['mode'] = mode
            q = template['questions'][0]
            cells = [box(14+14*(i%13), 140+8*(i//13), 4, 4) for i in range(26)]
            q.update(type='multiple', options=26, external_options=cells, regions=[dict(box(14, 140, 172, 12), page=1)])
            template['questions'] = [q]
            if mode == 'blank':
                original = image.copy()
                for column, digit in zip(template['external_sheet']['pages']['1']['candidate'], (0, 1, 2)):
                    fill(original, column[digit], 245)
                original_png = cv2.imencode('.png', original)[1].tobytes()
                asset = client.post('/api/v1/assets', files={'file': ('original.png', original_png)}).raise_for_status().json()
                template['background_assets'] = {'1': asset['id']}
            fill(image, cells[0])
            fill(image, cells[-1])
        template['group_id'] = group['id']
        draft = client.put(f"/api/v1/groups/{group['id']}/drafts/{template['id']}",
                           json={'value': template, 'base_version': 0, 'request_id': str(uuid4())})
        assert draft.is_success, draft.text
        template = draft.json()
        assert template['statistics_mode'] and not template.get('statistics_sheet')
        base = f"/api/v1/templates/{template['id']}"
        if mode != 'native':
            marked = cv2.imencode('.png', image)[1].tobytes()
            trial = client.post(base+'/compatible/trial', data={'side': 'front'}, files={'file': ('trial.png', marked)})
            assert trial.is_success, trial.text
            assert trial.json()['candidate'] == '012'
            assert trial.json()['selections'][q['id']] == ['A', 'Z']
        published = client.post(base+'/publish')
        assert published.is_success, published.text
        template = published.json()
        if mode == 'native':
            renderer = shutil.which('pdftoppm')
            assert renderer
            for face in (1, 2):
                preview = client.post('/api/v1/templates/preview', params={'page': face}, json=template)
                assert preview.is_success and preview.headers['content-type'].startswith('image/'), preview.text[:200]
            filename = tmp_path / 'card.pdf'
            filename.write_bytes(client.get(base+'/pdf').raise_for_status().content)
            subprocess.run([renderer, '-scale-to-x', '840', '-scale-to-y', '1188', '-gray', '-png',
                            str(filename), str(tmp_path / 'card')], check=True)
            image = cv2.imread(str(tmp_path / 'card-1.png'), cv2.IMREAD_GRAYSCALE)
            for index, digit in enumerate((0, 1, 2)):
                cv2.circle(image, ((18+index*6)*4, round((57+digit*3.5)*4)), 6, 0, -1)
            for letter, x, y in bubbles(q, q['regions'][0]):
                if letter in 'AZ':
                    cv2.rectangle(image, (round(x*4)-6, round(y*4)-4), (round(x*4)+6, round(y*4)+4), 0, -1)

        package = client.get(f"/api/v1/scanner/projects/{project['id']}/package", params={'capability': 'external-sheet-1'}).json()
        configured = package['groups'][0]
        assert configured['template']['candidate_length'] == 3
        assert configured['roster'][0]['candidate_number'] == '012'
        batch = client.post('/api/v1/scan-batches', json={'group_id': group['id']}).raise_for_status().json()
        folder = tmp_path / 'pages' / batch['id']
        folder.mkdir(exist_ok=True, parents=True)
        pages = []
        faces = [('front', image)]
        if mode == 'native':
            faces.append(('back', cv2.imread(str(tmp_path / 'card-2.png'), cv2.IMREAD_GRAYSCALE)))
        for side, face in faces:
            capture = str(uuid4())
            pages.append(capture)
            content = cv2.imencode('.png', face)[1].tobytes()
            (folder / (capture + '.png')).write_bytes(content)
            manifest = process(tmp_path, {'batch_id': batch['id'], 'capture_id': capture, 'side': side,
                                         'template': configured['template'], 'config_sha256': configured['config_sha256'],
                                         'source_extension': '.png', 'source_sha256': digest(content)})
            if side == 'front':
                assert manifest['candidate_number'] == '012'
                assert manifest['selections'][q['id']] == ['A', 'Z']
            processed = tmp_path / 'processed' / capture
            uploaded = client.post(f"/api/v1/scanner/batches/{batch['id']}/pages", data={
                'capture_id': capture, 'side': side, 'sequence': 1, 'manifest': json.dumps(manifest),
            }, files={'file': ('source.png', content), 'normalized': ('normalized.png', (processed/'normalized.png').read_bytes()),
                      'cuts': ('cuts.zip', (processed/'cuts.zip').read_bytes())})
            assert uploaded.is_success, uploaded.text
        paired = client.post(f"/api/v1/scan-batches/{batch['id']}/pair",
                             json={'local_pairs': [{'candidate_number': '012', 'pages': pages}]})
        assert paired.is_success, paired.text
        scope = {'group_id': group['id']}
        stats = f"/api/v1/projects/{project['id']}/statistics"
        detail = client.get(stats+'/results', params=scope).raise_for_status().json()
        assert detail['total'] == 1
        assert detail['rows'][0]['counts']['A'] == detail['rows'][0]['counts']['Z'] == 1
        rows = client.get('/api/v1/submissions', params=scope).raise_for_status().json()
        assert rows[0]['student_id'] == student['id']
        changed = client.put(f"/api/v1/submissions/{rows[0]['id']}/objective",
                             json={'reason': '检查原卷', 'selections': {q['id']: ['Z']}})
        assert changed.is_success, changed.text
        detail = client.get(stats+'/results', params=scope).raise_for_status().json()
        assert detail['rows'][0]['counts']['A'] == 0 and detail['rows'][0]['counts']['Z'] == 1
        assert client.get(stats+'/export', params=scope).raise_for_status().content.startswith(b'PK')
        assert client.put(stats+'/collection', params=scope, json={'closed': True}).raise_for_status().json() == {'closed': True}
        assert client.post('/api/v1/results/publish', json={'group_id': group['id']}).status_code == 404
