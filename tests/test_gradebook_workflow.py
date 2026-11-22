import io
from uuid import uuid4
from fastapi.testclient import TestClient
from openpyxl import Workbook
from server import db
from server.main import app
from server.conversion import convert,import_table
from server.conversion_bindings import resolve


def account(client):
    value={'username':'admin','password':'administrator-password','name':'管理员'}
    client.post('/api/v1/auth/bootstrap',json=value)
    return {'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=value).json()['token']}


def test_gradebook_publications_duplicates_preview_and_scope(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers=account(client)
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'考试'})
            other=db.put(connection,'projects',{'name':'其他考试'})
            subject=db.put(connection,'subjects',{'name':'历史','project_id':project['id']})
            grade=db.put(connection,'grades',{'name':'高二'})
            cls=db.put(connection,'classes',{'name':'一班','grade_id':grade['id']})
            student=db.put(connection,'students',{'name':'甲','class_id':cls['id'],'candidate_number':'001'})
            group=db.put(connection,'groups',{'name':'题卡','subject_id':subject['id'],'frozen':False})
            question={'id':str(uuid4()),'number':1,'type':'single','points':10,'answer':['A']}
            template=db.put(connection,'templates',{'name':'题卡','group_id':group['id'],'questions':[question]})
            group['template_id']=template['id'];db.put(connection,'groups',group)
            page=db.put(connection,'pages',{'selections':{question['id']:['A']}})
            submission={'template_id':template['id'],'group_id':group['id'],'student_id':student['id'],'candidate_number':'001','pages':[page['id']],'status':'ready'}
            db.put(connection,'submissions',submission)
        query={'project_id':project['id']}
        assert client.get('/api/v1/gradebook',params=query,headers=headers).json()['total']==0
        draft=client.get('/api/v1/gradebook',params={**query,'group_id':group['id']},headers=headers).json()
        assert draft['rows'][0]['total']==10 and draft['rows'][0]['rank']==1
        assert client.get('/api/v1/gradebook',params={'project_id':other['id'],'group_id':group['id']},headers=headers).status_code==404
        with db.connect() as connection:
            group['frozen']=True;db.put(connection,'groups',group)
        preview=client.get('/api/v1/gradebook',params=query,headers=headers).json()
        assert preview['total']==1 and preview['rows'][0][subject['id']]==10
        assert client.get('/api/v1/gradebook',params={**query,'format':'xlsx'},headers=headers).status_code==409
        assert client.get('/api/v1/gradebook',params={**query,'format':'xlsx','preview_version':preview['version']},headers=headers).status_code==200
        changed={**query,'columns':'name,total','format':'csv','preview_version':preview['version']}
        assert client.get('/api/v1/gradebook',params=changed,headers=headers).status_code==409
        with db.connect() as connection:db.put(connection,'submissions',{k:v for k,v in submission.items() if k!='id'})
        duplicate=client.get('/api/v1/gradebook',params=query,headers=headers).json()['rows'][0]
        assert duplicate['status']=='同科答卷重复' and duplicate['total'] is None and duplicate['rank'] is None
        assert client.get('/api/v1/gradebook',params={**query,'format':'csv','preview_version':preview['version']},headers=headers).status_code==409
        items=client.get('/api/v1/gradebook',params={**query,'view':'items','metric':'converted'},headers=headers).json()
        assert all(c['label']!='赋分' for c in items['columns'])


def test_conversion_inheritance_local_override_and_archive_removal(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    monkeypatch.setenv('OMP_STORAGE','s3')
    with TestClient(app) as client:
        headers=account(client)
        with db.connect() as connection:
            scheme=db.put(connection,'score-conversions',{'name':'线性','mode':'segments','segments':[{'min':0,'max':100,'target_min':40,'target_max':100}]})
            project=db.put(connection,'projects',{'name':'考试','conversion_id':scheme['id']})
            subject=db.put(connection,'subjects',{'name':'历史','project_id':project['id']})
            group=db.put(connection,'groups',{'name':'题卡','subject_id':subject['id']})
            assert resolve(connection,group)['conversion_id']==scheme['id']
            assert resolve(connection,{**group,'conversion_mode':'none'})['conversion_id'] is None
            assert resolve(connection,{**group,'frozen':True,'conversion_id':None})['conversion_id'] is None
        response=client.put('/api/v1/projects/'+project['id']+'/storage',json={'storage_mode':'local'},headers=headers)
        assert response.status_code==200
        from server.storage import Storage
        assert Storage(project_id=project['id']).kind=='local'
        assert Storage().kind=='s3'
        from server.archive import package_path
        with db.connect() as connection:
            archive=db.put(connection,'archives',{'project_id':project['id'],'status':'verified'})
            path=package_path(archive['id']);path.parent.mkdir(exist_ok=True);path.write_bytes(b'archive')
        preview=client.post('/api/v1/archives/'+archive['id']+'/delete-preview',headers=headers).json()
        assert client.request('DELETE','/api/v1/archives/'+archive['id']+'/package',json={'confirm':True,'sha256':'changed'},headers=headers).status_code==409
        assert path.exists()
        assert client.request('DELETE','/api/v1/archives/'+archive['id']+'/package',json={'confirm':True,'sha256':preview['sha256']},headers=headers).status_code==200
        assert not path.exists()
        with db.connect() as connection:assert db.get(connection,project['id'],'projects')


def test_rounding_steps_and_excel_import():
    config={'mode':'segments','segments':[{'min':0,'max':100,'target_min':40,'target_max':100}],'step':5,'rounding':'down'}
    assert convert(51,config)==70
    assert convert(51,{**config,'rounding':'up'})==75
    assert convert(51,{**config,'rounding':'nearest'})==70
    book=Workbook();sheet=book.active;sheet.append(['裸分','赋分']);sheet.append([0,40]);sheet.append([100,100])
    stream=io.BytesIO();book.save(stream)
    imported=import_table(stream.getvalue(),'导入')
    assert convert(55,{**imported,'table_match':'up'})==100
    assert convert(55,{**imported,'table_match':'down'})==40
