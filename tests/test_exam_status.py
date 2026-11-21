import pytest
from fastapi.testclient import TestClient
from server import db
from server.main import app
from test_scanner_auth import initialize, enroll, connect as scanner_connect


@pytest.fixture
def exam(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    with TestClient(app) as client:
        headers, actor = initialize(client)

        def request(method, path, body=None, status=200, auth=None):
            response = client.request(method, '/api/v1/' + path, json=body, headers=headers if auth is None else auth)
            assert response.status_code == status, response.text
            return response.json()

        project = request('POST', 'projects', {'name': '状态考试', 'exam_status_mode': 'completed', 'exam_status': 'completed'})
        subject = request('POST', 'subjects', {'name': '数学', 'project_id': project['id']})
        classroom = request('POST', 'classes', {'name': '一班'})
        student = request('POST', 'students', {'name': '学生', 'class_id': classroom['id'], 'candidate_number': '123'})

        def card(subject_id=subject['id']):
            group = request('POST', 'groups', {'name': '题卡', 'subject_id': subject_id})
            template = request('POST', 'templates', {'name': '正式题卡', 'group_id': group['id'], 'paper': 'A4', 'sides': 1,
                'candidate_length': 3, 'questions': [{'number': 1, 'type': 'single', 'options': 4, 'points': 2,
                    'answer': ['A'], 'regions': [{'page': 1, 'x': 15, 'y': 110, 'width': 90, 'height': 20}]}]})
            template = request('POST', 'templates/' + template['id'] + '/publish')
            with db.connect() as connection:
                db.put(connection, 'submissions', {'group_id': group['id'], 'template_id': template['id'],
                    'student_id': student['id'], 'candidate_number': '123', 'pages': [], 'status': 'absent'}, actor)
            return group, template

        def project_view(auth=None, query=''):
            return next(p for p in request('GET', 'projects' + query, auth=auth) if p['id'] == project['id'])

        yield dict(client=client, request=request, project=project, subject=subject, card=card,
                   view=project_view, headers=headers, actor=actor, classroom=classroom)


def test_all_subjects_and_cards_publish_reopen_and_legacy_records(exam):
    f=exam; r=f['request']; project=f['project']
    assert project['exam_status']==project['auto_exam_status']=='in_progress'
    assert project['exam_status_mode']=='auto'
    assert f['view']()['exam_status']=='in_progress'  # Empty subject.
    group,_=f['card']()
    empty=r('POST','subjects',{'name':'语文','project_id':project['id']})
    r('POST','results/publish',{'group_id':group['id']})
    assert f['view']()['exam_status']=='in_progress'
    second,_=f['card'](empty['id'])
    third,_=f['card'](empty['id'])
    r('POST','results/publish',{'group_id':second['id']})
    assert f['view']()['exam_status']=='in_progress'
    r('POST','results/publish',{'group_id':third['id']})
    assert f['view']()['exam_status']=='completed'
    r('POST','groups/'+group['id']+'/reopen',{'reason':'成绩复核'})
    assert f['view']()['exam_status']=='in_progress'
    r('POST','results/publish',{'group_id':group['id']})
    assert f['view']()['exam_status']=='completed'
    with db.connect() as connection:
        legacy=db.put(connection,'projects',{'name':'旧归档考试','status':'archived'})
    old=next(p for p in r('GET','projects') if p['id']==legacy['id'])
    assert old['status']=='archived' and old['exam_status']=='in_progress' and old['exam_status_mode']=='auto'


def test_manual_override_persists_and_reset_tracks_current_publication(exam):
    f=exam; r=f['request']; path='projects/'+f['project']['id']+'/exam-status'
    group,_=f['card']()
    manual=r('PUT',path,{'mode':'completed'})
    assert manual['exam_status']=='completed' and manual['auto_exam_status']=='in_progress'
    r('POST','results/publish',{'group_id':group['id']})
    r('POST','groups/'+group['id']+'/reopen',{'reason':'复核'})
    assert f['view']()['exam_status']=='completed' and f['view']()['exam_status_mode']=='completed'
    r('PUT',path,{'mode':'auto'})
    assert f['view']()['exam_status']=='in_progress'
    r('POST','results/publish',{'group_id':group['id']})
    manual=r('PUT',path,{'mode':'in_progress'})
    assert manual['exam_status']=='in_progress' and manual['auto_exam_status']=='completed'
    assert r('PUT',path,{'mode':'auto'})['exam_status']=='completed'
    for body in ({}, {'mode':'draft'}, {'mode':None}, {'mode':'auto','exam_status':'completed'}):
        r('PUT',path,body,422)
    r('PUT','projects/missing/exam-status',{'mode':'auto'},404)
    with db.connect() as connection:
        saved=db.get(connection,f['project']['id'],'projects')
        assert saved['exam_status_mode']=='auto' and 'exam_status' not in saved
        assert connection.execute("SELECT COUNT(*) FROM audit WHERE object_id=? AND actor=? AND action='update'",
            (saved['id'],f['actor'])).fetchone()[0]==4


def test_result_review_uses_current_publication_and_requires_management(exam):
    request = exam['request']
    group, _ = exam['card']()
    card = 'groups/' + group['id']
    publish = {'group_id': group['id']}
    request('POST', 'results/publish', publish)
    workflow = request('GET', card + '/workflow')
    assert (workflow['project_id'], workflow['subject_id']) == (exam['project']['id'], exam['subject']['id'])
    assert workflow['published'] and not workflow['in_review']
    timestamp = workflow['published_at']
    form = {'expected_published_at': timestamp, 'reason': '更正补扫答卷'}
    teacher = {'username':'review-reader','password':'teacher-test-password','name':'教师','role':'teacher'}
    request('POST', 'users', teacher)
    token = request('POST', 'auth/login', teacher)['token']
    request('POST', card + '/reopen', form, 403, auth={'Authorization':'Bearer '+token})
    request('POST', card + '/reopen', {**form,'reason':' '}, 422)
    request('POST', card + '/reopen', {'reason':'继续补扫','scan_only':True}, 409)
    request('POST', card + '/reopen', {**form,'expected_published_at':timestamp-1}, 409)
    assert request('GET', card + '/workflow')['published']
    request('POST', card + '/reopen', form)
    reopened = request('GET', card + '/workflow')
    assert reopened['in_review'] and not reopened['published']
    request('POST', card + '/reopen', form, 409)
    request('POST', 'results/publish', publish)
    request('POST', card + '/reopen', form, 409)
    assert request('GET', card + '/workflow')['published']


def test_publication_blockers_have_scoped_destinations():
    from server.workflow import publication_actions, publication_blockers
    state = dict(template_id=None, missing_answers=[2], open_batches=1, open_exceptions=2,
                 results={'pending':0,'completed':0}, regrades=1)
    actions = publication_actions(state)
    assert publication_blockers(state) == [a['issue'] for a in actions]
    assert [a['section'] for a in actions] == ['template','template','scans','exceptions','marking','roster']
    assert all(a['label'] for a in actions)
    state.update(template_id='published',missing_answers=[],open_batches=0,open_exceptions=0,
                 results={'pending':0,'completed':1},regrades=0)
    assert publication_actions(state) == []


def test_catalog_filtering_and_scanner_read_only_status(exam):
    f=exam; r=f['request']; project=f['project']; group,_=f['card']()
    other=r('POST','projects',{'name':'进行中的另一考试'})
    r('PUT','projects/'+project['id']+'/exam-status',{'mode':'completed'})
    assert {p['id'] for p in r('GET','projects?exam_status=completed')}=={project['id']}
    assert {p['id'] for p in r('GET','projects?exam_status=in_progress')}=={other['id']}
    key,device,_=enroll(f['client'],f['headers']); scanner,_=scanner_connect(f['client'],key,device)
    for auth in (f['headers'],scanner):
        view=f['view'](auth)
        catalog=r('GET','scanner/catalog?exam_status=completed',auth=auth)
        assert [p['id'] for p in catalog['projects']]==[project['id']]
        assert [s['id'] for s in catalog['subjects']]==[f['subject']['id']]
        assert [g['id'] for g in catalog['groups']]==[group['id']]
        assert catalog['projects'][0]['exam_status']==view['exam_status']=='completed'
        package=r('GET','scanner/projects/'+project['id']+'/package',auth=auth)
        assert package['project']['exam_status_mode']=='completed'
        assert package['project']['auto_exam_status']=='in_progress'
        assert package['groups'][0]['frozen'] is False
        assert len(r('GET','scanner/catalog',auth=auth)['projects'])==2
    rows=r('GET','exam-catalog?exam_status=completed')
    assert rows[0]['project_exam_status']=='completed' and rows[0]['project_exam_status_mode']=='completed'
    assert r('GET','exam-catalog?exam_status=in_progress')==[]
    r('PUT','projects/'+project['id']+'/exam-status',{'mode':'auto'},401,auth=scanner)
    for endpoint in ('projects','scanner/catalog','exam-catalog'):
        r('GET',endpoint+'?exam_status=invalid',status=422)


def test_teacher_filter_preserves_visibility_and_uses_whole_exam(exam):
    f=exam; r=f['request']; group,template=f['card']()
    credentials={'username':'teacher','password':'teacher-long-password','name':'阅卷教师','role':'teacher'}
    teacher=r('POST','users',credentials)
    auth={'Authorization':'Bearer '+r('POST','auth/login',credentials)['token']}
    r('PUT','teaching/relation',{'teacher_id':teacher['id'],'class_id':f['classroom']['id'],'subjects':['数学']})
    r('POST','results/publish',{'group_id':group['id']})
    hidden=r('POST','projects',{'name':'不可见考试'})
    r('PUT','projects/'+hidden['id']+'/exam-status',{'mode':'completed'})
    assert [p['id'] for p in r('GET','projects?exam_status=completed',auth=auth)]==[f['project']['id']]
    f['card']()  # An unpublished card outside the teacher's results keeps the exam open.
    assert r('GET','projects?exam_status=completed',auth=auth)==[]
    assert f['view'](auth)['exam_status']=='in_progress'
    r('PUT','projects/'+f['project']['id']+'/exam-status',{'mode':'completed'},403,auth=auth)
