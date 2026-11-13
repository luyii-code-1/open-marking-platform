import io
import zipfile
from xml.etree import ElementTree as ET
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from server import db
from server.main import app


@pytest.fixture
def roster_school(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        assert client.post('/api/v1/auth/bootstrap',json=account).status_code==200
        client.headers['Authorization']='Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']
        def post(path,body):
            response=client.post('/api/v1/'+path,json=body);assert response.status_code==200,response.text;return response.json()
        grade=post('grades',{'name':'高一'});other=post('grades',{'name':'高二'})
        cls=post('classes',{'name':'一班','grade_id':grade['id']});other_cls=post('classes',{'name':'二班','grade_id':other['id']})
        students=[post('students',{'name':name,'candidate_number':number,'class_id':class_id}) for name,number,class_id in [('甲','000000001',cls['id']),('乙','000000002',cls['id']),('丙','000000003',other_cls['id'])]]
        project=post('projects',{'name':'期中'});subject=post('subjects',{'name':'物理','project_id':project['id']})
        group=post('groups',{'name':'物理题卡','subject_id':subject['id'],'grade_id':grade['id']})
        path='/api/v1/groups/'+group['id']+'/roster'
        def preview(content,filename='students.csv',**data):
            return client.post(path+'/import',files={'file':(filename,content)},data=data)
        yield locals()


def test_selected_membership_is_live_and_reaches_results_and_scanner(roster_school):
    f=roster_school;c=f['client'];path=f['path'];student=f['students'][0]
    assert len(c.get(path).json()['students'])==2
    content='准考证号,姓名\n000000001,甲\n000000001,甲\n'.encode()
    preview=f['preview'](content).json();assert preview['matched_count']==1 and preview['duplicates']==1 and not preview['errors']
    assert len(c.get(path).json()['students'])==2,'Preview must not change membership'
    imported=f['preview'](content,action='import',preview_sha=preview['preview_sha']);assert imported.status_code==200,imported.text
    roster=c.get(path).json();assert roster['mode']=='selected' and [s['id'] for s in roster['students']]==[student['id']]
    with db.connect() as connection:
        template=db.put(connection,'templates',{'name':'物理','group_id':f['group']['id'],'paper':'A4','sides':1,'revision':1,'status':'published','questions':[]})
        group=db.get(connection,f['group']['id'],'groups');group['template_id']=template['id'];db.put(connection,'groups',group)
    rows=c.get('/api/v1/results',params={'group_id':group['id']}).json()
    assert len(rows)==1 and rows[0]['student_id']==student['id'] and rows[0]['status']=='unscanned'
    package=c.get('/api/v1/scanner/projects/'+f['project']['id']+'/package');assert package.status_code==200,package.text
    assert [s['id'] for s in package.json()['groups'][0]['roster']]==[student['id']]
    excluded=c.post('/api/v1/groups/'+group['id']+'/absent',json={'student_id':f['students'][1]['id'],'reason':'核实缺考'})
    assert excluded.status_code==422
    assert c.put('/api/v1/students/'+student['id'],json={'name':'新姓名','class_id':f['other_cls']['id']}).status_code==200
    roster=c.get(path).json();assert len(roster['students'])==1 and roster['students'][0]['name']=='新姓名' and roster['students'][0]['grade']=='高二'
    assert c.put(path,json={'mode':'grade'}).status_code==200
    assert [s['id'] for s in c.get(path).json()['students']]==[f['students'][1]['id']]


def test_errors_warnings_and_stale_preview_are_atomic(roster_school):
    f=roster_school;c=f['client'];before=c.get(f['path']).json()['students']
    unknown=b'candidate_number,name\n000000001,\n999999999,\n'
    preview=f['preview'](unknown).json();assert len(preview['errors'])==1
    assert f['preview'](unknown,action='import',preview_sha=preview['preview_sha']).status_code==422
    assert c.get(f['path']).json()['students']==before
    content='准考证号,姓名\n000000003,旧姓名\n'.encode()
    preview=f['preview'](content).json();assert len(preview['warnings'])==1
    assert f['preview'](content,action='import',preview_sha=preview['preview_sha']).status_code==422
    assert c.put('/api/v1/students/'+f['students'][2]['id'],json={'name':'已更名'}).status_code==200
    assert f['preview'](content,action='import',preview_sha=preview['preview_sha'],confirm_warnings='true').status_code==409
    preview=f['preview'](content).json()
    assert f['preview'](content,action='import',preview_sha=preview['preview_sha'],confirm_warnings='true').status_code==200
    assert c.get(f['path']).json()['students'][0]['id']==f['students'][2]['id']


def xlsx_with_rows(template,rows):
    ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';out=io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(template)) as source,zipfile.ZipFile(out,'w') as target:
        for item in source.infolist():
            content=source.read(item.filename)
            if item.filename=='xl/worksheets/sheet1.xml':
                root=ET.fromstring(content);data=root.find('{'+ns+'}sheetData')
                for row in list(data):
                    if row.attrib.get('r')!='1':data.remove(row)
                for index,values in enumerate(rows,2):
                    row=ET.SubElement(data,'{'+ns+'}row',r=str(index))
                    for col,value in zip(('A','B'),values):
                        cell=ET.SubElement(row,'{'+ns+'}c',r=col+str(index),t='inlineStr')
                        if value.startswith('='):ET.SubElement(cell,'{'+ns+'}f').text=value[1:]
                        else:ET.SubElement(ET.SubElement(cell,'{'+ns+'}is'),'{'+ns+'}t').text=value
                content=ET.tostring(root,encoding='utf-8')
            target.writestr(item,content)
    return out.getvalue()


def test_excel_template_leading_zeros_and_formulas(roster_school):
    f=roster_school;response=f['client'].get(f['path']+'/template');assert response.status_code==200
    from openpyxl import load_workbook
    book=load_workbook(io.BytesIO(response.content),read_only=True)
    assert book['应考名单']['A1'].value=='准考证号' and book['应考名单']['A2'].number_format=='@';book.close()
    content=xlsx_with_rows(response.content,[['000000001','甲'],['000000002','乙']])
    result=f['preview'](content,'名单.xlsx');assert result.status_code==200,result.text
    assert result.json()['matched_count']==2 and not result.json()['errors']
    formula=xlsx_with_rows(response.content,[['=1+1','甲']])
    assert f['preview'](formula,'formula.xlsx').status_code==422
    assert f['preview'](b'broken','名单.xlsx').status_code==422
    assert f['preview'](b'broken','名单.xls').status_code==422


def test_subject_grade_links_and_import_permissions(roster_school):
    f=roster_school;c=f['client']
    response=c.post('/api/v1/subjects/'+f['subject']['id']+'/grades',json={'grade_id':f['other']['id']});assert response.status_code==200
    assert response.json()['grade_ids']==[f['other']['id']]
    assert c.post('/api/v1/subjects/'+f['subject']['id']+'/grades',json={'grade_id':f['other']['id']}).json()['grade_ids']==[f['other']['id']]
    assert next(g for g in c.get('/api/v1/groups').json() if g['id']==f['group']['id'])['grade_name']=='高一'
    with db.connect() as connection:
        group=db.get(connection,f['group']['id'],'groups');group['frozen']=True;db.put(connection,'groups',group)
    assert f['preview'](b'candidate_number\n000000001\n').status_code==409
    assert c.put(f['path'],json={'mode':'grade'}).status_code==409
    assert c.put('/api/v1/groups/'+group['id']+'/grade',json={'grade_id':f['other']['id']}).status_code==409
    c.headers.pop('Authorization')
    assert c.get(f['path']+'/template').status_code==401
    assert f['preview'](b'candidate_number\n000000001\n').status_code==401
