from uuid import uuid4

from fastapi.testclient import TestClient
from server import db
from server.main import app


def test_configurable_anomalies_pair_details_acknowledgement_and_bulk(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'期中考'})
            subject=db.put(connection,'subjects',{'name':'数学','project_id':project['id']})
            group=db.put(connection,'groups',{'name':'高一','subject_id':subject['id']})
            questions=[{'id':str(uuid4()),'number':i*2+1,'type':'single','points':3,'answer':['A']} for i in range(7)]
            template=db.put(connection,'templates',{'group_id':group['id'],'questions':questions,'sides':1,'status':'published'})
            group['template_id']=template['id'];db.put(connection,'groups',group)
            student=db.put(connection,'students',{'name':'张同学','candidate_number':'001','class_id':'class'})
            batch=db.put(connection,'scan-batches',{'group_id':group['id'],'template_id':template['id'],'status':'front','room':'考场1'})
            page=db.put(connection,'pages',{'batch_id':batch['id'],'side':'front','sequence':1,'status':'recognized','candidate_number':'001','selections':{q['id']:['A'] if i<5 else ['A','B'] if i==5 else [] for i,q in enumerate(questions)}})
        path=f"/api/v1/groups/{group['id']}/anomaly-rules"
        defaults=client.get(path,headers=headers).json()
        assert not any(r['enabled'] for r in defaults.values())
        rules={'blank_answers':{'enabled':True,'min_count':1},'same_answer_run':{'enabled':True,'min_run':5},'invalid_single':{'enabled':True}}
        assert client.put(path,json=rules,headers=headers).json()['checked_submissions']==0
        assert client.post(f"/api/v1/scan-batches/{batch['id']}/pair",headers=headers).status_code==200
        issues=client.get('/api/v1/exceptions',params={'group_id':group['id'],'status':'open'},headers=headers).json()
        assert {i['rule'] for i in issues}==set(rules)
        run=next(i for i in issues if i['rule']=='same_answer_run')
        assert run['evidence']['runs']==[{'answer':'A','question_numbers':[1,3,5,7,9]}]
        detail=client.get(f"/api/v1/exceptions/{run['id']}",headers=headers).json()
        assert detail['context']['room']=='考场1' and detail['context']['student_name']=='张同学'
        assert detail['pages'][0]['selections']['11']==['A','B']
        # An invalid item prevents every change in an atomic bulk operation.
        assert client.post('/api/v1/exceptions/resolve',json={'ids':[run['id'],str(uuid4())],'resolution':'人工核对'},headers=headers).status_code==404
        assert client.get(f"/api/v1/exceptions/{run['id']}",headers=headers).json()['exception']['status']=='open'
        ids=[i['id'] for i in issues]
        assert client.post('/api/v1/exceptions/resolve',json={'ids':ids,'resolution':'确认原始填涂，无需更正'},headers=headers).json()['resolved']==3
        assert client.put(path,json=rules,headers=headers).status_code==200
        assert client.get('/api/v1/exceptions',params={'status':'open'},headers=headers).json()==[]
        with db.connect() as connection:
            submission=db.objects(connection,'submissions')[0]
        correction_path=f"/api/v1/submissions/{submission['id']}/objective"
        correction=client.put(correction_path,json={'reason':'核查浅色填涂','selections':{questions[5]['id']:['A'],questions[6]['id']:['B']}},headers=headers)
        assert correction.status_code==200,correction.text
        answers=client.get(correction_path,headers=headers).json()
        assert answers[5]['original']==['A','B'] and answers[5]['selected']==['A']
        assert client.get('/api/v1/results',params={'group_id':group['id']},headers=headers).json()[0]['total']==18
        invalid=client.put(correction_path,json={'reason':'核对','selections':{questions[0]['id']:['E']}},headers=headers)
        assert invalid.status_code==422
        rules['same_answer_run']['min_run']=4
        client.put(path,json=rules,headers=headers)
        reopened=client.get('/api/v1/exceptions',params={'status':'open'},headers=headers).json()
        assert len(reopened)==1 and reopened[0]['id']==run['id']
        assert client.post('/api/v1/results/publish',json={'group_id':group['id']},headers=headers).status_code==409
        assert client.put(path,json={},headers=headers).status_code==200
        assert client.get('/api/v1/exceptions',params={'status':'open'},headers=headers).json()==[]
        assert client.post('/api/v1/results/publish',json={'group_id':group['id']},headers=headers).status_code==200
        assert client.put(path,json=rules,headers=headers).status_code==409
        assert client.put(correction_path,json={'reason':'核对','selections':{questions[0]['id']:[]}},headers=headers).status_code==409


def test_candidate_correction_clears_missing_information_flag(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        from server.anomalies import check_candidate
        with db.connect() as connection:
            group=db.put(connection,'groups',{'name':'组'})
            batch=db.put(connection,'scan-batches',{'group_id':group['id'],'status':'front'})
            db.put(connection,'students',{'name':'学生','class_id':'class','candidate_number':'001'})
            page=db.put(connection,'pages',{'batch_id':batch['id'],'side':'front','sequence':1,'candidate_number':'0?1','status':'recognized'})
            check_candidate(connection,page)
        assert len(client.get('/api/v1/exceptions',params={'status':'open'},headers=headers).json())==1
        response=client.put(f"/api/v1/pages/{page['id']}",json={'reason':'核对原始卷面','candidate_number':'001'},headers=headers)
        assert response.status_code==200,response.text
        assert client.get('/api/v1/exceptions',params={'status':'open'},headers=headers).json()==[]
        for invalid in ({'blank_answers':False},{'same_answer_run':{'enabled':True,'min_run':1}},{'unknown':{}}):
            assert client.put(f"/api/v1/groups/{group['id']}/anomaly-rules",json=invalid,headers=headers).status_code==422
