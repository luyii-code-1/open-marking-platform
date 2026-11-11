import shutil
import subprocess
from uuid import uuid4
import cv2
import pytest
from server import paper


@pytest.mark.parametrize('size',['A4','A3'])
def test_print_read_roundtrip(tmp_path,size,monkeypatch):
    renderer=shutil.which('pdftoppm')
    if not renderer: pytest.skip('PDF rasterizer required')
    question={'id':str(uuid4()),'number':1,'type':'single','options':4,'answer':['B'],'points':3,'regions':[{'page':1,'x':15,'y':110,'width':90,'height':20}]}
    template={'id':'1e1995b7-e068-4dfd-8582-19d0f879ba98','name':'Test paper','paper':size,'sides':1,'candidate_length':3,'revision':1,'layout_version':2,'questions':[question]}
    source=tmp_path/'sheet.pdf'; source.write_bytes(paper.pdf(template))
    subprocess.run([renderer,'-r','150','-singlefile','-png',str(source),str(tmp_path/'sheet')],check=True,capture_output=True)
    data=(tmp_path/'sheet.png').read_bytes()
    image,value=paper.decode(data)
    assert value==paper.code(template,'front')
    normalized,candidate,selections=paper.recognize(image,template,'front')
    assert not paper.absent_mark(normalized,'front')
    assert candidate=='???'
    assert selections[question['id']]==[]
    width,height=paper.dimensions(template); sx=image.shape[1]/width; sy=image.shape[0]/height
    def fill(x,y): cv2.rectangle(image,(round((x-1.5)*sx),round((y-1)*sy)),(round((x+1.5)*sx),round((y+1)*sy)),0,-1)
    for column,digit in enumerate('123'): fill(18+column*6,57+int(digit)*3.5)
    _,bx,by=paper.bubbles(question,question['regions'][0])[1]; fill(bx,by)
    fill(paper.ABSENT_X,paper.ABSENT_Y)
    normalized,candidate,selections=paper.recognize(image,template,'front')
    assert paper.absent_mark(normalized,'front') and not paper.absent_mark(normalized,'back')
    assert not paper.absent_mark(normalized,'front',{'layout_version':1})
    assert candidate=='123'
    assert selections[question['id']]==['B']
    for rotation in (cv2.ROTATE_90_CLOCKWISE,cv2.ROTATE_180,cv2.ROTATE_90_COUNTERCLOCKWISE):
        rotated=cv2.rotate(image,rotation)
        encoded=cv2.imencode('.png',rotated)[1].tobytes()
        restored,decoded=paper.decode(encoded)
        assert decoded==paper.code(template,'front')
        _,number,answers=paper.recognize(restored,template,'front')
        assert number=='123'
        assert answers[question['id']]==['B']
    from server import db,jobs
    monkeypatch.setattr(db,'ROOT',tmp_path/'data');monkeypatch.setenv('OMP_TASK_MODE','inline');db.initialize()
    with db.connect() as connection:
        group=db.put(connection,'groups',{'name':'test'})
        template['group_id']=group['id'];db.put(connection,'templates',template)
        batch=db.put(connection,'scan-batches',{'group_id':group['id'],'template_id':template['id']})
        page=db.put(connection,'pages',{'batch_id':batch['id'],'side':'front','sequence':1,'status':'received'})
    directory=db.ROOT/'pages';directory.mkdir()
    (directory/(page['id']+'.image')).write_bytes(cv2.imencode('.png',image)[1].tobytes())
    task=jobs.queue('process-page',{'page_id':page['id']})
    with db.connect() as connection:
        result=db.get(connection,page['id'],'pages')
        assert result['status']=='recognized' and result['candidate_number']=='123'
        assert result['selections'][question['id']]==['B']
        assert result['absent_mark'] is True
        assert db.get(connection,task['id'],'jobs')['status']=='completed'
