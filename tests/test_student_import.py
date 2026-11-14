import io
import json
from fastapi.testclient import TestClient
from server import db
from server.main import app
from tests.test_templates import setup


def test_bulk_student_import_conflict_policies(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers=setup(client)
        with db.connect() as c:
            grade=db.put(c,'grades',{'name':'高一','archived':False})
        options={'sheets':['CSV'],'mapping':{'candidate_number':'考号','name':'姓名','class_name':'班级'},'grade_id':grade['id'],'conflicts':'block'}
        def post(action,data,auth=headers):
            return client.post('/api/v1/student-import/'+action,headers=auth,files={'file':('class.csv',('考号,姓名,班级\n'+data).encode())},data={'options':json.dumps(options)})
        first='000000001,甲,01\n000000002,乙,1班\n000000001,甲,01'
        assert post('preview',first,{}).status_code==401
        info=post('preview',first).json()
        assert (info['new'],info['classes'],info['duplicates'])==(2,1,1)
        with db.connect() as c: assert not db.objects(c,'classes')
        assert post('commit',first).json()['new']==2
        changed='000000001,丙,02\n000000003,丁,03'
        assert post('commit',changed).status_code==409
        with db.connect() as c:
            assert len(db.objects(c,'classes'))==1 and len(db.objects(c,'students'))==2
            student_id=next(s['id'] for s in db.objects(c,'students') if s['candidate_number']=='000000001')
        options['conflicts']='skip'
        assert post('commit',changed).json()['skipped']==1
        options['conflicts']='update'
        assert post('commit',changed).json()['updated']==1
        assert post('commit',changed).json()['skipped']==2
        with db.connect() as c:assert db.get(c,student_id)['name']=='丙'
        assert post('commit','001,甲,4\n001,乙,4').status_code==409
