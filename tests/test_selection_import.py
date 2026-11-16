import io
import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook
from server import db
from server.main import app


@pytest.fixture
def selection(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    with TestClient(app) as client:
        account={'username':'admin','password':'test-administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        auth={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        def create(kind,body):
            result=client.post('/api/v1/'+kind,json=body,headers=auth);assert result.status_code==200,result.text;return result.json()
        g1=create('grades',{'name':'高一'});g2=create('grades',{'name':'高二'})
        c1=create('classes',{'name':'一班','grade_id':g1['id']});c2=create('classes',{'name':'一班','grade_id':g2['id']})
        student=create('students',{'name':'学生甲','candidate_number':'0000123','class_id':c1['id']})
        def upload(path,content,name='selection.csv'):
            return client.post('/api/v1/'+path,files={'file':(name,content,'application/octet-stream')},headers=auth)
        yield locals()


def test_selector_matches_unique_records_and_checks_identity(selection):
    f=selection
    result=f['upload']('selection/students/match','准考证号,姓名\n0000123,学生甲\n0000123,学生甲\n'.encode())
    assert result.status_code==200 and result.json()=={'ids':[f['student']['id']],'matched':1}
    assert f['upload']('selection/students/match','准考证号,姓名\n0000123,其他人\n'.encode()).status_code==422
    assert f['upload']('selection/classes/match','班级\n一班\n'.encode()).status_code==422
    result=f['upload']('selection/classes/match','年级,班级\n高二,一班\n'.encode())
    assert result.status_code==200 and result.json()['ids']==[f['c2']['id']]
    result=f['upload']('selection/grades/match','年级\n高一\n'.encode())
    assert result.status_code==200 and result.json()['ids']==[f['g1']['id']]
    assert f['client'].post('/api/v1/selection/students/match',files={'file':('selection.csv',b'a\nb')}).status_code==401


def test_xlsx_templates_and_parse_validation(selection):
    f=selection
    template=f['client'].get('/api/v1/selection/students/template',headers=f['auth'])
    assert template.status_code==200
    book=load_workbook(io.BytesIO(template.content));sheet=book.active
    assert sheet.cell(2,1).number_format=='@'
    sheet.append([])
    sheet.cell(2,1).value='0000123';sheet.cell(2,2).value='学生甲'
    output=io.BytesIO();book.save(output);book.close()
    result=f['upload']('selection/students/match',output.getvalue(),'selection.xlsx')
    assert result.status_code==200 and result.json()['ids']==[f['student']['id']]
    result=f['upload']('table-import/parse',b'name,grade_id\nOne,grade-1\n')
    assert result.json()=={'headers':['name','grade_id'],'rows':[['One','grade-1']]}
    assert f['upload']('table-import/parse',b'name,name\nA,B\n').status_code==422
    assert f['upload']('table-import/parse',b'name\nA,B\n').status_code==422
    book=Workbook();book.active.append(['name']);book.active.append(['=1+1']);output=io.BytesIO();book.save(output)
    assert f['upload']('table-import/parse',output.getvalue(),'formula.xlsx').status_code==422


def test_subject_rename_and_required_roster_snapshot(selection):
    from server.school import migrate
    f=selection;client=f['client'];auth=f['auth']
    body={'grade_id':f['g1']['id'],'subject':'物理','student_ids':[],'kind':'required'}
    assert client.put('/api/v1/electives',json=body,headers=auth).status_code==200
    project=f['create']('projects',{'name':'期中'})
    subject=f['create']('subjects',{'name':'物理','project_id':project['id']})
    group=f['create']('groups',{'name':'高一物理','subject_id':subject['id'],'grade_id':f['g1']['id']})
    path='/api/v1/groups/'+group['id']+'/roster'
    roster=lambda:client.get(path,headers=auth).json()['students']
    assert len(roster())==1
    f['create']('students',{'name':'新生','candidate_number':'0000124','class_id':f['c1']['id']})
    assert len(roster())==1
    assert client.post(path+'/elective',headers=auth).json()['count']==2
    assert len(roster())==2
    tag=next(t for t in client.get('/api/v1/subject-tags',headers=auth).json() if t['name']=='物理')
    result=client.put('/api/v1/subject-tags/'+tag['id'],json={'name':'物理学'},headers=auth)
    assert result.status_code==200
    migrate()
    tags=client.get('/api/v1/subject-tags',headers=auth).json()
    assert any(t['name']=='物理学' for t in tags) and not any(t['name']=='物理' for t in tags)
    assert client.get('/api/v1/electives',headers=auth).json()[0]['subject']=='物理学'
    assert client.post(path+'/elective',headers=auth).status_code==200
