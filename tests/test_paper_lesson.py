from uuid import uuid4

from fastapi.testclient import TestClient
from server import db
from server.main import app


def test_teacher_lesson_exact_answers_grade_averages_and_identity_boundary(tmp_path, monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        login={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=login)
        def headers(account):
            return {'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        teacher={'username':'teacher','password':'teacher-password','name':'任课教师'}
        uid=client.post('/api/v1/users',json=teacher,headers=headers(login)).json()['id']
        auth=headers(teacher)
        with db.connect() as connection:
            def put(entity,**body):return db.put(connection,entity,body)
            project=put('projects',name='期中')
            subject=put('subjects',name='物理',project_id=project['id'])
            grade=put('grades',name='高一')
            other_grade=put('grades',name='高二')
            own=put('classes',name='1班',grade_id=grade['id'],teacher_ids=[uid],teaching={uid:{'subjects':['物理']}})
            peer=put('classes',name='2班',grade_id=grade['id'])
            outside=put('classes',name='3班',grade_id=other_grade['id'])
            card=put('groups',name='期中卷',subject_id=subject['id'],frozen=True)
            obj={'id':str(uuid4()),'type':'multiple','number':1,'points':2,'options':4,'answer':['A','C'],
                 'rule':{'mode':'per_option','correct_points':1,'wrong_penalty':0}}
            big={'id':str(uuid4()),'type':'subjective','number':2,'points':8,
                 'parts':[{'number':2,'points':4},{'number':3,'points':4}]}
            template=put('templates',name='试卷',group_id=card['id'],questions=[obj,big])
            roster=[]
            for cls,name,selected,score in [
                (own,'甲',['A','C'],8),(own,'乙',['D'],4),(own,'丙',[],0),(own,'丁',['A','C','D'],None),
                (own,'待核查',['B'],8),(own,'缺考生',[],None),(own,'未扫描生',[],None),
                (peer,'别班学生',['A','C'],4),(outside,'别年级学生',[],0)]:
                number=str(len(roster)+1).zfill(3)
                student=put('students',name=name,class_id=cls['id'],candidate_number=number)
                roster.append(student)
                if name=='未扫描生':continue
                page=put('pages',selections={obj['id']:selected})
                sub=put('submissions',group_id=card['id'],template_id=template['id'],student_id=student['id'],
                        candidate_number=number,pages=[page['id']],status='absent' if name=='缺考生' else 'ready',
                        objective_overrides={obj['id']:['A']} if name=='乙' else {})
                if score is not None:
                    put('tasks',submission_id=sub['id'],template_id=template['id'],question_id=big['id'],user_id=uid,
                        status='completed',score_cents=score*100,created_at=1)
                if name=='待核查':
                    put('exceptions',submission_id=sub['id'],kind='automatic',status='open',evidence={'question_numbers':[1]})
            members=put('rosters',group_id=card['id'],students=roster)
            card=put('groups',**{**card,'template_id':template['id'],'roster_id':members['id']})
        def lesson(cid):
            return client.get('/api/v1/analysis/paper-lesson',params={'group_id':card['id'],'class_id':cid},headers=auth)
        response=lesson(own['id'])
        assert response.status_code==200,response.text
        data=response.json();question,essay=data['questions'];chart=data['comparison']
        assert (question['correct_rate'],question['count'],question['average'])==(25,4,1.25)
        assert question['options']=={'A':['甲','乙','丁'],'B':[],'C':['甲','丁'],'D':['丁'],'blank':['丙']}
        assert essay['number']=='2～3' and essay['count']==4 and 'options' not in essay
        assert essay['bands'][0]['count']==1 and essay['bands'][-1]['count']==2
        assert chart['averages']['total']==5.25 and chart['averages'][obj['id']]==1.4
        assert {c['name'] for c in chart['classes']}=={'1班','2班'}
        assert all(set(c)=={'name','averages'} for c in chart['classes'])
        assert '别班学生' not in response.text and '别年级学生' not in response.text
        assert lesson(peer['id']).status_code==403
        with db.connect() as connection:
            # Homeroom access to own-class details does not grant peer averages for an untaught subject.
            db.put(connection,'classes',{**own,'teaching':{uid:{'homeroom':True,'subjects':['历史']}}})
        limited=lesson(own['id']).json()['comparison']
        assert not limited['grade_wide'] and [c['name'] for c in limited['classes']]==['1班']
        with db.connect() as connection:
            db.put(connection,'groups',{**card,'frozen':False})
        assert lesson(own['id']).status_code==403
