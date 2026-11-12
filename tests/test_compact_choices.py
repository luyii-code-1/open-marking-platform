from uuid import uuid4
import cv2
import numpy as np
import pytest
from server import omr, paper
from server.scanner_pipeline import configuration, verify_result
from fastapi import HTTPException


def template():
    return {'id':str(uuid4()),'name':'选择题','paper':'A4','sides':1,'candidate_length':3,'revision':1,'layout_version':2,
            'questions':[{'id':str(uuid4()),'number':7,'type':'multiple','options':5,'points':2,'answer':['A','C'],'choice_style':'bracket','regions':[{'page':1,'x':12,'y':100,'width':58,'height':6}]}]}


def test_compact_geometry_metadata_and_legacy_engine_boundary():
    value=template();q=value['questions'][0];r=q['regions'][0]
    assert paper.bubbles(q,r)==[('A',26,103),('B',35.5,103),('C',45,103),('D',54.5,103),('E',64,103)]
    paper.validate(value)
    assert configuration(value)['questions'][0]['choice_style']=='bracket'
    assert 'answer' not in configuration(value)['questions'][0]
    with pytest.raises(HTTPException) as denied:verify_result(value,'front',{'engine_version':'omp-omr-1'},b'',b'',b'')
    assert denied.value.status_code==409
    with pytest.raises(ValueError):paper.validate({**value,'questions':[{**q,'regions':[{**r,'width':57}]}]})
    with pytest.raises(ValueError):paper.validate({**value,'questions':[{**q,'regions':[{**r,'y':260}]}]})
    legacy={**q};legacy.pop('choice_style')
    assert paper.bubbles(legacy,r)[0]==('A',24,107)


def test_new_brackets_use_gray_strip_for_faint_marks_and_ignore_printed_letters(monkeypatch):
    value=template();w,h=paper.dimensions(value);image=np.full((h*4,w*4),255,np.uint8)
    for i,level in enumerate((255,192,128,64,0)):image[(h-34)*4:(h-29)*4,(62+i*8)*4:(68+i*8)*4]=level
    q=value['questions'][0]
    for label,x,y in paper.bubbles(q,q['regions'][0]):
        if label in ('A','C'):cv2.rectangle(image,(round((x-2.6)*4),round((y-.9)*4)),(round((x+2.6)*4),round((y+.9)*4)),204,-1)
    monkeypatch.setattr(omr,'align',lambda image,template:image)
    _,_,selected=omr.recognize(image,value,'front')
    assert selected[q['id']]==['A','C']
