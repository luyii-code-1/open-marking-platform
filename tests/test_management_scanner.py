import hashlib
import io
import json
import time
import zipfile
from uuid import uuid4

import pytest
from PIL import Image
from fastapi.testclient import TestClient
from cryptography.hazmat.primitives import serialization,hashes
from cryptography.hazmat.primitives.asymmetric import ec
from server import db
from server.main import app
from server.scanner_auth import encode,message


@pytest.fixture
def setup(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        root={'username':'root','password':'root-long-password','name':'系统管理员'}
        client.post('/api/v1/auth/bootstrap',json=root).raise_for_status()
        def login(account):
            response=client.post('/api/v1/auth/login',json={**account,'portal':'admin'});response.raise_for_status()
            return {'Authorization':'Bearer '+response.json()['token']}
        system=login(root)
        def post(path,value,headers=system,status=200):
            response=client.post('/api/v1/'+path,json=value,headers=headers)
            assert response.status_code==status,response.text
            return response.json()
        account={'username':'manager','password':'manager-long-password','name':'管理教师','role':'manager'}
        manager=post('users',account);managed=login(account)
        teacher=post('users',{'username':'teacher','password':'teacher-long-password','name':'教师','role':'teacher'})
        project=post('projects',{'name':'标签考试'},managed)
        subject=post('subjects',{'project_id':project['id'],'name':'语文','group_mode':'default'},managed)
        group_id=subject['default_group_id']
        classroom=post('classes',{'name':'一班','grade':'10'},managed)
        for candidate in ('123','124'):post('students',{'class_id':classroom['id'],'name':candidate,'candidate_number':candidate},managed)
        template=post('templates',{'group_id':group_id,'name':'验证卷','paper':'A4','sides':1,'candidate_length':3,'questions':[{'number':1,'type':'single','options':4,'points':1,'answer':['B'],'regions':[{'page':1,'x':15,'y':110,'width':90,'height':20}]}]},managed)
        template=post('templates/'+template['id']+'/publish',None,managed)
        yield dict(client=client,system=system,managed=managed,manager=manager,teacher=teacher,post=post,project=project,group_id=group_id,template=template,root=tmp_path)


def test_manager_business_and_system_account_boundaries(setup):
    f=setup;c=f['client'];h=f['managed'];post=f['post']
    for path in ('projects','subjects','groups','classes','students','users','dashboard'):
        assert c.get('/api/v1/'+path,headers=h).status_code==200
    for path in ('system/backups','storage-connections','scanner/devices','system/audit','system/requests'):
        assert c.get('/api/v1/'+path,headers=h).status_code==403,path
    assert c.post('/api/v1/system/backup',headers=h).status_code==403
    assert c.post('/api/v1/score-conversions',headers=h,json={}).status_code==403
    for role in ('admin','manager'):
        assert c.post('/api/v1/users',headers=h,json={'username':'forbidden'+role,'name':'禁止','password':'long-password-123','role':role}).status_code==403
    teacher=f['teacher']['id']
    assert c.put('/api/v1/users/'+teacher,headers=h,json={'name':'可维护普通教师'}).status_code==200
    assert c.put('/api/v1/users/'+teacher,headers=h,json={'role':'manager'}).status_code==403
    assert c.post('/api/v1/users/'+f['manager']['id']+'/reset-password',headers=h,json={'password':'another-long-password'}).status_code==403
    assert c.post('/api/v1/users/'+teacher+'/reset-password',headers=h,json={'password':'teacher-new-password'}).status_code==200


def test_one_time_pairing_authentication_and_role_revocation(setup):
    f=setup;c=f['client'];post=f['post'];h=f['managed']
    pairing=post('scanner/pairings',None,h,201)
    key=ec.generate_private_key(ec.SECP256R1());public=encode(key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo))
    body={'code':pairing['code'],'public_key':public,'label':'扫描电脑'}
    device=post('scanner/pair',body,{},200)['device']
    assert device['owner_id']==f['manager']['id']
    assert c.post('/api/v1/scanner/pair',json=body).status_code==403
    challenge=post('scanner/challenge',{'device_id':device['id']},{})
    signature=encode(key.sign(message(challenge),ec.ECDSA(hashes.SHA256())))
    session=post('scanner/authenticate',{'challenge_id':challenge['id'],'signature':signature},{})
    assert c.get('/api/v1/scanner/catalog',headers={'Authorization':'Bearer '+session['token']}).status_code==200
    assert c.get('/api/v1/scanner/pairings/'+pairing['id'],headers=h).json()['status']=='paired'
    with db.connect() as conn:
        rows=json.dumps([dict(r) for r in conn.execute('SELECT * FROM objects')])
        assert pairing['code'] not in rows and pairing['code'].replace('-','') not in rows
    assert c.put('/api/v1/users/'+f['manager']['id'],headers=f['system'],json={'role':'teacher'}).status_code==200
    assert c.get('/api/v1/scanner/catalog',headers={'Authorization':'Bearer '+session['token']}).status_code==403


def test_cancelled_expired_pairing_and_existing_owner_protection(setup):
    f=setup;c=f['client'];post=f['post'];h=f['managed']
    first=post('scanner/pairings',None,h,201);second=post('scanner/pairings',None,h,201)
    key=ec.generate_private_key(ec.SECP256R1());pub=encode(key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo))
    body={'code':first['code'],'public_key':pub,'label':'电脑'}
    assert c.post('/api/v1/scanner/pair',json=body).status_code==403
    with db.connect() as conn:
        value=db.get(conn,second['id']);value['expires_at']=time.time()-1;db.put(conn,'scanner-pairings',value)
    assert c.post('/api/v1/scanner/pair',json={**body,'code':second['code']}).status_code==403
    admin_code=post('scanner/pairings',None,f['system'],201)
    post('scanner/pair',{**body,'code':admin_code['code']},{})
    another=post('scanner/pairings',None,h,201)
    assert c.post('/api/v1/scanner/pair',json={**body,'code':another['code']}).status_code==409


def test_installer_download_ticket_and_current_role(setup,monkeypatch):
    f=setup;c=f['client'];root=f['root']/'distribution';root.mkdir()
    content=b'MZ-test-installer';(root/'Scanner-Setup.exe').write_bytes(content)
    (root/'release.json').write_text(json.dumps({'file':'Scanner-Setup.exe','size':len(content),'sha256':hashlib.sha256(content).hexdigest(),'version':'test'}))
    monkeypatch.setenv('OMP_SCANNER_DISTRIBUTION',str(root))
    assert c.get('/api/v1/scanner/distribution',headers=f['managed']).json()['available']
    ticket=f['post']('scanner/download-link',None,f['managed'])
    assert c.get(ticket['url']).content==content
    c.put('/api/v1/users/'+f['manager']['id'],headers=f['system'],json={'role':'teacher'})
    assert c.get(ticket['url']).status_code==403
    assert c.get('/api/v1/scanner/distribution',headers=f['managed']).status_code==403


def paired_page(f,batch,candidate):
    image=io.BytesIO();Image.new('L',(840,1188),255).save(image,'PNG');content=image.getvalue();identifier=str(uuid4())
    folder=f['root']/'pages';folder.mkdir(exist_ok=True)
    for suffix in ('.image','.png'):(folder/(identifier+suffix)).write_bytes(content)
    with db.connect() as conn:
        db.put(conn,'pages',{'id':identifier,'batch_id':batch['id'],'side':'front','sequence':1,'status':'recognized','candidate_number':candidate,'absent_mark':False,'sha256':hashlib.sha256(content).hexdigest(),'normalized_sha256':hashlib.sha256(content).hexdigest(),'selections':{f['template']['questions'][0]['id']:['B']}})
    f['post']('scan-batches/'+batch['id']+'/pair',None,f['managed'])


def test_project_tags_snapshot_pairing_filter_export_archive(setup):
    f=setup;c=f['client'];post=f['post'];h=f['managed'];project=f['project']['id']
    tag=post('projects/'+project+'/room-tags',{'name':'一考场'},h,201)
    assert c.post('/api/v1/projects/'+project+'/room-tags',headers=h,json={'name':'一考场'}).status_code==409
    other=post('projects',{'name':'其他考试'},h)
    foreign=post('projects/'+other['id']+'/room-tags',{'name':'其他考场'},h,201)
    assert c.post('/api/v1/scan-batches',headers=h,json={'group_id':f['group_id'],'room_tag_ids':[foreign['id']]}).status_code==422
    extra=post('projects/'+project+'/room-tags',{'name':'二楼'},h,201)
    assert c.post('/api/v1/scan-batches',headers=h,json={'group_id':f['group_id'],'room_tag_ids':None}).status_code==422
    batch=post('scan-batches',{'group_id':f['group_id'],'room_tag_ids':[tag['id'],extra['id']],'room':'旧备注'},h)
    assert c.put('/api/v1/room-tags/'+tag['id'],headers=h,json={'name':'改名考场'}).status_code==200
    paired_page(f,batch,'123')
    blank=post('scan-batches',{'group_id':f['group_id']},h);paired_page(f,blank,'124')
    query={'group_id':f['group_id'],'room_tag_id':tag['id']}
    rows=c.get('/api/v1/results',params=query,headers=h).json()
    assert len(rows)==1 and rows[0]['candidate_number']=='123' and {t['name'] for t in rows[0]['room_tags']}=={'一考场','二楼'}
    analysis=c.get('/api/v1/analysis/group',params=query,headers=h).json();assert analysis['summary']['records']==1
    exported=c.get('/api/v1/results/export',params=query,headers=h);assert '一考场' in exported.text and '124' not in exported.text
    assert '一考场' in c.get('/api/v1/exports/scans',params={'room_tag_id':tag['id']},headers=h).text
    with db.connect() as conn:exception=db.put(conn,'exceptions',{'group_id':f['group_id'],'batch_id':batch['id'],'kind':'recognition','reason':'核查','status':'resolved'})
    assert len(c.get('/api/v1/exceptions',params=query,headers=h).json())==1
    assert '一考场' in c.get('/api/v1/exports/exceptions',params={'room_tag_id':tag['id']},headers=h).text
    archive=post('projects/'+project+'/archive',None,h)
    data=c.get(archive['download_url'],headers=h) if archive.get('download_url') else c.get('/api/v1/archives/'+archive['id']+'/download',headers=h)
    with zipfile.ZipFile(io.BytesIO(data.content)) as zipped:
        records=json.loads(zipped.read('data.json'))['records'];assert any(r['kind']=='room-tags' for r in records)
    plan=post('projects/'+project+'/deletion-preview',None,h)
    assert next(row['count'] for row in plan['counts'] if row['kind']=='room-tags')==2
