from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from server import db
from server.main import app


@pytest.fixture
def school(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    with TestClient(app) as client:
        account={'username':'admin','password':'test-administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        def request(method,path,body=None,status=200,auth=None):
            result=client.request(method,'/api/v1/'+path,json=body,headers=auth or headers)
            assert result.status_code==status,result.text
            return result.json() if result.headers.get('content-type','').startswith('application/json') else result
        def post(path,body=None,status=200):return request('POST',path,body,status)
        grade=post('grades',{'name':'高一'});other_grade=post('grades',{'name':'高二'})
        cls=post('classes',{'name':'一班','grade_id':grade['id']});other_cls=post('classes',{'name':'二班','grade_id':other_grade['id']})
        students=[post('students',{'name':'学生'+str(n),'candidate_number':str(n).zfill(9),'class_id':cls['id']}) for n in (1,2,3)]
        project=post('projects',{'name':'学情诊断'});subject=post('subjects',{'name':'语文','project_id':project['id'],'group_mode':'custom'})
        groups=[post('groups',{'name':name,'subject_id':subject['id'],'grade_id':g['id']}) for name,g in (('高一组',grade),('高二组',other_grade))]
        templates=[]
        for group in groups:
            template=post('templates',{'group_id':group['id'],'name':'题卡','paper':'A4','sides':1,'questions':[{'number':1,'type':'single','options':4,'answer':['A'],'points':2,'regions':[{'page':1,'x':15,'y':100,'width':60,'height':16}]}]})
            templates.append(post('templates/'+template['id']+'/publish'))
        rooms=[post('projects/'+project['id']+'/room-tags',{'name':'01','group_id':g['id'],'expected_students':2},201) for g in groups]
        def pair(student,room=rooms[0],group=groups[0],template=templates[0]):
            batch=post('scan-batches',{'group_id':group['id'],'room_tag_ids':[room['id']]})
            with db.connect() as connection:
                page=db.put(connection,'pages',{'batch_id':batch['id'],'template_id':template['id'],'side':'front','sequence':1,'status':'recognized','candidate_number':student['candidate_number'],'selections':{template['questions'][0]['id']:['A']}})
            result=post('scan-batches/'+batch['id']+'/pair')
            return batch,page,result
        yield locals()


def test_current_grade_membership_and_id_mapped_results(school):
    f=school;r=f['request'];group=f['groups'][0];s=f['students'][0]
    roster=lambda:r('GET','groups/'+group['id']+'/roster')['students']
    assert len(roster())==3
    f['pair'](s)
    r('PUT','students/'+s['id'],{'class_id':f['other_cls']['id'],'name':'新姓名','candidate_number':'000000011'})
    assert len(roster())==2 and s['id'] not in {v['id'] for v in roster()}
    rows=r('GET','results?group_id='+group['id']);saved=next(v for v in rows if v['student_id']==s['id'])
    assert saved['candidate_number']=='000000011' and saved['scanned_candidate_number']==s['candidate_number']
    assert saved['name']=='新姓名' and saved['grade']=='高二' and saved['class_name']=='二班' and saved['total']==2
    assert len(rows)==3 and sum(v['status']=='unscanned' for v in rows)==2
    r('PUT','grades/'+f['other_grade']['id'],{'name':'高二年级'})
    assert next(v for v in r('GET','results?group_id='+group['id']) if v['student_id']==s['id'])['grade']=='高二年级'
    newcomer=f['post']('students',{'name':'新生','candidate_number':'000000004','class_id':f['cls']['id']})
    assert newcomer['id'] in {s['id'] for s in roster()}
    r('PUT','groups/'+group['id']+'/roster',{'student_ids':[]},409)


def test_room_scope_expected_count_and_duplicate_guard(school):
    f=school;r=f['request'];group=f['groups'][0];room=f['rooms'][0]
    # Same physical room number is valid for a different grade/card group.
    assert f['rooms'][1]['name']==room['name'] and f['rooms'][1]['group_id']!=room['group_id']
    for tags in ([],[f['rooms'][1]['id']],[room['id'],f['rooms'][1]['id']]):
        r('POST','scan-batches',{'group_id':group['id'],'room_tag_ids':tags},422)
    r('POST','projects/'+f['project']['id']+'/room-tags',{'name':'01','group_id':group['id'],'expected_students':3},409)
    r('POST','projects/'+f['project']['id']+'/room-tags',{'name':'02','group_id':group['id'],'expected_students':-1},422)
    batch,page,_=f['pair'](f['students'][0])
    tag=r('GET','room-tags?group_id='+group['id'])[0]
    assert tag['expected_students']==2 and tag['scanned_students']==1 and tag['remaining_students']==1 and tag['pending_pages']==0
    r('PUT','room-tags/'+room['id'],{'expected_students':1,'name':'第一考场'})
    tag=r('GET','room-tags?group_id='+group['id'])[0]
    assert tag['remaining_students']==0 and tag['label']=='高一－第一考场'
    rows=r('GET','results?group_id='+group['id']+'&room_tag_id='+room['id'])
    assert len(rows)==1 and rows[0]['room_tags'][0]['name']=='第一考场'
    r('PUT','groups/'+group['id']+'/grade',{'grade_id':f['other_grade']['id']},409)
    r('PUT','room-tags/'+room['id'],{'group_id':f['groups'][1]['id']},409)
    r('PUT','room-tags/'+room['id'],{'group_id':''},422)


def test_scanner_package_and_native_batch_apply_same_scope(school):
    f=school;r=f['request'];group=f['groups'][0]
    package=r('GET','scanner/projects/'+f['project']['id']+'/package')
    item=next(g for g in package['groups'] if g['id']==group['id'])
    assert item['grade_id']==f['grade']['id'] and item['grade_name']=='高一' and len(item['roster'])==3
    assert 'answer' not in item['template']['questions'][0]
    room=next(v for v in package['room_tags'] if v['group_id']==group['id'])
    assert room['expected_students']==2 and room['grade_name']=='高一'
    body={'group_id':group['id'],'template_id':item['template']['id'],'template_revision':item['template']['revision'],'config_sha256':item['config_sha256'],'capture_mode':'separate','back_order':'same'}
    r('POST','scanner/batches/'+str(uuid4()),{**body,'room_tag_ids':[f['rooms'][1]['id']]},422)
    key=str(uuid4());created=r('POST','scanner/batches/'+key,{**body,'room_tag_ids':[room['id']]})
    assert created['grade_id']==f['grade']['id']
    assert r('POST','scanner/batches/'+key,{**body,'room_tag_ids':[room['id']]})['id']==key


def test_exports_archive_and_deletion_preserve_global_school(school):
    f=school;r=f['request'];group=f['groups'][0];f['pair'](f['students'][0])
    for path in ('results/export?group_id='+group['id'],'analysis/group/export?view=students&group_id='+group['id'],'exports/scans?group_id='+group['id']):
        response=f['client'].get('/api/v1/'+path,headers=f['headers'])
        assert response.status_code==200,response.text
        assert '高一' in response.text
    from server.archive import collect
    from server.deletion import scope
    with db.connect() as connection:
        _,records,_=collect(connection,f['project']['id'])
        assert any(v['kind']=='grades' and v['data']['id']==f['grade']['id'] for v in records)
        assert {s['id'] for s in f['students']}<={v['data']['id'] for v in records}
        scope(connection,'groups',group['id'])
        selected={row[0] for row in connection.execute('SELECT id FROM deletion_scope')}
        assert f['rooms'][0]['id'] in selected and f['grade']['id'] not in selected and f['cls']['id'] not in selected


def test_live_teacher_scope_and_unscanned_force_publication(school):
    f=school;r=f['request'];group=f['groups'][0];f['pair'](f['students'][0])
    account={'username':'teacher','password':'teacher-password-long','name':'教师','role':'teacher'}
    teacher=f['post']('users',account);auth={'Authorization':'Bearer '+f['client'].post('/api/v1/auth/login',json=account).json()['token']}
    r('PUT','classes/'+f['cls']['id'],{'teacher_ids':[teacher['id']]})
    r('POST','results/publish',{'group_id':group['id']},409)
    r('POST','results/publish',{'group_id':group['id'],'force_unscanned':True,'reason':'选科未参加'})
    rows=r('GET','results?group_id='+group['id'],auth=auth)
    assert sum(v['status']=='unscanned' and v['total'] is None for v in rows)==2
    r('PUT','students/'+f['students'][0]['id'],{'class_id':f['other_cls']['id']})
    rows=r('GET','results?group_id='+group['id'],auth=auth)
    assert len(rows)==2 and all(v['student_id']!=f['students'][0]['id'] for v in rows)
    r('PUT','classes/'+f['cls']['id'],{'teacher_ids':[]})
    r('GET','results?group_id='+group['id'],status=403,auth=auth)


def test_legacy_grade_migration_is_idempotent(school):
    from server.school import migrate
    with db.connect() as connection:
        cls=db.put(connection,'classes',{'name':'旧班级','grade':'高三'})
    migrate();migrate()
    with db.connect() as connection:
        current=db.get(connection,cls['id'],'classes')
        assert current['grade_id'] and db.get(connection,current['grade_id'],'grades')['name']=='高三'
        assert len([g for g in db.objects(connection,'grades') if g['name']=='高三'])==1


def test_existing_group_can_explicitly_adopt_grade_membership(school):
    f=school;r=f['request']
    group=f['post']('groups',{'name':'原有题卡组','subject_id':f['subject']['id']})
    with db.connect() as connection:
        db.put(connection,'submissions',{'group_id':group['id'],'student_id':f['students'][0]['id'],'template_id':f['templates'][0]['id'],'candidate_number':f['students'][0]['candidate_number'],'status':'absent','pages':[]})
    changed=r('PUT','groups/'+group['id']+'/grade',{'grade_id':f['grade']['id']})
    assert changed['grade_id']==f['grade']['id']
    assert len(r('GET','groups/'+group['id']+'/roster')['students'])==3
