import io
import shutil
import subprocess
from uuid import uuid4
from PIL import Image,ImageChops
import pytest
from fastapi.testclient import TestClient
from server import db,paper
from server.main import app


def setup(client):
    account={'username':'admin','password':'administrator-password','name':'管理员'}
    client.post('/api/v1/auth/bootstrap',json=account)
    return {'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}


def definition(group_id,paper_size='A4',sides=1):
    return {'name':'题卡标题','subtitle':'副标题','group_id':group_id,'paper':paper_size,'sides':sides,'candidate_length':3,
        'questions':[{'id':str(uuid4()),'number':2,'type':'single','options':4,'answer':['B'],'points':3,'regions':[{'page':1,'x':15,'y':110,'width':90,'height':20}]},
                     {'id':str(uuid4()),'number':9,'type':'subjective','points':10,'review_mode':'single','threshold':2,'style':'grid','cell_size':8,'content_html':'<p>填写过程与结论</p>','regions':[{'page':sides,'x':15,'y':150,'width':160,'height':60}]}]}


@pytest.mark.parametrize('paper_size,sides',[('A4',1),('A4',2),('A3',2)])
def test_pdf_preview_matches_published_print_pixels_without_persisting_draft(tmp_path,monkeypatch,paper_size,sides):
    renderer=shutil.which('pdftoppm')
    if not renderer:pytest.skip('PDF rasterizer required')
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    with TestClient(app) as client:
        headers=setup(client)
        with db.connect() as connection:group=db.put(connection,'groups',{'name':'组'})
        body=definition(group['id'],paper_size,sides)
        body.update(font_size=13,leading=20)
        body['questions'][1]['content_html']='<p><u>说明</u>，修改：<span data-answer-line="end">&nbsp;</span></p>'
        body.update(column_frame=True,layout_version=3,print_style='standard-v2',print_notes=[
            {'id':'hint','page':sides,'x':20,'y':140,'width':100,'height':10,'html':'<p>补充说明：结果为 _ _ _ 米。</p>'}
        ])
        created=client.post('/api/v1/templates',json=body,headers=headers).json()
        published=client.post(f"/api/v1/templates/{created['id']}/publish",headers=headers)
        assert published.status_code==200,published.text
        template=published.json()
        assert (template['font_size'],template['leading'])==(13,20)
        pdf=client.get(f"/api/v1/templates/{template['id']}/pdf",headers=headers)
        source=tmp_path/'print.pdf';source.write_bytes(pdf.content)
        for page in range(1,sides+1):
            preview=client.post(f'/api/v1/templates/preview?page={page}',json=template,headers=headers)
            assert preview.status_code==200,preview.text
            assert preview.headers['content-type']=='image/png' and preview.headers['cache-control']=='private, no-store'
            prefix=tmp_path/f'print-{page}'
            subprocess.run([renderer,'-r','110','-f',str(page),'-l',str(page),'-singlefile','-png',str(source),str(prefix)],capture_output=True,check=True)
            with Image.open(io.BytesIO(preview.content)) as actual,Image.open(prefix.with_suffix('.png')) as expected:
                assert actual.size==expected.size
                assert ImageChops.difference(actual.convert('RGB'),expected.convert('RGB')).getbbox() is None
            assert paper.decode(preview.content)[1]==''
        with db.connect() as connection:before=connection.execute('SELECT COUNT(*) FROM objects').fetchone()[0]
        assert client.post('/api/v1/templates/preview',json={**body,'id':''},headers=headers).status_code==200
        with db.connect() as connection:assert connection.execute('SELECT COUNT(*) FROM objects').fetchone()[0]==before
        assert client.post('/api/v1/templates/preview?page=3',json=template,headers=headers).status_code==422


def test_default_group_library_snapshot_new_ids_and_used_group_publish_guard(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers=setup(client)
        def create(kind,value):
            response=client.post('/api/v1/'+kind,json=value,headers=headers)
            assert response.status_code==200,response.text
            return response.json()
        project=create('projects',{'name':'考试'})
        subject=create('subjects',{'name':'语文','project_id':project['id'],'group_mode':'default'})
        group=client.post(f"/api/v1/subjects/{subject['id']}/default-group",headers=headers).json()
        assert group['id']==subject['default_group_id'] and group['name']=='Default'
        assert client.post(f"/api/v1/subjects/{subject['id']}/default-group",headers=headers).json()['id']==group['id']
        custom=create('subjects',{'name':'英语','project_id':project['id'],'group_mode':'custom'})
        assert not custom.get('default_group_id')
        source=create('templates',definition(group['id']))
        snapshot=client.post(f"/api/v1/templates/{source['id']}/save-to-library",json={'name':'通用题卡','description':'适合随堂测验'},headers=headers)
        assert snapshot.status_code==200,snapshot.text
        snapshot=snapshot.json()
        assert all('id' not in q for q in snapshot['definition']['questions'])
        edited=client.put(f"/api/v1/templates/{source['id']}",json={'name':'修改原题卡'},headers=headers)
        assert edited.status_code==200
        assert client.get('/api/v1/template-library',headers=headers).json()[0]['definition']['name']=='题卡标题'
        url=f"/api/v1/template-library/{snapshot['id']}/instantiate"
        first=client.post(url,json={'subject_id':custom['id']},headers=headers)
        second=client.post(url,json={'subject_id':custom['id']},headers=headers)
        assert first.status_code==second.status_code==200
        one,two=first.json(),second.json()
        assert one['group_id']==two['group_id'] and one['revision']==0 and one['status']=='draft'
        identifiers=[source['id'],snapshot['id'],one['id'],two['id']]+[q['id'] for t in (source,one,two) for q in t['questions']]
        assert len(set(identifiers))==len(identifiers)
        assert one['questions'][0]['answer']==['B'] and one['library_id']==snapshot['id']
        assert client.post(f"/api/v1/templates/{one['id']}/publish",headers=headers).status_code==200
        create('scan-batches',{'group_id':one['group_id']})
        blocked=client.post(f"/api/v1/templates/{two['id']}/publish",headers=headers)
        assert blocked.status_code==409
        with db.connect() as connection:assert db.get(connection,one['group_id'])['template_id']==one['id']
        replaced=client.post(f"/api/v1/templates/{two['id']}/publish",json={'replace_id':one['id']},headers=headers)
        assert replaced.status_code==200 and replaced.json()['revision']==2
        with db.connect() as connection:
            assert db.get(connection,one['id'])['status']=='superseded'
            assert db.get(connection,one['group_id'])['template_id']==two['id']
            assert db.objects(connection,'scan-batches')[0]['template_id']==one['id']
        assert client.delete('/api/v1/templates/'+one['id'],headers=headers).status_code==409
        assert client.delete('/api/v1/templates/'+two['id'],headers=headers).status_code==200
        with db.connect() as connection:assert db.get(connection,one['group_id'])['template_id'] is None
        teacher=create('users',{'username':'teacher','password':'teacher-password','name':'教师'})
        token=client.post('/api/v1/auth/login',json={'username':'teacher','password':'teacher-password'}).json()['token']
        restricted={'Authorization':'Bearer '+token}
        assert client.get('/api/v1/template-library',headers=restricted).status_code==403
        assert client.post('/api/v1/templates/preview',json=source,headers=restricted).status_code==403


def test_template_check_catches_scoring_and_layout_errors_before_publication(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers=setup(client)
        body=definition(str(uuid4()))
        body['questions'][0].update(answer=['A','B'],rule={'mode':'unavailable'})
        body['questions'][1].update(number=2,review_mode='double',threshold=-1)
        checked=client.post('/api/v1/templates/check',json=body,headers=headers).json()
        assert checked['valid'] is False and len(checked['issues'])>=4
        with db.connect() as connection:group=db.put(connection,'groups',{'name':'组'})
        body['group_id']=group['id']
        saved=client.post('/api/v1/templates',json=body,headers=headers).json()
        assert client.post(f"/api/v1/templates/{saved['id']}/publish",headers=headers).status_code==422
        body=definition(group['id']);body['questions'][1]['regions'][0]['y']=115
        checked=client.post('/api/v1/templates/check',json=body,headers=headers).json()
        assert not checked['valid'] and any('重叠' in issue for issue in checked['issues'])


def test_merged_fill_in_has_one_task_and_one_total(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    with TestClient(app) as client:
        headers=setup(client)
        with db.connect() as connection:
            group=db.put(connection,'groups',{'name':'题卡'})
            student=db.put(connection,'students',{'name':'考生','class_id':'class','candidate_number':'001'})
            teacher=connection.execute('SELECT id FROM users LIMIT 1').fetchone()[0]
        parts=[{'number':n,'points':5,'style':'none'} for n in (12,13,14)]
        regions=[{'part_number':p['number'],'page':1,'x':12,'y':110+24*i,'width':186,'height':20} for i,p in enumerate(parts)]
        q={'number':12,'id':str(uuid4()),'points':15,'type':'subjective','parts':parts,'regions':regions}
        body={'name':'填空题合批','group_id':group['id'],'paper':'A4','sides':1,'questions':[q]}
        created=client.post('/api/v1/templates',json=body,headers=headers).json()
        url='/api/v1/templates/'+created['id']
        assert client.post(url+'/publish',headers=headers).status_code==200
        assert client.get(url+'/pdf',headers=headers).status_code==200
        with db.connect() as connection:
            db.put(connection,'submissions',{'group_id':group['id'],'template_id':created['id'],'student_id':student['id'],'candidate_number':'001','pages':[],'status':'ready'})
        claim={'template_id':created['id'],'question_id':q['id']}
        assert client.post('/api/v1/assignments',json={**claim,'user_ids':[teacher]},headers=headers).status_code==200
        task=client.post('/api/v1/tasks/claim',json=claim,headers=headers).json()
        assert [r['part_number'] for r in task['regions']]==[12,13,14]
        score_url='/api/v1/tasks/'+task['id']+'/score'
        assert client.post(score_url,json={'score':16,'idempotency_key':str(uuid4())},headers=headers).status_code==422
        scored=client.post(score_url,json={'score':12,'idempotency_key':str(uuid4())},headers=headers)
        assert scored.status_code==200 and scored.json()['final_score']==12
        result=client.get('/api/v1/results',params={'group_id':group['id']},headers=headers).json()[0]
        assert result['scores']=={'12～14':12} and result['total']==12
        assert client.post('/api/v1/tasks/claim',json=claim,headers=headers).json() is None
