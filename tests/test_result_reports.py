import io
import time
import zipfile
from uuid import uuid4
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from server import db
from server.main import app
from server.result_reports import tables
from server.scoring import final_score
from server.template_checks import issues


def test_exclusive_double_review_boundaries_and_legacy():
    assert final_score([100,299],'double',2,False)==200
    assert final_score([100,300],'double',2,False) is None
    assert final_score([100,301],'double',2,False) is None
    assert final_score([100,300,250],'double',2,False)==250
    assert final_score([100,300],'double',2)==200
    question={'id':str(uuid4()),'number':1,'type':'subjective','points':10,'review_mode':'double','threshold':0,'threshold_inclusive':False}
    assert any('最大分差' in text for text in issues({'paper':'A4','sides':1,'name':'卷','questions':[question]}))


def test_rank_ties_score_boundaries_and_unfinished_exclusion():
    q={'id':'q','number':1,'type':'single','options':4,'answer':['A'],'points':100}
    students=[]
    for i,value in enumerate((100,90,90,89.99,0,None)):
        students.append({'student_id':str(i),'candidate_number':f'{i:03}','name':'考生','class_id':'c','class_name':'1班','grade':'高二','status':'completed' if value is not None else 'pending','total':value,'scope_rank':(1,2,2,4,5,None)[i],'scores':{'1':value},'answers':{'q':['A']}})
    reports=tables({'question_definitions':[q],'students':students,'metric':'raw','rank_limits':[1,2,3],'full_score':100,'score_step':10})
    assert [row['0-count'] for row in reports['ranks'].rows[:3]]==[1,3,3]
    bands=reports['bands'].rows
    assert bands[0]['0-count']==3 and bands[1]['0-count']==1
    assert bands[9]['0-count']==1 and bands[9]['0-rate']==100
    assert reports['questions'].rows[0]['analyzed']==5
    assert reports['questions'].rows[0]['maximum']==100


def test_formal_exports_class_catalog_visibility_and_pending_answers(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        credentials={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=credentials)
        admin={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=credentials).json()['token']}
        teacher_login={'username':'teacher','password':'teacher-password','name':'教师'}
        teacher=client.post('/api/v1/users',json=teacher_login,headers=admin).json()
        teacher_headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=teacher_login).json()['token']}
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'期中考试'})
            subject=db.put(connection,'subjects',{'name':'历史','project_id':project['id']})
            c1=db.put(connection,'classes',{'name':'1班','grade':'高二','teacher_ids':[teacher['id']],'teaching':{teacher['id']:{'homeroom':True}}})
            c2=db.put(connection,'classes',{'name':'2班','grade':'高二','teacher_ids':[]})
            students=[db.put(connection,'students',{'name':'=公式姓名' if i==0 else f'考生{i}','candidate_number':f'{i+1:03}','class_id':c1['id'] if i<4 else c2['id']}) for i in range(5)]
            group=db.put(connection,'groups',{'name':'历史题卡','subject_id':subject['id'],'frozen':True})
            q1={'id':str(uuid4()),'number':1,'type':'single','points':2,'options':4,'answer':['A']}
            q2={'id':str(uuid4()),'number':5,'type':'subjective','points':8,'review_mode':'double','threshold':2,'threshold_inclusive':False,'parts':[{'number':5,'points':4},{'number':6,'points':4}]}
            template=db.put(connection,'templates',{'name':'历史卷','group_id':group['id'],'questions':[q1,q2]})
            roster=db.put(connection,'rosters',{'group_id':group['id'],'students':students})
            db.put(connection,'groups',{**group,'template_id':template['id'],'roster_id':roster['id']})
            for i,student in enumerate(students):
                if i==3:continue
                page=db.put(connection,'pages',{'selections':{q1['id']:['A'] if i!=1 else []}})
                sub=db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':student['id'],'candidate_number':student['candidate_number'],'pages':[page['id']],'status':'absent' if i==2 else 'ready'})
                if i==2:continue
                for j,value in enumerate((300,100) if i==0 else (200,100)):
                    db.put(connection,'tasks',{'submission_id':sub['id'],'template_id':template['id'],'question_id':q2['id'],'user_id':teacher['id'],'status':'completed','created_at':time.time()+j,'score_cents':value})
        catalog=client.get('/api/v1/analysis/class-catalog',headers=teacher_headers).json()['projects']
        assert len(catalog)==1 and [c['id'] for c in catalog[0]['classes']]==[c1['id']]
        params={'group_id':group['id'],'class_ids':c1['id']}
        report=client.get('/api/v1/analysis/reports',params=params,headers=teacher_headers)
        assert report.status_code==200
        value=report.json();items=value['reports']['items'];rows={r['candidate_number']:r for r in items['rows']}
        assert set(rows)=={'001','002','003','004'}
        assert rows['001']['state']=='待结分' and rows['001'][q2['id']] is None
        assert rows['001'][q1['id']+'-answer']=='A'
        assert rows['002']['total']==1.5 and rows['002'][q1['id']+'-answer']=='留空'
        assert rows['003']['state']=='缺考' and rows['003']['total'] is None and rows['003'][q1['id']] is None
        assert rows['004']['state']=='未扫描' and rows['004']['total'] is None
        exported=client.get('/api/v1/analysis/reports/export',params=params,headers=teacher_headers)
        assert exported.status_code==200
        book=load_workbook(io.BytesIO(exported.content));assert len(book.sheetnames)==5
        sheet=book['小题分'];values=list(sheet.values)
        assert any('合计' in str(v) for v in values[1])
        assert sheet.freeze_panes=='F4' and sheet['A4'].value=='001' and sheet['A4'].data_type=='s' and sheet['A4'].number_format=='@'
        assert sheet['B4'].value=='=公式姓名' and sheet['B4'].data_type=='s'
        single=client.get('/api/v1/analysis/reports/export',params={**params,'report':'questions'},headers=teacher_headers)
        assert len(load_workbook(io.BytesIO(single.content)).sheetnames)==1
        packed=client.get('/api/v1/analysis/reports/export',params={'project_id':project['id'],'class_ids':c1['id']},headers=teacher_headers)
        assert packed.status_code==200 and 'zip' in packed.headers['content-type']
        with zipfile.ZipFile(io.BytesIO(packed.content)) as archive:
            assert len(archive.namelist())==1 and len(load_workbook(io.BytesIO(archive.read(archive.namelist()[0]))).sheetnames)==5
        # Query parameters cannot grant another class's records.
        hidden=client.get('/api/v1/analysis/reports',params={'group_id':group['id'],'class_ids':c2['id']},headers=teacher_headers).json()
        assert hidden['reports']['items']['rows']==[]
        for bad in ({'score_step':0},{'score_step':.001},{'ranks':'0,10'},{'ranks':'x'}):
            assert client.get('/api/v1/analysis/reports',params={**params,**bad},headers=admin).status_code==422
        with db.connect() as connection:
            t=db.get(connection,template['id']);t['questions'][0]['answer']=[];db.put(connection,'templates',t)
        pending=client.get('/api/v1/analysis/reports',params=params,headers=admin).json()
        assert pending['reports']['questions']['rows'][0]['analyzed']==0
        assert pending['reports']['questions']['rows'][0]['answer']=='待录入'
        assert pending['reports']['questions']['rows'][0]['respondents']==2
