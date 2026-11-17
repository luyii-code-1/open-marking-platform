import csv
import io
import time
from uuid import uuid4
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from server import db
from server.main import app


def test_analysis_statistics_rank_scope_conversion_and_exports(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        admin={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        account={'username':'teacher','password':'teacher-password','name':'教师'}
        teacher=client.post('/api/v1/users',json=account,headers=admin).json()
        teacher_headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'期中考试'})
            cls1=db.put(connection,'classes',{'name':'一班','teacher_ids':[teacher['id']],'teaching':{teacher['id']:{'homeroom':True}}})
            cls2=db.put(connection,'classes',{'name':'二班','teacher_ids':[]})
            conversion=db.put(connection,'score-conversions',{'mode':'segments','segments':[{'min':0,'max':10,'target_min':40,'target_max':100}]})
            students=[db.put(connection,'students',{'name':name,'class_id':cls1['id'] if i in (0,1,4) else cls2['id'],'candidate_number':f'{i:03}'}) for i,name in enumerate(('=公式名字','乙','丙','丁','戊','己'))]
            groups=[]
            for subject_index in range(2):
                subject=db.put(connection,'subjects',{'name':('=语文','数学')[subject_index],'project_id':project['id']})
                group=db.put(connection,'groups',{'name':'组','subject_id':subject['id'],'frozen':False})
                objective={'id':str(uuid4()),'number':1,'type':'single','points':3 if subject_index==0 else 20,'answer':['A']}
                subjective={'id':str(uuid4()),'number':5,'type':'subjective','points':7,'review_mode':'single'}
                questions=[objective,subjective] if subject_index==0 else [objective]
                template=db.put(connection,'templates',{'name':'卷','group_id':group['id'],'questions':questions})
                group['template_id']=template['id']
                if subject_index==0:group['conversion_id']=conversion['id']
                db.put(connection,'groups',group);groups.append(group)
                for i,student in enumerate(students):
                    page=db.put(connection,'pages',{'selections':{objective['id']:[] if i==1 and subject_index==0 else ['A']}})
                    submission=db.put(connection,'submissions',{'template_id':template['id'],'group_id':group['id'],'student_id':student['id'],'candidate_number':student['candidate_number'],'pages':[page['id']],'status':'absent' if i==2 else 'ready'})
                    if subject_index==0 and i not in (2,3):
                        db.put(connection,'tasks',{'template_id':template['id'],'question_id':subjective['id'],'submission_id':submission['id'],'user_id':teacher['id'],'status':'completed','created_at':time.time(),'score_cents':(700,400,0,0,700,600)[i]})
        path='/api/v1/analysis/group';params={'group_id':groups[0]['id']}
        assert client.get(path,params=params,headers=teacher_headers).status_code==403
        data=client.get(path,params=params,headers=admin).json()
        assert data['summary']['average']==8.25 and data['summary']['median']==9.5
        assert data['summary']['analyzed']==4 and data['summary']['absent']==1 and data['summary']['pending']==1
        assert data['summary']['pass_rate']==75 and data['summary']['excellent_rate']==75
        assert data['questions'][0]['average']==2.4 and data['questions'][0]['analyzed']==5
        assert [r['scope_rank'] for r in data['students']]==[1,4,None,None,1,3]
        assert sum(b['count'] for b in data['distribution'])==4
        with_absent=client.get(path,params={**params,'include_absent':True},headers=admin).json()
        assert with_absent['summary']['average']==6.6 and with_absent['summary']['analyzed']==5
        converted=client.get(path,params={**params,'metric':'converted'},headers=admin).json()
        assert converted['full_score']==100 and converted['summary']['average']==89.5
        with db.connect() as connection:
            group=db.get(connection,groups[0]['id']);group['frozen']=True;db.put(connection,'groups',group)
        visible=client.get(path,params=params,headers=teacher_headers).json()
        endpoint=f"/api/v1/analysis/groups/{groups[0]['id']}/questions/"
        details=client.get(endpoint+data['questions'][0]['id'],headers=teacher_headers).json()
        assert len(details['rows'])==3 and details['respondents']==3
        assert details['counts']['A']==2 and details['blank']==1
        subjective=client.get(endpoint+data['questions'][1]['id'],headers=admin).json()
        hidden=next(row for row in subjective['rows'] if row['class_name']=='二班')
        assert client.get(hidden['image_url'],headers=teacher_headers).status_code==403
        assert visible['rank_scope']=='assigned_classes' and len(visible['students'])==3
        assert [r['scope_rank'] for r in visible['students']]==[1,3,1]
        assert visible['summary']['average']==8 and len(visible['classes'])==1
        cross=client.get('/api/v1/analysis/project',params={'project_id':project['id']},headers=teacher_headers).json()
        assert len(cross['columns'])==1 and len(cross['students'])==3
        cross=client.get('/api/v1/analysis/project',params={'project_id':project['id']},headers=admin).json()
        assert {c['id']:c['conversion_enabled'] for c in cross['columns']}=={g['id']:bool(g.get('conversion_id')) for g in groups}
        assert len(cross['columns'])==2 and cross['students'][0]['recorded_effective_sum']==120
        for view in ('classes','questions','distribution','students'):
            response=client.get('/api/v1/analysis/group/export',params={**params,'view':view},headers=teacher_headers)
            assert response.status_code==200 and '己' not in response.text
        response=client.get('/api/v1/analysis/project/export',params={'project_id':project['id']},headers=teacher_headers)
        rows=list(csv.reader(io.StringIO(response.content.decode('utf-8-sig'))))
        assert rows[1][1]=="'=公式名字" and len(rows)==4
        assert rows[0][9].startswith("'=")
        for invalid in ({'metric':'no'},{'pass_ratio':.9,'excellent_ratio':.8},{'pass_ratio':'nan'}):
            assert client.get(path,params={**params,**invalid},headers=admin).status_code==422

        # Simulate a merged marking item and a student on the roster with no submission.
        with db.connect() as connection:
            group = db.get(connection, groups[0]['id'])
            template = db.get(connection, group['template_id'])
            template['questions'][1]['parts'] = [{'number': 5, 'points': 3}, {'number': 7, 'points': 4}]
            db.put(connection, 'templates', template)
            missing = db.put(connection, 'students', {'class_id': cls1['id'], 'name': '未到', 'candidate_number': '006'})
            roster = db.put(connection, 'rosters', {'group_id': group['id'], 'students': [*students, missing]})
            db.put(connection, 'groups', {**group, 'roster_id': roster['id']})
            scanned = next(s for s in db.find(connection, 'submissions', group_id=group['id']) if s['candidate_number'] == '001')
            room = db.put(connection, 'room-tags', {'project_id': project['id'], 'name': '考场一'})
            db.put(connection, 'submissions', {**scanned, 'room_tags': [room]})

        def workbook(path, params, headers):
            response = client.get('/api/v1/' + path, params={**params, 'format': 'xlsx'}, headers=headers)
            assert response.status_code == 200 and 'spreadsheetml' in response.headers['Content-Type']
            return load_workbook(io.BytesIO(response.content))

        sheet = workbook('results/export', params, admin).active
        assert sheet.freeze_panes == 'C2'
        headers, *values = list(sheet.values)
        assert headers[6:8] == ('第1题', '第5、7题（合计）')
        rows = {r[0]: r for r in values}
        assert len(rows) == 7 and rows['000'][1:5] == ('=公式名字', '一班', '已完成', 10)
        assert rows['001'][6:8] == (0, 4) and rows['000'][6:8] == (3, 7)
        assert rows['002'][3:8] == ('缺考', 0, 0, 0, 0)
        assert rows['003'][3:8] == ('待结分', None, None, 3, None)
        assert rows['006'][3:8] == ('未扫描', None, None, None, None)
        assert all(c.data_type != 'f' for record in sheet for c in record)
        assert sheet['A2'].data_type == 's'
        filtered = workbook('results/export', {**params, 'room_tag_id': room['id']}, teacher_headers).active
        assert filtered.max_row == 2 and filtered['A2'].value == '001' and filtered['J2'].value == '考场一'
        empty = workbook('results/export', {**params, 'room_tag_id': str(uuid4())}, admin).active
        assert list(empty.values) == [headers]
        project_params = {'project_id': project['id'], 'view': 'items'}
        book = workbook('analysis/project/export', project_params, admin)
        assert len(book.worksheets) == 2
        assert list(book.worksheets[0].values) == list(sheet.values)
        assert '第5、7题（合计）' not in next(book.worksheets[1].values)
        visible_book = workbook('analysis/project/export', project_params, teacher_headers)
        assert len(visible_book.worksheets) == 1
        assert {r[0] for r in list(visible_book.active.values)[1:]} == {'000', '001', '004', '006'}
        assert client.get('/api/v1/analysis/project/export', params={**project_params, 'format':'csv'}, headers=admin).status_code == 422
        for view in ('classes','questions','distribution','students'):
            assert workbook('analysis/group/export', {**params,'view':view}, teacher_headers).active.max_row > 1
        assert workbook('analysis/project/export', {'project_id':project['id']}, teacher_headers).active.max_row == 5
