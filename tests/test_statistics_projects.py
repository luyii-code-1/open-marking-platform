import shutil
import subprocess
from uuid import uuid4

import cv2
import pytest

from server import statistics_sheet
from server.statistics_projects import aggregate, design


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
        pid, group = project.json()['id'], project.json()['statistics_group_id']
        url = f'/api/v1/projects/{pid}/statistics'
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
