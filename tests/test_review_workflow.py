import time
from uuid import uuid4
import numpy as np
from fastapi.testclient import TestClient
from server import db
from server.main import app
from test_allocation import setup,seed


def test_removed_teacher_completed_work_is_retained_but_expired_claim_is_reassigned(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        admin,teachers=setup(client)
        scope=seed(4)
        assignment={**scope,'user_ids':[t[0] for t in teachers[:2]]}
        client.post('/api/v1/assignments',json=assignment,headers=admin).raise_for_status()
        first=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[0][1]).json()
        client.post('/api/v1/tasks/'+first['id']+'/score',json={'score':10,'idempotency_key':str(uuid4())},headers=teachers[0][1]).raise_for_status()
        held=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[0][1]).json()
        assignment['user_ids']=[teachers[1][0]]
        client.post('/api/v1/assignments',json=assignment,headers=admin).raise_for_status()
        with db.connect() as connection:
            task=db.get(connection,held['id']);task['expires_at']=time.time()-1;db.put(connection,'tasks',task)
        rows=client.get('/api/v1/review-allocation-progress',params={'template_id':scope['template_id']},headers=admin).json()[0]['teachers']
        old=next(r for r in rows if r['user_id']==teachers[0][0])
        new=next(r for r in rows if r['user_id']==teachers[1][0])
        assert (old['ordinary_total'],old['ordinary_completed'])==(1,1)
        assert new['ordinary_total']==3


def test_arbitration_is_claimed_before_held_ordinary_work_and_reported_separately(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        admin,teachers=setup(client)
        scope=seed(3,'double');ids=[t[0] for t in teachers]
        client.post('/api/v1/assignments',json={**scope,'user_ids':ids,'arbitrator_ids':ids,'arbitration_mode':'weighted'},headers=admin).raise_for_status()
        ordinary=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[0][1]).json()
        with db.connect() as connection:
            submission=next(s for s in db.find(connection,'submissions',template_id=scope['template_id']) if s['id']!=ordinary['submission_id'])
            connection.execute('DELETE FROM review_allocations WHERE submission_id=?',(submission['id'],))
            for index,(uid,score) in enumerate(zip(ids[1:],[5,15]),1):
                connection.execute('INSERT INTO review_allocations VALUES(?,?,?,?,?)',(scope['template_id'],scope['question_id'],submission['id'],index,uid))
                db.put(connection,'tasks',{**scope,'submission_id':submission['id'],'user_id':uid,'created_at':time.time()+index,'status':'completed','score_cents':score*100,'score':score})
            connection.execute('INSERT INTO review_allocations VALUES(?,?,?,?,?)',(scope['template_id'],scope['question_id'],submission['id'],3,ids[0]))
            connection.execute('INSERT INTO review_results VALUES(?,?,NULL)',(submission['id'],scope['question_id']))
        progress=client.get('/api/v1/review-task-progress',headers=teachers[0][1]).json()[0]
        assert progress['arbitration_pending']==1 and progress['ordinary_pending']>=1
        claimed=client.post('/api/v1/tasks/claim',json=scope,headers=teachers[0][1])
        claimed.raise_for_status()
        assert claimed.json()['submission_id']==submission['id'] and claimed.json()['review_role']=='arbitration'
        state=client.get('/api/v1/groups/'+submission['group_id']+'/workflow',headers=admin).json()
        assert state['subjective']['arbitration']==1


def test_objective_reprocess_preserves_identity_overrides_and_subjective_scores(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        admin,teachers=setup(client)
        scope=seed(1)
        with db.connect() as connection:
            template=db.get(connection,scope['template_id']);objective={'id':str(uuid4()),'number':2,'type':'single','points':2,'answer':['A'],'regions':[]}
            template['questions'].append(objective);db.put(connection,'templates',template)
            batch=db.put(connection,'scan-batches',{'group_id':template['group_id'],'template_id':template['id'],'status':'paired'})
            page=db.put(connection,'pages',{'batch_id':batch['id'],'side':'front','status':'recognized','candidate_number':'111','selections':{objective['id']:['B']}})
            submission=db.find(connection,'submissions',template_id=template['id'])[0]
            submission.update(pages=[page['id']],objective_overrides={objective['id']:['C']});db.put(connection,'submissions',submission)
            task=db.put(connection,'tasks',{**scope,'submission_id':submission['id'],'user_id':teachers[0][0],'created_at':time.time(),'status':'completed','score_cents':1000})
            job=db.put(connection,'jobs',{'kind':'objective-reprocess','payload':{'group_id':template['group_id']},'actor':admin and teachers[0][0],'status':'running','run_token':'run'})
            job['actor']=connection.execute("SELECT id FROM users WHERE role='admin'").fetchone()[0];db.put(connection,'jobs',job)
        source=tmp_path/'source.image';source.write_bytes(b'image')
        monkeypatch.setattr('server.storage.materialize',lambda relative:source)
        monkeypatch.setattr('server.paper.decode',lambda *args:(np.zeros((4,4),dtype=np.uint8),'code'))
        monkeypatch.setattr('server.paper.recognize',lambda *args:(np.zeros((4,4),dtype=np.uint8),'999',{objective['id']:['A']}))
        from server.objective_reprocess import perform
        result=perform(job,lambda *args:None)
        assert result['updated_pages']==1
        with db.connect() as connection:
            updated=db.get(connection,page['id'])
            assert updated['candidate_number']=='111' and updated['selections'][objective['id']]==['A']
            assert db.get(connection,submission['id'])['objective_overrides']=={objective['id']:['C']}
            assert db.get(connection,task['id'])['score_cents']==1000
