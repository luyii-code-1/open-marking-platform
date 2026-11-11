from uuid import uuid4
from fastapi.testclient import TestClient
from server import db
from server.main import app


def test_empty_absence_can_attach_complete_rescan_without_duplicate_pairing(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        with db.connect() as connection:
            group=db.put(connection,'groups',{'name':'组'})
            student=db.put(connection,'students',{'name':'学生','candidate_number':'001','class_id':'class'})
            q={'id':str(uuid4()),'number':1,'type':'single','options':4,'answer':['A'],'points':3}
            template=db.put(connection,'templates',{'group_id':group['id'],'sides':2,'questions':[q]})
            group['template_id']=template['id'];db.put(connection,'groups',group)
            batch=db.put(connection,'scan-batches',{'group_id':group['id'],'template_id':template['id'],'status':'front'})
            front=db.put(connection,'pages',{'batch_id':batch['id'],'side':'front','sequence':1,'status':'recognized','candidate_number':'001','selections':{q['id']:['A']}})
            back=db.put(connection,'pages',{'batch_id':batch['id'],'side':'back','sequence':1,'status':'recognized'})
            wrong=db.put(connection,'pages',{'batch_id':batch['id'],'side':'front','sequence':2,'status':'recognized','candidate_number':'002','excluded':True})
        absent=client.post(f"/api/v1/groups/{group['id']}/absent",json={'student_id':student['id'],'reason':'先前登记缺考'},headers=headers).json()
        path=f"/api/v1/submissions/{absent['id']}"
        assert client.put(path+'/attendance',json={'absent':False,'reason':'学生实际到场'},headers=headers).status_code==409
        assert client.post(path+'/attach-pages',json={'page_ids':[front['id']],'reason':'补扫'},headers=headers).status_code==422
        assert client.post(path+'/attach-pages',json={'page_ids':[front['id'],wrong['id']],'reason':'补扫'},headers=headers).status_code==409
        with db.connect() as connection:assert not db.get(connection,front['id'],'pages').get('linked_submission_id')
        recovered=client.post(path+'/attach-pages',json={'page_ids':[front['id'],back['id']],'reason':'核对考号后补齐整卷'},headers=headers)
        assert recovered.status_code==200,recovered.text
        assert recovered.json()['id']==absent['id'] and recovered.json()['status']=='ready'
        assert client.post(f"/api/v1/scan-batches/{batch['id']}/pair",headers=headers).status_code==200
        result=client.get('/api/v1/results',params={'group_id':group['id']},headers=headers).json()
        assert len(result)==1 and result[0]['total']==3 and result[0]['status']=='completed'
        with db.connect() as connection:
            assert len(db.objects(connection,'submissions'))==1
            assert db.get(connection,front['id'],'pages')['linked_submission_id']==absent['id']
