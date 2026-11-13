import uuid
from fastapi.testclient import TestClient
from server import db
from server.main import app


def test_double_review_arbitration_idempotency_and_freeze(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        admin_headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        teachers=[]
        for index in range(3):
            credentials={'username':f'teacher{index}','password':'teacher-long-password','name':'教师'}
            person=client.post('/api/v1/users',json=credentials,headers=admin_headers).json()
            teachers.append((person,{'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=credentials).json()['token']}))
        qid=str(uuid.uuid4())
        with db.connect() as connection:
            group=db.put(connection,'groups',{'name':'组'})
            template=db.put(connection,'templates',{'group_id':group['id'],'questions':[{'id':qid,'number':1,'type':'subjective','points':20,'review_mode':'double','threshold':2,'regions':[{'page':1,'x':10,'y':110,'width':100,'height':60}]}]})
            group['template_id']=template['id'];db.put(connection,'groups',group)
            student=db.put(connection,'students',{'name':'学生','class_id':'class','candidate_number':'001'})
            db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':student['id'],'candidate_number':'001','pages':[],'status':'ready'})
            db.put(connection,'assignments',{'template_id':template['id'],'question_id':qid,'user_ids':[t[0]['id'] for t in teachers]})
        claim={'template_id':template['id'],'question_id':qid}
        task_ids=[]
        for index,amount in enumerate((10,15,12)):
            headers=teachers[index][1]
            response=client.post('/api/v1/tasks/claim',json=claim,headers=headers)
            assert response.status_code==200,response.text
            task=response.json(); task_ids.append(task['id'])
            assert 'student_id' not in task and task['student_name']=='匿名作答'
            assert client.get('/api/v1/tasks/'+task['id'],headers=teachers[(index+1)%3][1]).status_code==403
            payload={'score':amount,'idempotency_key':str(uuid.uuid4())}
            scored=client.post('/api/v1/tasks/'+task['id']+'/score',json=payload,headers=headers)
            assert scored.status_code==200,scored.text
            assert scored.json()['final_score']==(12 if index==2 else None)
            assert client.post('/api/v1/tasks/'+task['id']+'/score',json=payload,headers=headers).status_code==200
            assert client.post('/api/v1/tasks/'+task['id']+'/score',json={**payload,'score':amount+1},headers=headers).status_code==409
            assert client.post('/api/v1/tasks/claim',json=claim,headers=headers).json() is None
        with db.connect() as connection:
            assert connection.execute('SELECT COUNT(*) FROM scores').fetchone()[0]==3
        result=client.get('/api/v1/results',params={'group_id':group['id']},headers=admin_headers).json()
        assert result[0]['total']==12
        assert client.post('/api/v1/results/publish',json={'group_id':group['id']},headers=admin_headers).status_code==200
        assert client.post('/api/v1/tasks/'+task_ids[0]+'/score',json={'score':11,'idempotency_key':str(uuid.uuid4())},headers=teachers[0][1]).status_code==409
        assert client.post('/api/v1/groups/'+group['id']+'/reopen',json={'reason':'核对特殊卷'},headers=admin_headers).status_code==200
        import io
        from PIL import Image
        image=io.BytesIO(); Image.new('RGB',(50,60),'red').save(image,format='PNG')
        uploaded=client.post('/api/v1/assets',files={'file':('special.png',image.getvalue(),'image/png')},headers=admin_headers)
        assert uploaded.status_code==200
        with db.connect() as connection:
            submission=db.objects(connection,'submissions')[0]
        correction=client.put('/api/v1/submissions/'+submission['id']+'/regions/'+qid,json={'reason':'答在其他位置','asset_id':uploaded.json()['id']},headers=admin_headers)
        assert correction.status_code==200,correction.text
        assert client.post('/api/v1/tasks/'+task_ids[0]+'/score',json={'score':11,'idempotency_key':str(uuid.uuid4())},headers=teachers[0][1]).status_code==409
        fresh=client.post('/api/v1/tasks/claim',json=claim,headers=teachers[0][1]).json()
        assert fresh['id'] not in task_ids
        image_response=client.get(fresh['image_url'],headers=teachers[0][1])
        assert image_response.status_code==200 and image_response.headers['content-type']=='image/png'
        assert client.get('/api/v1/results',params={'group_id':group['id']},headers=admin_headers).json()[0]['total'] is None
