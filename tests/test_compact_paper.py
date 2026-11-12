import io
import json
from pathlib import Path
import shutil
import subprocess
from uuid import uuid4
import cv2
import pytest
from fastapi.testclient import TestClient
from server import db,paper
from server.main import app
from scanner_engine.main import process


@pytest.mark.parametrize('layout_index',[0,1,2])
def test_compact_frontend_layout_embedded_text_and_local_recognition(tmp_path,layout_index):
    if not shutil.which('pdftoppm') or not shutil.which('node'):pytest.skip('Node and Poppler required')
    repo=Path(__file__).resolve().parents[1];fixture=tmp_path/'layout.json'
    subprocess.run(['node','tools/test-objective-layout.mjs',str(fixture)],cwd=repo/'web',check=True,capture_output=True)
    template=json.loads(fixture.read_text(encoding='utf-8'))['templates'][layout_index]
    template['name']='全科考试答题卡';template['subtitle']='客观题与主观题'
    content=paper.pdf(template);source=tmp_path/'paper.pdf';source.write_bytes(content)
    assert b'/FontFile2' in content
    subprocess.run(['pdftoppm','-r','150','-png',str(source),str(tmp_path/'sheet')],check=True,capture_output=True)
    batch=str(uuid4());folder=tmp_path/'pages'/batch;folder.mkdir(parents=True)
    for page in (1,2):
        image=cv2.imread(str(tmp_path/f'sheet-{page}.png'),cv2.IMREAD_GRAYSCALE)
        _,value=paper.decode(cv2.imencode('.png',image)[1].tobytes());assert value==''
        _,_,empty=paper.recognize(image,template,'front' if page==1 else 'back');assert all(not v for v in empty.values())
        width,height=paper.dimensions(template);sx=image.shape[1]/width;sy=image.shape[0]/height
        if page==1:
            ax,_=paper.absent_position(template)
            for x,y,w,h in ((15,14,60,7),(ax-23,42,18,5),(ax-24,48,25,4)):
                crop=image[round(y*sy):round((y+h)*sy),round(x*sx):round((x+w)*sx)]
                assert (crop<150).sum()>30,'Chinese title/absence text was not rendered'
        def fill(x,y):cv2.rectangle(image,(round((x-1.4)*sx),round((y-.9)*sy)),(round((x+1.4)*sx),round((y+.9)*sy)),0,-1)
        if page==1:
            for col,digit in enumerate('123'):fill(18+col*6,57+int(digit)*3.5)
            fill(*paper.absent_position(template))
        for question in template['questions']:
            for region in question['regions']:
                if region['page']==page:
                    for letter,x,y in paper.bubbles(question,region):
                        if letter in question['answer']:fill(x,y)
        identifier=str(uuid4());data=cv2.imencode('.jpg',image)[1].tobytes();(folder/(identifier+'.jpg')).write_bytes(data)
        import hashlib
        result=process(tmp_path,{'batch_id':batch,'capture_id':identifier,'side':'front' if page==1 else 'back','template':template,'config_sha256':'fixture','source_sha256':hashlib.sha256(data).hexdigest()})
        assert result['candidate_number']==('123' if page==1 else None)
        assert result['absent_mark']==(page==1)
        assert all(result['selections'][q['id']]==q['answer'] for q in template['questions'] if any(r['page']==page for r in q['regions']))


def test_objective_rule_trial_uses_formal_grading_and_bounds(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    with TestClient(app) as client:
        account={'username':'admin','password':'long-test-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        question={'number':1,'type':'multiple','options':5,'answer':['A','C'],'points':2,'rule':{'mode':'per_option','correct_points':1,'wrong_penalty':0,'wrong_action':'deduct'}}
        def trial(selected,status=200):
            response=client.post('/api/v1/templates/objective-preview',json={'question':question,'selected':selected},headers=headers)
            assert response.status_code==status,response.text
            return response.json()
        assert trial(['A','B'])['score']==1
        question['rule']['wrong_action']='zero';assert trial(['A','B'])['score']==0
        assert trial(['A'])['score']==1 and trial(['A','C'])['score']==2
        question['rule'].update(correct_points=5);assert trial(['A','C'])['score']==2
        question['rule'].update(wrong_action='deduct',wrong_penalty=10);assert trial(['B'])['score']==0
        assert trial([])['score']==0
        question['rule']['script']='anything';trial(['A'],422)
        question['rule']={'mode':'partial','partial_points':1};assert trial(['A'])['score']==1 and trial(['B'])['score']==0
