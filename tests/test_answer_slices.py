import io
import json
import zipfile
from uuid import uuid4
from PIL import Image
from fastapi.testclient import TestClient
from server import db
from server.main import app


def test_scanned_answer_ids_and_historical_images_survive_replacement_and_color_override(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        login=client.post('/api/v1/auth/login',json=account).json();headers={'Authorization':'Bearer '+login['token']}
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'考试'})
            subject=db.put(connection,'subjects',{'project_id':project['id'],'name':'语文'})
            group=db.put(connection,'groups',{'subject_id':subject['id'],'name':'组'})
            student=db.put(connection,'students',{'name':'学生','candidate_number':'001','class_id':'class'})
            questions=[{'id':str(uuid4()),'number':1,'type':'single','options':4,'answer':['A'],'points':3,'regions':[{'page':1,'x':10,'y':110,'width':80,'height':20}]},
                       {'id':str(uuid4()),'number':5,'type':'subjective','points':10,'review_mode':'single','regions':[{'page':1,'x':10,'y':150,'width':100,'height':60}]}]
            template=db.put(connection,'templates',{'name':'题卡','group_id':group['id'],'paper':'A4','sides':1,'revision':1,'status':'published','questions':questions})
            group['template_id']=template['id'];db.put(connection,'groups',group)
            batch=db.put(connection,'scan-batches',{'group_id':group['id'],'template_id':template['id'],'status':'front'})
            page=db.put(connection,'pages',{'batch_id':batch['id'],'side':'front','sequence':1,'status':'recognized','candidate_number':'001','selections':{questions[0]['id']:['A']}})
            db.put(connection,'assignments',{'template_id':template['id'],'question_id':questions[1]['id'],'user_ids':[login['user']['id']]})
        pages=tmp_path/'pages';pages.mkdir()
        Image.new('RGB',(840,1188),'red').save(pages/(page['id']+'.png'))
        (pages/(page['id']+'.image')).write_bytes((pages/(page['id']+'.png')).read_bytes())
        url=f"/api/v1/scan-batches/{batch['id']}/pair"
        assert client.post(url,headers=headers).status_code==200
        with db.connect() as connection:submission=db.objects(connection,'submissions')[0]
        original=dict(submission['answer_slice_ids']);qid=questions[1]['id']
        assert set(original)=={q['id'] for q in questions} and len(set(original.values()))==2
        assert not set(original.values()) & {submission['id'],template['id'],*original}
        assert client.post(url,headers=headers).status_code==200
        path=f"/api/v1/submissions/{submission['id']}"
        rows=client.get(path+'/answer-slices',headers=headers).json()
        assert {r['id'] for r in rows}==set(original.values())
        claim={'template_id':template['id'],'question_id':qid}
        old_task=client.post('/api/v1/tasks/claim',json=claim,headers=headers).json()
        assert old_task['answer_slice_id']==original[qid]
        def color(task_id):
            response=client.get(f'/api/v1/tasks/{task_id}/image',headers=headers)
            assert response.status_code==200,response.text
            with Image.open(io.BytesIO(response.content)) as image:return image.convert('RGB').getpixel((image.width//2,image.height//2))
        assert color(old_task['id'])[0]>230
        with db.connect() as connection:
            new_batch=db.put(connection,'scan-batches',{'group_id':group['id'],'template_id':template['id'],'status':'front'})
            new_page=db.put(connection,'pages',{**page,'id':str(uuid4()),'batch_id':new_batch['id']})
        Image.new('RGB',(840,1188),'blue').save(pages/(new_page['id']+'.png'))
        (pages/(new_page['id']+'.image')).write_bytes((pages/(new_page['id']+'.png')).read_bytes())
        replaced=client.post(path+'/replace-page',json={'page':1,'page_id':new_page['id'],'reason':'补扫替换'},headers=headers)
        assert replaced.status_code==200,replaced.text
        replacement=replaced.json()['answer_slice_ids']
        assert all(replacement[k]!=original[k] for k in original)
        assert color(old_task['id'])[0]>230 and color(old_task['id'])[2]<20
        new_task=client.post('/api/v1/tasks/claim',json=claim,headers=headers).json()
        assert new_task['answer_slice_id']==replacement[qid] and color(new_task['id'])[2]>230
        with db.connect() as connection:asset=db.put(connection,'assets',{'purpose':'special_answer'})
        assets=tmp_path/'assets';assets.mkdir();Image.new('RGB',(400,240),'lime').save(assets/(asset['id']+'.png'))
        changed=client.put(path+f'/regions/{qid}',json={'asset_id':asset['id'],'reason':'彩色补图'},headers=headers)
        assert changed.status_code==200,changed.text
        mapping=changed.json()['answer_slice_ids']
        assert mapping[qid]!=replacement[qid] and mapping[questions[0]['id']]==replacement[questions[0]['id']]
        assert color(new_task['id'])[2]>230
        final_task=client.post('/api/v1/tasks/claim',json=claim,headers=headers).json()
        assert final_task['answer_slice_id']==mapping[qid] and color(final_task['id'])[1]>230
        history=client.get(path+'/answer-slices?history=true',headers=headers).json()
        assert len(history)==5 and sum(r['status']=='current' for r in history)==2
        old=next(r for r in history if r['id']==original[qid])
        assert old['sources'][0]['page_id']==page['id'] and old['superseded_by']==replacement[qid]
        assert {r['id'] for r in client.get(path+'/answer-slices',headers=headers).json()}==set(mapping.values())
        with db.connect() as connection:assert len(db.objects(connection,'answer-slices'))==5
        with db.connect() as connection:second_asset=db.put(connection,'assets',{'purpose':'special_answer'})
        Image.new('RGB',(400,240),'purple').save(assets/(second_asset['id']+'.png'))
        assert client.put(path+f'/regions/{qid}',json={'asset_id':second_asset['id'],'reason':'再次补充清晰彩色原图'},headers=headers).status_code==200
        assert color(final_task['id'])[1]>230
        archived=client.post(f"/api/v1/projects/{project['id']}/archive",headers=headers)
        assert archived.status_code==200,archived.text
        with zipfile.ZipFile(tmp_path/'archives'/(archived.json()['id']+'.zip')) as package:
            assert {f"assets/{asset['id']}.png",f"assets/{second_asset['id']}.png"}<=set(package.namelist())
            data=json.loads(package.read('data.json'))
            assert len([r for r in data['records'] if r['kind']=='answer-slices'])==6
            assert set(original.values()) <= {r['id'] for r in data['identifiers']}
