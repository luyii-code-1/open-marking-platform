from uuid import uuid4
from fastapi.testclient import TestClient
from server import db,realtime
from server.main import app


def test_class_teacher_has_published_hierarchy_but_no_unrelated_results(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        admin={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=admin)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=admin).json()['token']}
        account={'username':'teacher','password':'teacher-password','name':'教师'}
        person=client.post('/api/v1/users',json=account,headers=headers).json()
        teacher={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        with db.connect() as connection:
            cls=db.put(connection,'classes',{'name':'任教班','teacher_ids':[person['id']]})
            other=db.put(connection,'classes',{'name':'无关班','teacher_ids':[]})
            own=db.put(connection,'students',{'name':'自己的学生','candidate_number':'001','class_id':cls['id']})
            foreign=db.put(connection,'students',{'name':'其他学生','candidate_number':'002','class_id':other['id']})
            groups=[];projects=[]
            for index,student in enumerate((own,own,foreign)):
                project=db.put(connection,'projects',{'name':f'考试{index}'})
                subject=db.put(connection,'subjects',{'project_id':project['id'],'name':'科目'})
                group=db.put(connection,'groups',{'subject_id':subject['id'],'name':'组','frozen':True})
                template=db.put(connection,'templates',{'group_id':group['id'],'questions':[{'id':str(uuid4()),'number':1,'type':'single','points':3,'answer':['A']}]})
                group['template_id']=template['id']
                if index==1:
                    roster=db.put(connection,'rosters',{'group_id':group['id'],'students':[student]});group['roster_id']=roster['id']
                else:db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':student['id'],'student_snapshot':student,'candidate_number':student['candidate_number'],'pages':[],'status':'absent'})
                db.put(connection,'groups',group);groups.append(group);projects.append(project)
        assert {r['id'] for r in client.get('/api/v1/groups',headers=teacher).json()}=={g['id'] for g in groups[:2]}
        assert {r['id'] for r in client.get('/api/v1/projects',headers=teacher).json()}=={p['id'] for p in projects[:2]}
        for group in groups[:2]:assert client.get('/api/v1/analysis/group',params={'group_id':group['id']},headers=teacher).status_code==200
        assert client.get('/api/v1/results',params={'group_id':groups[2]['id']},headers=teacher).status_code==403
        assert client.get('/api/v1/analysis/project',params={'project_id':projects[2]['id']},headers=teacher).status_code==403
        with db.connect() as connection:scope=realtime.permissions(connection,{person['id']})[person['id']]
        assert {'projects','subjects','groups'}<=realtime.topics(person,scope,scope,'groups',groups[0])
        assert client.put(f"/api/v1/classes/{cls['id']}",json={'teacher_ids':[]},headers=headers).status_code==200
        assert client.get('/api/v1/groups',headers=teacher).json()==[]
        assert client.get('/api/v1/analysis/group',params={'group_id':groups[0]['id']},headers=teacher).status_code==403
