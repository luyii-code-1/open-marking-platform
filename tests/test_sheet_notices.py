import shutil
import subprocess
from uuid import uuid4
import cv2
import pytest
from reportlab.pdfgen import canvas
from fastapi.testclient import TestClient
from server import db,paper,sheet_notices,sheet_style
from server.main import app


@pytest.mark.parametrize('size,columns',[('A4',1),('A3',2),('A3',3)])
@pytest.mark.parametrize('length',[9,11])
def test_reference_notices_render_once_and_do_not_mark_candidate_or_absence(tmp_path,monkeypatch,size,columns,length):
    if not shutil.which('pdftoppm'):pytest.skip('Poppler required')
    definition={'id':str(uuid4()),'name':'标准答题卡','paper':size,'sheet_columns':columns,'sides':2,'layout_version':3,'notice_template':'standard-v1','print_style':'standard-v2','candidate_length':length,'revision':1,'questions':[{'id':str(uuid4()),'number':1,'type':'single','choice_style':'compact','options':4,'answer':['B'],'points':2,'regions':[{'page':1,'x':15,'y':100,'width':40,'height':4.6}]}]}
    captured=[];original=canvas.Canvas.drawString
    def capture(self,x,y,text,*args,**kwargs):captured.append(text);return original(self,x,y,text,*args,**kwargs)
    monkeypatch.setattr(canvas.Canvas,'drawString',capture)
    content=paper.pdf(definition);printed=''.join(captured)
    assert all(note in printed for note in sheet_notices.NOTICES)
    assert sheet_notices.ABSENCE in printed and captured.count('考生禁填')==1 and captured.count('填涂样例')==1
    assert '条形码上的姓名、准考证号' in printed and '每错一个区域扣卷面总分1分' in printed
    assert b'/FontFile2' in content
    source=tmp_path/'sheet.pdf';source.write_bytes(content)
    subprocess.run(['pdftoppm','-r','150','-singlefile','-png',str(source),str(tmp_path/'front')],check=True,capture_output=True)
    image=cv2.imread(str(tmp_path/'front.png'),0);normalized,number,answers=paper.recognize(image,definition,'front')
    assert number=='?'*length and not paper.absent_mark(normalized,'front',definition) and all(not value for value in answers.values())
    width,height=paper.dimensions(definition);sx=image.shape[1]/width;sy=image.shape[0]/height
    def fill(x,y):cv2.rectangle(image,(round((x-1.5)*sx),round((y-1)*sy)),(round((x+1.5)*sx),round((y+1)*sy)),0,-1)
    expected='12345678901'[:length]
    for col,digit in enumerate(expected):fill(18+col*6,57+int(digit)*3.5)
    fill(*paper.absent_position(definition))
    normalized,number,_=paper.recognize(image,definition,'front')
    assert number==expected and paper.absent_mark(normalized,'front',definition)
    captured.clear();paper.pdf({**definition,'notice_template':'none'})
    assert '考生禁填' not in ''.join(captured) and '注意事项' not in ''.join(captured)


def test_standard_notices_persist_in_drafts_and_library_without_changing_grading(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    with TestClient(app) as client:
        account={'username':'admin','password':'long-test-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account);headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        def post(path,body=None):
            response=client.post('/api/v1/'+path,json=body,headers=headers);assert response.status_code==200,response.text;return response.json()
        project=post('projects',{'name':'测试'});subject=post('subjects',{'name':'科目','project_id':project['id'],'group_mode':'default'})
        template=post('templates',{'name':'标准卡','paper':'A4','sides':1,'group_id':subject['default_group_id'],'questions':[{'number':1,'type':'single','options':4,'answer':['B'],'points':2,'regions':[{'page':1,'x':15,'y':100,'width':70,'height':16}]}]})
        assert template['notice_template']=='standard-v1'
        assert template['candidate_length']==9 and template['print_style']=='standard-v2' and template['forbidden_regions']==[]
        area={'page':1,'x':100,'y':200,'width':60,'height':20}
        response=client.put('/api/v1/templates/'+template['id'],json={'forbidden_regions':[area]},headers=headers)
        assert response.status_code==200,response.text
        template=post('templates/'+template['id']+'/publish')
        entry=post('templates/'+template['id']+'/save-to-library',{'name':'通用标准须知'})
        assert entry['definition']['notice_template']=='standard-v1'
        assert entry['definition']['forbidden_regions']==[area]
        subject2=post('subjects',{'name':'第二科目','project_id':project['id'],'group_mode':'default'})
        instance=post('template-library/'+entry['id']+'/instantiate',{'group_id':subject2['default_group_id']})
        assert instance['notice_template']=='standard-v1'
        assert instance['forbidden_regions']==[area] and instance['print_style']=='standard-v2'
        assert post('templates/objective-preview',{'question':template['questions'][0],'selected':['B']})['score']==2
        from server.template_checks import issues
        assert issues({**instance,'notice_template':'unknown'})
        assert issues({**instance,'candidate_length':12})


def test_header_square_cells_and_manual_forbidden_regions(monkeypatch):
    definition={'name':'题卡','paper':'A3','sheet_columns':3,'sides':2,'layout_version':3,'print_style':'standard-v2','notice_template':'standard-v1','candidate_length':11,'questions':[]}
    rectangles=[];original=canvas.Canvas.rect
    def capture(self,x,y,width,height,*args,**kwargs):rectangles.append((x,y,width,height));return original(self,x,y,width,height,*args,**kwargs)
    monkeypatch.setattr(canvas.Canvas,'rect',capture)
    from reportlab.lib.units import mm
    paper.pdf(definition)
    assert any(abs(x-16*mm)<.01 and abs(y-(297-54)*mm)<.01 and width==height==4*mm for x,y,width,height in rectangles)
    geometry=sheet_style.header_geometry(definition)
    assert geometry['top']==35 and geometry['bottom']==94 and geometry['notice_left']==sheet_notices.geometry(definition)[0]
    assert paper.forbidden_regions(definition,1)==paper.forbidden_regions(definition,2)==[]
    area={'page':2,'x':15,'y':35,'width':100,'height':50}
    definition['forbidden_regions']=[area]
    assert paper.forbidden_regions(definition,2)==[area]
    paper.pdf(definition)
    from server.template_checks import issues
    assert issues({**definition,'forbidden_regions':[{**area,'page':1,'y':90}]})
    assert issues({**definition,'forbidden_regions':[{**area,'x':120}]})
    assert issues({**definition,'forbidden_regions':[area,area]})
