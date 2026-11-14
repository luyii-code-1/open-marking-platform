from workflow_helpers import close_scanning
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
    assert f['post']('scan-batches',{'group_id':group['id']})['room_tags']==[]
    for tags in ([f['rooms'][1]['id']],[room['id'],f['rooms'][1]['id']]):
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
    r('PUT','teaching/relation',{'class_id':f['cls']['id'],'teacher_id':teacher['id'],'subjects':[],'homeroom':True})
    r('GET','groups/'+group['id']+'/workflow',status=403,auth=auth)
    r('POST','groups/'+group['id']+'/scan-close',{'confirm':True},403,auth=auth)
    r('POST','results/publish',{'group_id':group['id']},409)
    close_scanning(f['client'],group['id'],f['headers'])
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

def test_workflow_membership_changes_and_capture_progress(school):
    f=school;r=f['request'];group=f['groups'][0];base='groups/'+group['id']
    first=r('GET',base+'/workflow')
    assert first['roster_count']==3 and first['room_expected']==2 and not first['roster_needs_review']
    r('POST',base+'/roster/review',{'student_ids':[]},409)
    r('POST',base+'/roster/review',{'student_ids':[s['id'] for s in f['students']]})
    assert not r('GET',base+'/workflow')['roster_needs_review']
    batch,page,_=f['pair'](f['students'][0])
    r('PUT','students/'+f['students'][0]['id'],{'class_id':f['other_cls']['id']})
    changes=r('GET',base+'/roster/changes')
    assert len(changes['removed'])==1 and len(changes['retained'])==1 and not changes['needs_review']
    newcomer=f['post']('students',{'name':'新生','candidate_number':'000000004','class_id':f['cls']['id']})
    assert r('GET',base+'/roster/changes')['added'][0]['id']==newcomer['id']
    state=r('GET',base+'/workflow')
    assert state['batches'][0]['received_pages']==1 and state['batches'][0]['linked_pages']==1
    assert next(b for b in r('GET','scan-batches') if b['id']==batch['id'])['linked_pages']==1
    assert state['results']['completed']==1 and state['scanned']==1
    with db.connect() as connection:
        db.put(connection,'submissions',{'group_id':group['id'],'student_id':f['students'][1]['id'],'status':'absent','pages':[],'room_tags':[f['rooms'][0]],'template_id':f['templates'][0]['id'],'candidate_number':f['students'][1]['candidate_number']})
    room=r('GET','room-tags?group_id='+group['id'])[0]
    assert room['scanned_students']==1 and room['confirmed_absent']==1 and room['remaining_students']==0

def test_scan_close_publication_and_absent_mark_remain_distinct(school):
    f=school;r=f['request'];g=f['groups'][0];base='groups/'+g['id'];t=f['templates'][0]
    batch,page,_=f['pair'](f['students'][0])
    # A scanned attendance mark, rather than the expected headcount, establishes absence.
    second=f['post']('scan-batches',{'group_id':g['id'],'room_tag_ids':[f['rooms'][0]['id']]})
    with db.connect() as c:
        db.put(c,'pages',{'batch_id':second['id'],'side':'front','sequence':1,'status':'recognized','candidate_number':f['students'][1]['candidate_number'],'absent_mark':True,'selections':{}})
    f['post']('scan-batches/'+second['id']+'/pair')
    state=r('GET',base+'/workflow');assert state['results']['absent']==1 and state['results']['unscanned']==1
    r('POST',base+'/scan-close',{'confirm':True,'signature':state['scan_signature']})
    r('POST',base+'/roster/review',{'student_ids':[s['id'] for s in f['students']]})
    state=r('GET',base+'/workflow');r('POST',base+'/scan-close',{'confirm':True,'signature':state['scan_signature']})
    r('POST','results/publish',{'group_id':g['id']},409)
    r('POST','results/publish',{'group_id':g['id'],'force_unscanned':True,'reason':'缺页已登记'})
    rows=r('GET','results?group_id='+g['id']);assert sorted(x['status'] for x in rows)==['absent','completed','unscanned']
    assert next(x for x in rows if x['status']=='unscanned')['total'] is None
    r('POST',base+'/reopen',{'reason':'补扫核查'})
    assert not r('GET',base+'/workflow')['scan_closed']
    state=r('GET',base+'/workflow')
    f['post']('students',{'name':'新生','candidate_number':'000000005','class_id':f['cls']['id']})
    r('POST',base+'/scan-close',{'confirm':True,'signature':state['scan_signature']},409)


def test_official_layout_and_scoring_impact(school):
    f=school;r=f['request'];g=f['groups'][0];t=f['templates'][0];base='groups/'+g['id']
    draft=r('POST','templates',{'group_id':g['id'],'name':'第二版式','paper':'A4','sides':1})
    assert draft['status']=='draft'
    r('POST','templates/'+draft['id']+'/publish',{},409)
    f['pair'](f['students'][0])
    close_scanning(f['client'],g['id'],f['headers'])
    r('POST','results/publish',{'group_id':g['id'],'force_unscanned':True,'reason':'核对后发布'})
    q=t['questions'][0];body={'questions':[{'id':q['id'],'answer':['B'],'rule':{'mode':'exact'}}]}
    preview=r('POST','templates/'+t['id']+'/scoring-preview',body)
    assert preview['published'] and preview['changed_scores']==1 and preview['rows'][0]['before']==2 and preview['rows'][0]['after']==0
    r('PUT','templates/'+t['id']+'/scoring',{**body,'confirm':True,'reason':'修订答案','preview_sha':'stale'},409)
    applied=r('PUT','templates/'+t['id']+'/scoring',{**body,'confirm':True,'reason':'修订答案','preview_sha':preview['preview_sha']})
    assert applied['scoring_revision']==2 and not r('GET',base+'/workflow')['published']
    assert r('GET','results?group_id='+g['id'])[0]['total']==0
    r('POST','templates/'+t['id']+'/scoring-preview',{'questions':[{'id':q['id'],'points':100}]},422)
    empty=f['post']('scan-batches',{'group_id':g['id'],'room_tag_ids':[f['rooms'][0]['id']]})
    r('POST','scan-batches/'+empty['id']+'/finish-empty',{'confirm':True})
    assert next(b for b in r('GET','scan-batches') if b['id']==empty['id'])['completed_empty']

def test_optional_room_can_be_assigned_after_scan(school):
    f=school
    batch,page,result=f['pair'](f['students'][0])
    group=f['groups'][0]
    answer=f['request']('GET','submissions?group_id='+group['id'])[0]
    with db.connect() as connection:
        db.put(connection,'submissions',{**answer,'room_tags':[]})
    route='scanner/submissions/'+answer['id']+'/room'
    f['request']('POST',route,{'room_id':f['rooms'][1]['id']},422)
    f['post'](route,{'room_id':f['rooms'][0]['id']})
    assert f['request']('GET','room-tags?group_id='+group['id'])[0]['scanned_students']==1

def test_catalog_exam_creation_and_roster_snapshot(school):
    f=school;r=f['request'];grade=f['grade']['id'];students=[s['id'] for s in f['students']]
    body={'grade_id':grade,'subject':'物理','kind':'elective','student_ids':students[:1]}
    item=r('PUT','electives',body)
    other=r('PUT','electives',{**body,'grade_id':f['other_grade']['id'],'kind':'required','student_ids':[]})
    project=r('POST','projects',{'name':'期中','catalog_ids':[item['id'],other['id']]})
    subjects=[s for s in r('GET','subjects') if s['project_id']==project['id']]
    assert len(subjects)==1 and len(subjects[0]['grade_ids'])==2
    assert not any(g['subject_id']==subjects[0]['id'] for g in r('GET','groups'))
    card=r('POST','groups',{'name':'物理题卡','subject_id':subjects[0]['id'],'grade_id':grade})
    base='groups/'+card['id']+'/roster'
    def roster():return {s['id'] for s in r('GET',base)['students']}
    assert roster()==set(students[:1])
    r('POST',base+'/add-students',{'student_ids':[students[2]]})
    r('PUT','electives',{**body,'student_ids':students[1:2]})
    assert roster()=={students[0],students[2]}
    r('POST',base+'/elective')
    assert roster()==set(students[1:])
