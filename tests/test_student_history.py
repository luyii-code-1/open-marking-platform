import csv
import io
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from server import db
from server.main import app


@pytest.mark.parametrize('with_roster', [False, True])
def test_promotion_and_transfer_preserve_exam_class_labels(tmp_path, monkeypatch, with_roster):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        account = {'username': 'admin', 'password': 'administrator-password', 'name': '管理员'}
        client.post('/api/v1/auth/bootstrap', json=account).raise_for_status()
        headers = {'Authorization': 'Bearer ' + client.post('/api/v1/auth/login', json=account).json()['token']}
        with db.connect() as connection:
            project = db.put(connection, 'projects', {'name': '高一期末'})
            subject = db.put(connection, 'subjects', {'project_id': project['id'], 'name': '语文'})
            group = db.put(connection, 'groups', {'subject_id': subject['id'], 'name': 'Default'})
            cls = db.put(connection, 'classes', {'name': '高一一班', 'grade': 10})
            other = db.put(connection, 'classes', {'name': '新班级', 'grade': 11})
            students = [db.put(connection, 'students', {'name': f'学生{i}', 'candidate_number': str(i), 'class_id': cls['id']}) for i in range(3)]
            question = {'id': str(uuid4()), 'number': 1, 'type': 'single', 'points': 5, 'answer': ['A'], 'regions': []}
            template = db.put(connection, 'templates', {'name': '试卷', 'group_id': group['id'], 'sides': 1, 'questions': [question]})
            group['template_id'] = template['id']
            db.put(connection, 'groups', group)
            batch = db.put(connection, 'scan-batches', {'group_id': group['id'], 'template_id': template['id'], 'status': 'open'})
            db.put(connection, 'pages', {'batch_id': batch['id'], 'side': 'front', 'sequence': 1, 'candidate_number': '0', 'status': 'recognized', 'selections': {question['id']: ['A']}})
        if with_roster:
            client.put(f"/api/v1/groups/{group['id']}/roster", json={'class_ids': [cls['id']]}, headers=headers).raise_for_status()
        client.post(f"/api/v1/scan-batches/{batch['id']}/pair", headers=headers).raise_for_status()
        client.post(f"/api/v1/groups/{group['id']}/absent", json={'student_id': students[1]['id'], 'reason': '核实缺考'}, headers=headers).raise_for_status()
        with db.connect() as connection:
            for submission in db.find(connection, 'submissions', group_id=group['id']):
                assert submission['student_snapshot']['class_name'] == '高一一班'
                assert submission['student_snapshot']['grade'] == 10
        client.post('/api/v1/classes/promote', json={'class_ids': [cls['id']]}, headers=headers).raise_for_status()
        client.put(f"/api/v1/classes/{cls['id']}", json={'name': '高二一班'}, headers=headers).raise_for_status()
        for student in students:
            client.put(f"/api/v1/students/{student['id']}", json={'name': '现在的名字', 'class_id': other['id']}, headers=headers).raise_for_status()
        rows = client.get('/api/v1/results', params={'group_id': group['id']}, headers=headers).json()
        assert len(rows) == (3 if with_roster else 2)
        assert all(row['class_name'] == '高一一班' and row['grade'] == 10 and row['class_id'] == cls['id'] for row in rows)
        assert {row['status'] for row in rows} == ({'completed', 'absent', 'unscanned'} if with_roster else {'completed', 'absent'})
        assert rows[0]['name'] == '学生0'
        analysis = client.get('/api/v1/analysis/group', params={'group_id': group['id']}, headers=headers).json()
        assert analysis['classes'][0]['name'] == '高一一班' and analysis['classes'][0]['grade'] == 10
        project_data = client.get('/api/v1/analysis/project', params={'project_id': project['id']}, headers=headers).json()
        assert all(s['class_name'] == '高一一班' and s['grade'] == 10 for s in project_data['students'])
        for endpoint, params in [('group', {'group_id': group['id'], 'view': 'students'}), ('project', {'project_id': project['id']})]:
            response = client.get(f'/api/v1/analysis/{endpoint}/export', params=params, headers=headers)
            response.raise_for_status()
            exported = list(csv.reader(io.StringIO(response.content.decode('utf-8-sig'))))
            assert all(row[2] == '高一一班' for row in exported[1:])
        if with_roster:
            # Earlier submissions may lack class label fields; a matching saved roster is authoritative.
            with db.connect() as connection:
                submission = db.find(connection, 'submissions', group_id=group['id'])[0]
                submission['student_snapshot'].pop('class_name')
                submission['student_snapshot'].pop('grade')
                db.put(connection, 'submissions', submission)
            row = client.get('/api/v1/results', params={'group_id': group['id']}, headers=headers).json()[0]
            assert row['class_name'] == '高一一班' and row['grade'] == 10
