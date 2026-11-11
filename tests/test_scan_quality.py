import io
import json
from uuid import uuid4
from PIL import Image
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from server import db, jobs, paper
from server.main import app
from server.scan_quality import parse


def report():
    return {'issues': ['blur'], 'dpi': 300, 'sharpness': 12.5, 'corners': 4,
            'options': {'checkQr': True, 'checkCorners': True, 'checkSharpness': True, 'minDpi': 150, 'minSharpness': 35}}


@pytest.mark.parametrize('invalid', ['null', '[]', '{', 'x' * 4097,
    json.dumps({**report(), 'sharpness': float('nan')}),
    json.dumps({**report(), 'issues': ['unknown']}),
    json.dumps({**report(), 'options': {**report()['options'], 'checkQr': 1}})])
def test_invalid_quality_report_is_rejected(invalid):
    with pytest.raises(HTTPException) as caught: parse(invalid)
    assert caught.value.status_code == 422
    assert parse('{}') is None


def test_quality_evidence_freezes_until_admin_review_and_preserves_idempotency(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setattr(jobs, 'queue', lambda *args, **kwargs: None)
    output = io.BytesIO(); Image.new('L', (1000, 1400), 255).save(output, format='PNG')
    with TestClient(app) as client:
        account = {'username': 'admin', 'password': 'administrator-password', 'name': '管理员'}
        client.post('/api/v1/auth/bootstrap', json=account)
        headers = {'Authorization': 'Bearer ' + client.post('/api/v1/auth/login', json=account).json()['token']}
        with db.connect() as connection:
            project = db.put(connection, 'projects', {'name': '质量检查'})
            subject = db.put(connection, 'subjects', {'project_id': project['id'], 'name': '数学'})
            group = db.put(connection, 'groups', {'subject_id': subject['id'], 'name': '组'})
            template = db.put(connection, 'templates', {'group_id': group['id'], 'revision': 1, 'sides': 1})
            batch = db.put(connection, 'scan-batches', {'group_id': group['id'], 'template_id': template['id'], 'status': 'front'})
        monkeypatch.setattr(paper, 'decode', lambda data: (None, paper.code(template, 'front')))
        capture = str(uuid4())
        url = f"/api/v1/scan-batches/{batch['id']}"
        data = {'capture_id': capture, 'side': 'front', 'sequence': '1', 'quality_report': json.dumps(report())}
        def upload(form=data):
            return client.post(url + '/pages', data=form, files={'file': ('page.png', output.getvalue(), 'image/png')}, headers=headers)
        rejected = upload({**data, 'quality_report': 'null'})
        assert rejected.status_code == 422 and not (tmp_path / 'pages' / (capture + '.image')).exists()
        response = upload()
        assert response.status_code == 200 and response.json()['quality_review_required'] is True
        assert response.json()['scanner_quality'] == report()
        assert upload().status_code == 200
        assert client.get(url, headers=headers).json()['status'] == 'frozen'
        exceptions = client.get('/api/v1/exceptions', params={'group_id': group['id']}, headers=headers).json()
        assert len(exceptions) == 1 and exceptions[0]['source'] == 'scanner'
        assert exceptions[0]['evidence'] == report()
        assert client.post(url + '/resume', json={'reason': '继续扫描'}, headers=headers).status_code == 409
        resolved = client.post(f"/api/v1/exceptions/{exceptions[0]['id']}/resolve", json={'resolution': '核对整页及原图，可用于阅卷'}, headers=headers)
        assert resolved.status_code == 200
        assert client.post(url + '/resume', json={'reason': '质量已核查'}, headers=headers).status_code == 200
        page = client.get(url + '/pages', headers=headers).json()[0]
        assert page['scanner_quality'] == report()
        assert (tmp_path / 'pages' / (capture + '.image')).read_bytes() == output.getvalue()
