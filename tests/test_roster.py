import csv
import io
import time
from uuid import uuid4
from fastapi.testclient import TestClient
from server import db
from server.main import app


def test_roster_unscanned_force_publication_and_class_privacy(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        admin={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        account={'username':'teacher','password':'teacher-password','name':'教师'}
        teacher=client.post('/api/v1/users',json=account,headers=admin).json()
        teacher_headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'期末'})
            subject=db.put(connection,'subjects',{'project_id':project['id'],'name':'语文'})
            group=db.put(connection,'groups',{'subject_id':subject['id'],'name':'高一组'})
            cls1=db.put(connection,'classes',{'name':'一班'})
            cls2=db.put(connection,'classes',{'name':'二班','teacher_ids':[teacher['id']]})
            students=[db.put(connection,'students',{'name':f'学生{i}','candidate_number':f'{i:03}','class_id':cls1['id'] if i<2 else cls2['id']}) for i in range(4)]
            q={'id':str(uuid4()),'number':1,'type':'subjective','points':10,'review_mode':'single'}
            template=db.put(connection,'templates',{'name':'语文卷','group_id':group['id'],'questions':[q]})
            group['template_id']=template['id'];db.put(connection,'groups',group)
            submission=db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':students[0]['id'],'candidate_number':'000','status':'ready','pages':[]})
            db.put(connection,'tasks',{'submission_id':submission['id'],'question_id':q['id'],'user_id':teacher['id'],'status':'completed','score_cents':800,'created_at':time.time()})
        path=f"/api/v1/groups/{group['id']}/roster"
        assert client.get(path,headers=admin).json()['configured'] is False
        saved=client.put(path,json={'class_ids':[cls1['id']],'student_ids':[students[2]['id']]},headers=admin)
        assert saved.json()['expected_students']==3
        roster=client.get(path,headers=admin).json()
        assert [s['status'] for s in roster['students']]==['scanned','unscanned','unscanned']
        result=client.get('/api/v1/results',params={'group_id':group['id']},headers=admin).json()
        assert [r['total'] for r in result]==[8,None,None]
        assert client.post('/api/v1/results/publish',json={'group_id':group['id']},headers=admin).status_code==409
        assert client.post('/api/v1/results/publish',json={'group_id':group['id'],'force_unscanned':True},headers=admin).status_code==422
        published=client.post('/api/v1/results/publish',json={'group_id':group['id'],'force_unscanned':True,'reason':'缺页已单独登记，先发布已有成绩'},headers=admin)
        assert published.status_code==200,published.text
        assert published.json()['published_unscanned_count']==2
        analysis=client.get('/api/v1/analysis/group',params={'group_id':group['id'],'include_absent':True},headers=admin).json()
        assert analysis['summary']['unscanned']==2 and analysis['summary']['analyzed']==1 and analysis['summary']['average']==8
        visible=client.get('/api/v1/results',params={'group_id':group['id']},headers=teacher_headers).json()
        assert len(visible)==1 and visible[0]['student_id']==students[2]['id'] and visible[0]['status']=='unscanned' and visible[0]['total'] is None
        assert group['id'] in {g['id'] for g in client.get('/api/v1/groups',headers=teacher_headers).json()}
        assert client.get(path,headers=teacher_headers).status_code==403
        cross=client.get('/api/v1/analysis/project',params={'project_id':project['id']},headers=teacher_headers).json()
        assert cross['students'][0]['recorded_raw_sum'] is None and cross['students'][0]['unscanned_records']==1
        exported=client.get('/api/v1/results/export',params={'group_id':group['id']},headers=teacher_headers)
        rows=list(csv.reader(io.StringIO(exported.content.decode('utf-8-sig'))))
        assert rows[1][3]=='未扫描' and rows[1][4]==''
        assert client.put(path,json={'class_ids':[]},headers=admin).status_code==409
        assert client.post('/api/v1/scan-batches',json={'group_id':group['id']},headers=admin).status_code==409
        assert client.post(f"/api/v1/groups/{group['id']}/reopen",json={'reason':'补录缺考'},headers=admin).status_code==200
        with db.connect() as connection:
            changed={**students[1],'name':'已更名','class_id':cls2['id']};db.put(connection,'students',changed)
        # The saved exam roster retains its identity and class snapshot.
        roster=client.get(path,headers=admin).json()
        assert roster['students'][1]['name']=='学生1' and roster['students'][1]['class_id']==cls1['id']
        absent=client.post(f"/api/v1/groups/{group['id']}/absent",json={'student_id':students[1]['id'],'reason':'核实缺考'},headers=admin)
        assert absent.status_code==200 and absent.json()['student_snapshot']['class_id']==cls1['id']
        analysis=client.get('/api/v1/analysis/group',params={'group_id':group['id']},headers=admin).json()
        assert analysis['summary']['absent']==1 and analysis['summary']['unscanned']==1
        with db.connect() as connection:
            event=db.objects(connection,'publication-events')[0]
            assert event['forced_unscanned'] and len(event['unscanned_student_ids'])==2
