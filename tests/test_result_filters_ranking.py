import csv
import io
import time
from uuid import uuid4
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from server import db
from server.main import app
from server.class_ranking import class_totals,filter_project
from server.result_filters import ResultFilters


def test_class_totals_exclude_incomplete_and_duplicate_subjects_and_keep_rank_baseline():
    columns=[{'id':'a','subject_id':'math','subject':'数学','conversion_enabled':False},
             {'id':'b','subject_id':'elective','subject':'选考','conversion_enabled':True},
             {'id':'c','subject_id':'math','subject':'数学','conversion_enabled':False}]
    def student(id,scores):return {'student_id':id,'name':id,'class_id':'class','class_name':'一班','candidate_number':id,'scores':scores}
    def score(raw,converted=None,status='completed'):return {'raw':raw,'converted':converted,'status':status}
    data={'columns':columns,'students':[
        student('1',{'a':score(8),'b':score(6,76)}),student('2',{'a':score(8),'b':score(6,76)}),
        student('3',{'a':score(6)}),student('4',{'a':score(None,status='pending'),'b':score(5,70)}),
        student('5',{'a':score(5),'c':score(8)}),student('6',{'a':score(7),'b':score(6)}),
    ]}
    ranked=class_totals(data)
    assert [row['total'] for row in ranked['students']]==[84,84,6,None,None,None]
    assert [row['class_rank'] for row in ranked['students']]==[1,1,3,None,None,None]
    assert ranked['students'][4]['status']=='duplicate_subject' and len(ranked['warnings'])==1
    selected=filter_project(ranked,ResultFilters(student_ids=frozenset({'3'})))
    assert selected['students'][0]['class_rank']==3


def test_filtered_analysis_permissions_and_ranked_workbook_exports(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        credentials={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=credentials).raise_for_status()
        admin={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=credentials).json()['token']}
        teacher=client.post('/api/v1/users',json={'username':'teacher','password':'teacher-password','name':'教师'},headers=admin).json()
        teacher_headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json={'username':'teacher','password':'teacher-password'}).json()['token']}
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'=期末考试'})
            classes=[db.put(connection,'classes',{'name':name,'teacher_ids':[teacher['id']] if index==0 else [],'teaching':{teacher['id']:{'homeroom':True}} if index==0 else {}}) for index,name in enumerate(['一班','二班'])]
            students=[db.put(connection,'students',{'name':name,'class_id':classes[0 if index<4 else 1]['id'],'candidate_number':f'{index:03}'}) for index,name in enumerate(['甲','乙','丙','待评','=隐私姓名'])]
            conversion=db.put(connection,'score-conversions',{'mode':'segments','segments':[{'min':0,'max':10,'target_min':40,'target_max':100}]})
            groups=[]
            for index,name in enumerate(['数学','选考']):
                subject=db.put(connection,'subjects',{'project_id':project['id'],'name':name})
                group=db.put(connection,'groups',{'subject_id':subject['id'],'name':'题卡','frozen':True})
                question={'id':str(uuid4()),'number':1,'type':'subjective','review_mode':'single','points':10}
                template=db.put(connection,'templates',{'group_id':group['id'],'name':name,'questions':[question]})
                group.update(template_id=template['id'])
                if index:group['conversion_id']=conversion['id']
                db.put(connection,'groups',group);groups.append(group)
                for i,student in enumerate(students):
                    if index==1 and i==2:continue # This student did not elect this subject.
                    submission=db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':student['id'],'candidate_number':student['candidate_number'],'status':'ready','pages':[]})
                    if i==3 and index==0:continue
                    score=([8,8,6,0,10] if index==0 else [6,6,0,5,10])[i]
                    db.put(connection,'tasks',{'template_id':template['id'],'question_id':question['id'],'submission_id':submission['id'],'user_id':teacher['id'],'status':'completed','created_at':time.time(),'score_cents':score*100})
        common={'group_id':groups[0]['id'],'class_ids':classes[0]['id'],'q':'丙'}
        filtered=client.get('/api/v1/analysis/group',params=common,headers=admin).json()
        assert filtered['summary']['records']==1 and filtered['summary']['average']==6
        assert filtered['students'][0]['scope_rank']==4 and filtered['students'][0]['class_rank']==3
        detail=client.get('/api/v1/analysis/groups/'+groups[0]['id']+'/questions/'+filtered['questions'][0]['id'],params={'class_ids':classes[0]['id'],'q':'丙'},headers=admin).json()
        assert [row['name'] for row in detail['rows']]==['丙']
        options=client.get('/api/v1/analysis/filter-options',params={'project_id':project['id']},headers=teacher_headers).json()
        assert {c['id'] for c in options['classes']}=={classes[0]['id']}
        assert students[4]['id'] not in {s['id'] for s in options['students']} and len(options['groups'])==2
        hidden=client.get('/api/v1/analysis/group',params={**common,'class_ids':classes[1]['id'],'q':''},headers=teacher_headers).json()
        assert hidden['students']==[]
        scores=client.get('/api/v1/results/export',params=common,headers=admin)
        assert len(list(csv.reader(io.StringIO(scores.content.decode('utf-8-sig')))))==2
        ranking=client.get('/api/v1/analysis/group/export',params={**common,'view':'ranking','format':'xlsx'},headers=admin)
        assert ranking.status_code==200
        sheet=load_workbook(io.BytesIO(ranking.content)).active
        assert sheet.freeze_panes=='A5' and sheet['A5'].value=='丙'
        assert sheet['F5'].value==3 and sheet['A3'].fill.patternType is None
        assert sheet['A5'].fill.patternType is None and sheet['A5'].font.name=='Arial'
        project_params={'project_id':project['id'],'class_ids':classes[0]['id']}
        total=client.get('/api/v1/analysis/project/class-summary',params=project_params,headers=admin).json()
        by_name={row['name']:row for row in total['students']}
        assert by_name['甲']['total']==84 and by_name['乙']['class_rank']==1 and by_name['丙']['class_rank']==3
        assert by_name['丙']['total']==6 and by_name['待评']['total'] is None
        selected=client.get('/api/v1/analysis/project/class-summary',params={**project_params,'student_ids':students[2]['id']},headers=admin).json()
        assert selected['students'][0]['class_rank']==3
        book_response=client.get('/api/v1/analysis/project/export',params={'project_id':project['id'],'view':'class-summary','format':'xlsx'},headers=admin)
        book=load_workbook(io.BytesIO(book_response.content))
        assert len(book.worksheets)==2 and all(ws.freeze_panes=='A5' for ws in book)
        assert all(cell.data_type!='f' for ws in book for row in ws for cell in row)
        assert client.get('/api/v1/analysis/group',params={**common,'statuses':'invalid'},headers=admin).status_code==422
