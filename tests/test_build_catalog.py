import json
from fastapi.testclient import TestClient
from server import db, main


def test_build_identity_is_public_and_uncached(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    distribution=tmp_path/'web';distribution.mkdir()
    monkeypatch.setattr(main,'web_distribution',distribution)
    with TestClient(main.app) as client:
        assert client.get('/api/v1/system/build').status_code==503
        info={'commit':'1234567890','shell_version':'0123456789abcdef','build_number':'20261116.2130','built_at':'2026-11-16T13:30:00Z'}
        (distribution/'version.json').write_text(json.dumps(info),encoding='utf-8')
        response=client.get('/api/v1/system/build')
        assert response.json()==info and response.headers['cache-control']=='no-store'


def test_catalog_class_tags_follow_selected_roster(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    with TestClient(main.app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account).raise_for_status()
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        with db.connect() as connection:
            grade=db.put(connection,'grades',{'name':'高二'})
            classes=[db.put(connection,'classes',{'name':n,'grade_id':grade['id']}) for n in ('一班','二班')]
            students=[db.put(connection,'students',{'name':c['name'],'candidate_number':str(i),'class_id':c['id']}) for i,c in enumerate(classes)]
            project=db.put(connection,'projects',{'name':'期中'})
            subject=db.put(connection,'subjects',{'name':'语文','project_id':project['id']})
            roster=db.put(connection,'rosters',{'student_ids':[students[0]['id']]})
            group=db.put(connection,'groups',{'name':'选考卷','subject_id':subject['id'],'grade_id':grade['id'],'roster_mode':'selected','roster_id':roster['id']})
        assert client.get('/api/v1/exam-catalog').status_code==401
        rows=client.get('/api/v1/exam-catalog',headers=headers).json()
        row=next(r for r in rows if r['id']==group['id'])
        assert row['class_ids']==[classes[0]['id']] and row['roster_count']==1
        assert row['project_name']=='期中' and row['grade_name']=='高二'
