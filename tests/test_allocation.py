import uuid

from fastapi.testclient import TestClient
from server import db
from server.main import app


def setup(client, count=3):
    credentials={'username':'admin','password':'administrator-password','name':'管理员'}
    client.post('/api/v1/auth/bootstrap',json=credentials)
    admin={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=credentials).json()['token']}
    teachers=[]
    for i in range(count):
        account={'username':f't{i}','password':'teacher-password','name':f'教师{i}'}
        person=client.post('/api/v1/users',json=account,headers=admin).json()
        teachers.append((person['id'],{'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}))
    return admin,teachers


def seed(count, mode='single'):
    with db.connect() as connection:
        group=db.put(connection,'groups',{'name':'组'})
        question={'id':str(uuid.uuid4()),'number':1,'type':'subjective','points':20,'review_mode':mode,'threshold':2,'regions':[{'page':1,'x':10,'y':110,'width':100,'height':60}]}
        template=db.put(connection,'templates',{'group_id':group['id'],'questions':[question]})
        for i in range(count):
            student=db.put(connection,'students',{'name':f'学生{i}','class_id':'class','candidate_number':str(i)})
            db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':student['id'],'candidate_number':str(i),'pages':[],'status':'ready'})
    return {'template_id':template['id'],'question_id':question['id']}


def test_weighted_quotas_skip_and_reallocation(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        admin,teachers=setup(client)
        scope=seed(12)
        assignment={**scope,'user_ids':[u for u,_ in teachers],'weights':{teachers[0][0]:3,teachers[1][0]:1,teachers[2][0]:0}}
        response=client.post('/api/v1/assignments',json=assignment,headers=admin)
        assert response.status_code==200,response.text
        for teacher,expected in zip(teachers,(9,3,0)):
            progress=client.get('/api/v1/review-progress',params=scope,headers=teacher[1]).json()
            assert progress['my_total']==expected
        completed=[]
        for _ in range(3):
            task=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[1][1]).json()
            completed.append(task)
            assert client.post('/api/v1/tasks/'+task['id']+'/score',json={'score':10,'idempotency_key':str(uuid.uuid4())},headers=teachers[1][1]).status_code==200
        response=client.post('/api/v1/tasks/'+completed[1]['id']+'/regrade-from',json={'reason':'统一调整评分尺度'},headers=teachers[1][1])
        assert response.json()['queued']==2
        assert client.post('/api/v1/tasks/'+completed[1]['id']+'/regrade-from',json={'reason':'重新核对'},headers=teachers[0][1]).status_code==403
        revisited=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[1][1]).json()
        assert revisited['id']==completed[1]['id'] and revisited['regrading'] and revisited['score']==10
        assert client.post('/api/v1/tasks/'+revisited['id']+'/skip',headers=teachers[1][1]).status_code==200
        last=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[1][1]).json()
        assert last['id']==completed[2]['id']
        for task in (last,revisited):
            assert client.post('/api/v1/tasks/'+task['id']+'/score',json={'score':12,'idempotency_key':str(uuid.uuid4())},headers=teachers[1][1]).status_code==200
        assert client.get('/api/v1/review-progress',params=scope,headers=teachers[1][1]).json()['my_regrade_pending']==0
        with db.connect() as connection:
            assert connection.execute('SELECT COUNT(*) FROM scores WHERE user_id=?',(teachers[1][0],)).fetchone()[0]==5
        first=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[0][1]).json()
        client.post('/api/v1/tasks/'+first['id']+'/skip',headers=teachers[0][1])
        second=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[0][1]).json()
        assert first['submission_id']!=second['submission_id']
        # Rebalancing retains the already claimed task and permits its completion.
        assignment['weights']={teachers[0][0]:1,teachers[1][0]:3,teachers[2][0]:0}
        assert client.post('/api/v1/assignments',json=assignment,headers=admin).status_code==200
        assert client.post('/api/v1/tasks/claim',json=scope,headers=teachers[0][1]).json()['id']==second['id']
        scored=client.post('/api/v1/tasks/'+second['id']+'/score',json={'score':10,'idempotency_key':str(uuid.uuid4())},headers=teachers[0][1])
        assert scored.status_code==200
        progress=client.get('/api/v1/review-progress',params=scope,headers=teachers[0][1]).json()
        assert progress['my_total']==3 and progress['my_completed']==1 and progress['my_progress']==33.3
        assert client.post('/api/v1/tasks/claim',json=scope,headers=teachers[2][1]).json() is None


def test_fixed_arbiter_has_access_and_cannot_mark_first(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        admin,teachers=setup(client,4)
        scope=seed(1,'double')
        assignment={**scope,'user_ids':[teachers[0][0],teachers[1][0]],'arbitration_mode':'fixed','arbitrator_ids':[teachers[2][0]]}
        response=client.post('/api/v1/assignments',json=assignment,headers=admin)
        assert response.status_code==200,response.text
        assert client.get('/api/v1/templates',headers=teachers[2][1]).json()[0]['id']==scope['template_id']
        assert client.post('/api/v1/tasks/claim',json=scope,headers=teachers[2][1]).json() is None
        for i,value in enumerate((10,16)):
            task=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[i][1]).json()
            assert client.post('/api/v1/tasks/'+task['id']+'/score',json={'score':value,'idempotency_key':str(uuid.uuid4())},headers=teachers[i][1]).status_code==200
        assert client.post('/api/v1/tasks/claim',json=scope,headers=teachers[3][1]).status_code==403
        for i in range(2):
            assert client.post('/api/v1/tasks/claim',json=scope,headers=teachers[i][1]).json() is None
        task=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[2][1]).json()
        assert 'score_cents' not in task and task['score'] is None
        scored=client.post('/api/v1/tasks/'+task['id']+'/score',json={'score':13,'idempotency_key':str(uuid.uuid4())},headers=teachers[2][1])
        assert scored.json()['final_score']==13
        for i in range(2):
            assert client.get('/api/v1/tasks/history',params=scope,headers=teachers[i][1]).json()[0]['final_score']==13
        first=client.get('/api/v1/tasks/history',params=scope,headers=teachers[0][1]).json()[0]
        with db.connect() as connection:
            group_id=db.get(connection,scope['template_id'])['group_id']
        assert client.post('/api/v1/tasks/'+first['id']+'/regrade-from',json={'reason':'核对尺度'},headers=teachers[0][1]).status_code==200
        blocked=client.post('/api/v1/results/publish',json={'group_id':group_id},headers=admin)
        assert blocked.status_code==409 and '重阅' in blocked.text
        assert client.post('/api/v1/tasks/'+first['id']+'/score',json={'score':11,'idempotency_key':str(uuid.uuid4())},headers=teachers[0][1]).status_code==200
        assert client.post('/api/v1/results/publish',json={'group_id':group_id},headers=admin).status_code==200
        assert client.post('/api/v1/tasks/'+first['id']+'/regrade-from',json={'reason':'再次检查'},headers=teachers[0][1]).status_code==409
        invalid={**assignment,'arbitrator_ids':[teachers[0][0]]}
        assert client.post('/api/v1/assignments',json=invalid,headers=admin).status_code==422
