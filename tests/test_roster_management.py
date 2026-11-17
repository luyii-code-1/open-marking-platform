from test_grade_rooms import school
from server import db
from uuid import uuid4


def test_candidates_show_all_allowed_students_and_supplement_is_idempotent(school):
    f=school;r=f['request'];group=f['groups'][0]
    base='groups/'+group['id']+'/roster'
    candidates=r('GET',base+'/candidates')
    assert len(candidates['students'])==3
    assert all(s['in_roster'] and s['grade_id']==f['grade']['id'] for s in candidates['students'])
    assert {c['id'] for c in candidates['classes']}=={f['cls']['id']}
    outcome=r('POST',base+'/add-students',{'student_ids':[f['students'][0]['id']]})
    assert outcome=={'count':3,'added':0}
    assert r('GET',base)['mode']=='grade'
    with db.connect() as conn:
        assert not db.get(conn,group['id'],'groups').get('roster_id')


def test_candidates_include_existing_and_available_students_and_keep_grade_scope(school):
    f=school;r=f['request']
    r('PUT','electives',{'grade_id':f['grade']['id'],'subject':f['subject']['name'],'kind':'elective','student_ids':[f['students'][0]['id']]})
    group=f['post']('groups',{'name':'选科题卡','subject_id':f['subject']['id'],'grade_id':f['grade']['id']})
    base='groups/'+group['id']+'/roster'
    candidates=r('GET',base+'/candidates')['students']
    assert len(candidates)==3 and sum(s['in_roster'] for s in candidates)==1
    outcome=r('POST',base+'/add-students',{'student_ids':[f['students'][0]['id'],f['students'][1]['id']]})
    assert outcome=={'count':2,'added':1}
    assert sum(s['in_roster'] for s in r('GET',base+'/candidates')['students'])==2
    outside=f['post']('students',{'name':'其他年级学生','candidate_number':'000000999','class_id':f['other_cls']['id']})
    assert outside['id'] not in {s['id'] for s in r('GET',base+'/candidates')['students']}
    r('POST',base+'/add-students',{'student_ids':[f['students'][2]['id'],outside['id']]},status=422)
    assert len(r('GET',base)['students'])==2


def test_remove_members_keeps_scanned_and_scored_business_records(school):
    f=school;r=f['request']
    group=f['post']('groups',{'name':'名单管理题卡','subject_id':f['subject']['id'],'grade_id':f['grade']['id']})
    template=f['post']('templates',{'group_id':group['id'],'name':'主观题卡','paper':'A4','sides':1,'questions':[{'number':1,'type':'subjective','points':10,'review_mode':'single','regions':[{'page':1,'x':15,'y':100,'width':60,'height':16}]}]})
    template=f['post']('templates/'+template['id']+'/publish')
    account={'username':'roster-reviewer','name':'阅卷教师','password':'teacher-password','role':'teacher'}
    teacher=f['post']('users',account)
    auth={'Authorization':'Bearer '+f['client'].post('/api/v1/auth/login',json=account).json()['token']}
    question=template['questions'][0]
    f['post']('assignments',{'template_id':template['id'],'question_id':question['id'],'user_ids':[teacher['id']]})
    f['pair'](f['students'][0],room=None,group=group,template=template)
    task=r('POST','tasks/claim',{'template_id':template['id'],'question_id':question['id']},auth=auth)
    r('POST','tasks/'+task['id']+'/score',{'score':8,'idempotency_key':str(uuid4())},auth=auth)
    base='groups/'+group['id']+'/roster';ids=[s['id'] for s in f['students'][:2]]
    r('POST',base+'/remove-students',{'student_ids':ids},status=409)
    assert len(r('GET',base)['students'])==3
    result=r('POST',base+'/remove-students',{'student_ids':ids,'confirm_retained':True})
    assert result=={'removed':2,'retained_submissions':1,'count':1}
    assert [s['id'] for s in r('GET',base)['students']]==[f['students'][2]['id']]
    assert r('GET',base)['mode']=='selected'
    rows=r('GET','results?group_id='+group['id'])
    assert {row['student_id'] for row in rows}=={f['students'][0]['id'],f['students'][2]['id']}
    assert next(row['total'] for row in rows if row['student_id']==ids[0])==8
    with db.connect() as conn:
        assert db.get(conn,task['id'],'tasks')['status']=='completed'
        assert conn.execute('SELECT COUNT(*) FROM scores WHERE task_id=?',(task['id'],)).fetchone()[0]==1
        assert len(db.find(conn,'submissions',group_id=group['id']))==1
    r('GET',base+'/candidates',status=403,auth=auth)
    r('POST',base+'/remove-students',{'student_ids':[f['students'][2]['id']]},status=403,auth=auth)
    r('POST',base+'/add-students',{'student_ids':[ids[0]]})
    assert len(r('GET',base)['students'])==2


def test_remove_members_validates_whole_request_and_blocks_frozen_cards(school):
    f=school;r=f['request'];group=f['groups'][0];base='groups/'+group['id']+'/roster'
    r('POST',base+'/remove-students',{'student_ids':[]},status=422)
    r('POST',base+'/remove-students',{'student_ids':[f['students'][0]['id'],'unknown-id']},status=409)
    assert len(r('GET',base)['students'])==3
    outcome=r('POST',base+'/remove-students',{'student_ids':[f['students'][2]['id']]})
    assert outcome=={'removed':1,'retained_submissions':0,'count':2}
    with db.connect() as conn:
        saved=db.get(conn,group['id'],'groups');db.put(conn,'groups',{**saved,'frozen':True})
    r('POST',base+'/remove-students',{'student_ids':[f['students'][0]['id']]},status=409)
    assert len(r('GET',base)['students'])==2
