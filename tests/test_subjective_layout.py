from copy import deepcopy
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from reportlab.lib.units import mm
from server import db,paper
from server.main import app
from server.subjective_layout import reflow,required_height


def region(page,x,y,height=35):
    return {'page':page,'x':x,'y':y,'width':194,'height':height}


def question(number,area=None,**extra):
    return {'id':str(uuid4()),'number':number,'type':'subjective','points':10,'review_mode':'single','style':'line','lines':5,'regions':[area] if area else [],**extra}


def definition():
    return {'id':str(uuid4()),'group_id':str(uuid4()),'status':'draft','revision':0,'name':'动态题区','paper':'A3','sides':2,
            'sheet_columns':2,'layout_version':3,'font_size':13,'leading':20,'candidate_length':9,'notice_template':'none',
            'uniform_subjective':True,'print_style':'standard-v2','auto_subjective_layout':True,'questions':[],
            'print_notes':[],'forbidden_regions':[]}


def test_content_growth_pushes_prompts_across_columns_and_back_without_overlap():
    value=definition()
    value['questions']=[question(1,region(1,12,120),lines=15,content_html='<p>题干文字</p>'),question(2,region(1,12,165)),question(3,region(1,214,180),lines=20)]
    value['print_notes']=[{'id':str(uuid4()),'page':1,'x':214,'y':35,'width':194,'height':18,'html':'版面说明'}]
    value['forbidden_regions']=[{'page':1,'x':214,'y':105,'width':194,'height':10}]
    original=deepcopy(value)
    result,placed=reflow(value)
    assert value==original
    first,second,third=[q['regions'][0] for q in result['questions']]
    assert first['height']>35 and second['page']==1 and second['x']==214 and second['y']==55
    assert third['page']==2 and third['x']==12 and third['y']>=35
    assert all(r['y']+r['height']<=270 for r in placed)
    assert reflow(result)[0]==result
    result['questions'][0]['lines']=1
    smaller,_=reflow(result)
    assert smaller['questions'][0]['regions'][0]['height']==35
    assert smaller['questions'][1]['regions'][0]['x']==12 and smaller['questions'][1]['regions'][0]['y']==165
    paper.validate(smaller)


def test_oversize_prompt_reports_capacity_without_mutating_or_clipping():
    value=definition();value['questions']=[question(1,lines=100)]
    original=deepcopy(value)
    with pytest.raises(ValueError,match='完整栏空间'):reflow(value)
    assert value==original
    value['questions'][0].update(lines=1,content_html='<p>文字</p>'*120)
    with pytest.raises(ValueError,match='完整栏空间'):reflow(value)


def test_existing_manual_regions_keep_boundaries_minima_and_stitch_order():
    value=definition()
    # The explicit scan-stitch order can differ from the page's visual order.
    q=question(1,lines=1)
    q['regions']=[region(2,12,35,80),region(1,12,120,60)]
    value['questions']=[q]
    result,_=reflow(value)
    regions=result['questions'][0]['regions']
    assert len(regions)==2
    assert [(r['page'],r['height'],r['min_height']) for r in regions]==[(2,80,80),(1,60,60)]
    assert reflow(result)[0]==result


def test_merged_prompts_keep_part_regions_and_real_pdf_line_coordinates(monkeypatch):
    value=definition()
    q=question(1,lines=1);q.update(points=20,parts=[{'number':1,'points':10,'style':'line','lines':2,'content_html':'<p>第一题</p>'},{'number':2,'points':10,'style':'line','lines':3,'content_html':'<p>第二题</p>'}])
    value['questions']=[q]
    result,_=reflow(value)
    assert [r['part_number'] for r in result['questions'][0]['regions']]==[1,2]
    lines=[];base=paper.PaperCanvas
    class RecordingCanvas(base):
        def line(self,x1,y1,x2,y2):
            lines.append((x1,y1,x2,y2));return super().line(x1,y1,x2,y2)
    monkeypatch.setattr(paper,'PaperCanvas',RecordingCanvas)
    assert paper.pdf(result).startswith(b'%PDF')
    for part,area in zip(q['parts'],result['questions'][0]['regions']):
        ink=[line for line in lines if abs(line[0]-(area['x']+3)*mm)<.001 and abs(line[2]-(area['x']+area['width']-3)*mm)<.001 and (297-area['y']-area['height'])*mm<=line[1]<=(297-area['y'])*mm]
        assert len(ink)==part['lines']


def test_pdf_labels_continuations_in_stitch_order_for_each_printed_question(monkeypatch):
    value=definition()
    first=question(21,lines=1)
    first['regions']=[region(1,12,100),region(1,12,150),region(2,12,35)]
    merged=question(22,points=20,parts=[{'number':number,'points':10,'lines':1} for number in (22,23)])
    merged['regions']=[{**region(2,214,35),'part_number':22},
                       {**region(1,214,35),'part_number':22},
                       {**region(2,214,85),'part_number':23}]
    value['questions']=[first,merged]
    labels=[]
    draw_string=paper.PaperCanvas.drawString
    def record(canvas,x,y,text,*args,**kwargs):
        if text in ('21','续21','22','续22','23','续23'):
            labels.append((canvas.getPageNumber(),text))
        return draw_string(canvas,x,y,text,*args,**kwargs)
    monkeypatch.setattr(paper.PaperCanvas,'drawString',record)
    paper.pdf(value)
    assert labels==[(1,'21'),(1,'续21'),(1,'续22'),(2,'续21'),(2,'22'),(2,'23')]


def test_layout_endpoint_preserves_published_version_and_returns_draft_geometry(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','name':'管理员','password':'administrator-password'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        value=definition();value['questions']=[question(1,region(1,12,120),lines=8)]
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'考试'})
            subject=db.put(connection,'subjects',{'name':'语文','project_id':project['id']})
            db.put(connection,'groups',{'id':value['group_id'],'name':'题卡','subject_id':subject['id']})
            db.put(connection,'templates',{**value,'status':'published'})
        response=client.post('/api/v1/templates/subjective-layout',json=value,headers=headers)
        assert response.status_code==409
        copied={**value,'id':str(uuid4())}
        response=client.post('/api/v1/templates/subjective-layout',json=copied,headers=headers)
        assert response.status_code==200,response.text
        assert response.json()['value']['questions'][0]['regions'][0]['height']>=required_height(copied['questions'][0],194,copied)
        with db.connect() as connection:
            assert db.get(connection,value['id'],'templates')['status']=='published'
            assert db.get(connection,copied['id'],'templates') is None
