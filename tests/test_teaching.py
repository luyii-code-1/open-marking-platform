from test_grade_rooms import school
from server import db
from server.visibility import class_scope
from server.teaching_matrix import matrix_import


def test_elective_and_class_subject_scope(school):
    f=school
    r=f['request']
    teacher=f['post']('users',{'username':'teacher','password':'teacher-password-long','name':'教师'})
    auth={'Authorization':'Bearer '+f['client'].post('/api/v1/auth/login',json={'username':'teacher','password':'teacher-password-long'}).json()['token']}
    rel={'teacher_id':teacher['id'],'class_id':f['cls']['id'],'subjects':['数学'],'homeroom':False}
    r('PUT','teaching/relation',rel,403,auth)
    r('PUT','teaching/relation',rel)
    r('PUT','teaching/relation',{**rel,'class_id':f['other_cls']['id'],'homeroom':True})
    with db.connect() as c:
        assert class_scope(c,teacher['id'],f['subject']['id'])=={f['other_cls']['id']}
        other=db.put(c,'subjects',{'name':'数学','project_id':f['project']['id']})
        assert class_scope(c,teacher['id'],other['id'])=={f['cls']['id'],f['other_cls']['id']}
    assert len(r('GET','teaching/mine',auth=auth))==2
    ids=[f['students'][0]['id']]
    r('PUT','electives',{'grade_id':f['grade']['id'],'subject':'语文','student_ids':ids})
    group=f['groups'][0]['id']
    assert r('POST','groups/'+group+'/roster/elective')['count']==1
    assert r('GET','groups/'+group+'/roster')['student_ids']==ids


def test_teacher_import(school):
    f=school
    teacher=f['post']('users',{'username':'teacher','password':'teacher-password-long','name':'教师'})
    cls=f['post']('classes',{'name':'1班','grade_id':f['grade']['id']})
    table={'任课任职表':([],[(3,['级段','数学','']), (4,['','姓名','班级']), (5,['高一','教师','1、卓实走班、2+4'])])}
    with db.connect() as c:
        report=matrix_import(c,table,True,'admin')
        assert report['count']==1 and len(report['skipped'])==2
        role=db.get(c,cls['id'])['teaching'][teacher['id']]
        assert role=={'subjects':['数学'],'homeroom':None}
    file={'file':('关系.csv','教师账号,年级,班级,任教学科,是否班主任\nteacher,高一,1班,物理,是'.encode())}
    client=f['client']
    for commit in ('false','true'):
        response=client.post('/api/v1/teaching/import?commit='+commit,files=file,headers=f['headers'])
        assert response.status_code==200 and response.json()['count']==1
    with db.connect() as c:
        assert db.get(c,cls['id'])['teaching'][teacher['id']]=={'subjects':['物理'],'homeroom':True}

def test_new_accounts_and_duplicate_confirmation(school):
    f=school
    table={'任课任职表':([],[(3,['级段','数学','']), (4,['','姓名','班级']), (5,['高一','教师甲','1']), (6,['','教师乙','1']), (7,['','教师乙','2'])])}
    f['post']('classes',{'name':'1班','grade_id':f['grade']['id']})
    with db.connect() as c:
        preview=matrix_import(c,table,False,'admin')
        assert len(preview['pending'])==2 and len(preview['planned'])==1
        assert not c.execute("SELECT id FROM users WHERE role='teacher'").fetchone()
        result=matrix_import(c,table,True,'admin',{'6:1':'new','7:1':'new'})
        assert len(result['created'])==2 and result['count']==2
        uid=c.execute("SELECT id FROM users WHERE name='教师乙'").fetchone()[0]
        again=matrix_import(c,table,True,'admin',{'6:1':uid,'7:1':uid})
        assert not again['created'] and not again['pending']
