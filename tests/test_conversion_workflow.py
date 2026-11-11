import json
import zipfile
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from server import db
from server.main import app
from server.conversion import apply,convert,import_table,validate_conversion


def test_csv_encoding_precision_numeric_duplicates_and_40_point_floor():
    config=import_table('原始分,赋分\r\n0,40\r\n50.00,72.555\r\n100,100'.encode('utf-8-sig'),'外表')
    assert config['table']['50']=='72.555' and convert(50,config)==72.56
    assert import_table('原始分\t赋分\n0\t40\n50\t70'.encode('gb18030'),'粘贴')['table']['50']=='70'
    for source in ('原始分,赋分\n50,70\n50.0,71','原始分,赋分\n0,39','原始分,赋分\n0,50\n50,40','原始分,赋分\n1e-200,40','原始分,赋分\nNaN,40','原始分,赋分\n10,70,extra'):
        with pytest.raises(ValueError):import_table(source.encode(),'错误表')
    with pytest.raises(ValueError):validate_conversion({'mode':'table','table':{'1':50,'1.0':51}})


def test_percentile_ties_absence_null_and_boundary_policy():
    config={'mode':'percentile','precision':0,'segments':[{'min':0,'max':100,'target_min':40,'target_max':100}]}
    rows=[{'total':50,'status':'completed'},{'total':50,'status':'completed'},{'total':100,'status':'completed'},{'total':0,'status':'absent'},{'total':None,'status':'unscanned'}]
    apply(rows,config)
    assert [r.get('converted_score') for r in rows]==[60,60,90,0,None]
    segmented={'mode':'segments','segments':[{'min':0,'max':50,'target_min':40,'target_max':70},{'min':50,'max':100,'target_min':80,'target_max':100}]}
    assert convert(50,segmented)==70 and convert(50,{**segmented,'boundary':'upper'})==80
    for invalid in ({'precision':3},{'precision':True},{'boundary':'unknown'}):
        with pytest.raises(ValueError):validate_conversion({**config,**invalid})


def test_conversion_import_edit_coverage_publish_snapshot_and_revision_guard(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'考试'})
            subject=db.put(connection,'subjects',{'project_id':project['id'],'name':'化学'})
            group=db.put(connection,'groups',{'subject_id':subject['id'],'name':'组'})
            q={'id':str(uuid4()),'number':1,'type':'single','points':50,'answer':['A']}
            template=db.put(connection,'templates',{'group_id':group['id'],'questions':[q]})
            students=[db.put(connection,'students',{'name':f'学生{i}','candidate_number':str(i),'class_id':'class'}) for i in range(3)]
            roster=db.put(connection,'rosters',{'group_id':group['id'],'students':students})
            group.update(template_id=template['id'],roster_id=roster['id']);db.put(connection,'groups',group)
            for index,status in enumerate(('ready','absent')):
                student=students[index];db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':student['id'],'student_snapshot':student,'candidate_number':student['candidate_number'],'pages':[],'objective_overrides':{q['id']:['A']},'status':status})
        config={'name':'对照表','mode':'table','precision':2,'table':{'0':40}}
        incomplete=client.post('/api/v1/score-conversions',json=config,headers=headers).json()
        binding=f"/api/v1/groups/{group['id']}/conversion"
        assert client.put(binding,json={'conversion_id':incomplete['id']},headers=headers).status_code==422
        csv='原始分,赋分\n0,40\n50,72.555\n'
        with db.connect() as connection:before=len(db.objects(connection,'score-conversions'))
        preview=client.post('/api/v1/score-conversions/import-preview',data={'name':'外部表','precision':'2'},files={'file':('table.csv',csv.encode('utf-8-sig'),'text/csv')},headers=headers)
        assert preview.status_code==200,preview.text
        assert preview.json()['row_count']==2
        with db.connect() as connection:assert len(db.objects(connection,'score-conversions'))==before
        saved=client.post('/api/v1/score-conversions',json=preview.json()['config'],headers=headers).json()
        assert saved['revision']==1
        assert client.put(binding,json={'conversion_id':saved['id']},headers=headers).status_code==200
        edit={**preview.json()['config'],'table':{'0':40,'50':75},'base_revision':1,'reason':'校方修订'}
        changed=client.put(f"/api/v1/score-conversions/{saved['id']}",json=edit,headers=headers)
        assert changed.status_code==200 and changed.json()['revision']==2
        assert client.put(f"/api/v1/score-conversions/{saved['id']}",json=edit,headers=headers).status_code==409
        rows=client.get('/api/v1/results',params={'group_id':group['id']},headers=headers).json()
        assert [r.get('converted_score') for r in rows]==[75,0,None]
        published=client.post('/api/v1/results/publish',json={'group_id':group['id'],'force_unscanned':True,'reason':'先发布已完成成绩'},headers=headers)
        assert published.status_code==200,published.text
        assert published.json()['conversion_snapshot']['revision']==2
        assert client.put(f"/api/v1/score-conversions/{saved['id']}",json={**edit,'base_revision':2},headers=headers).status_code==409
        # The published definition stays fixed even if the live record is externally changed.
        with db.connect() as connection:
            live=db.get(connection,saved['id']);live['table']['50']=90;db.put(connection,'score-conversions',live)
        assert client.get('/api/v1/results',params={'group_id':group['id']},headers=headers).json()[0]['converted_score']==75
        analysis=client.get('/api/v1/analysis/group',params={'group_id':group['id'],'metric':'converted'},headers=headers).json()
        assert analysis['full_score']==75 and analysis['summary']['average']==75
        archived=client.post(f"/api/v1/projects/{project['id']}/archive",headers=headers)
        assert archived.status_code==200,archived.text
        with zipfile.ZipFile(tmp_path/'archives'/(archived.json()['id']+'.zip')) as package:
            records=json.loads(package.read('data.json'))['records']
            assert any(r['kind']=='score-conversions' and r['data']['id']==saved['id'] for r in records)
            frozen=next(r['data'] for r in records if r['data']['id']==group['id'])
            assert frozen['conversion_snapshot']['table']['50']==75
        teacher={'username':'teacher','password':'teacher-password','name':'教师'}
        client.post('/api/v1/users',json=teacher,headers=headers)
        token=client.post('/api/v1/auth/login',json=teacher).json()['token']
        assert client.post('/api/v1/score-conversions/import-preview',files={'file':('table.csv',csv.encode())},headers={'Authorization':'Bearer '+token}).status_code==403
