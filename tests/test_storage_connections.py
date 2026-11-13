import hashlib
import io
import json
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from server import db, storage
from server.main import app
from server.storage_connections import probe, config
from tests.test_archive_release import seed


def connection(bucket='exam-bucket'):
    return {'name':bucket,'kind':'ros','endpoint':'https://s3.example.test','bucket':bucket,'prefix':'omp','region':'us-east-1','addressing':'path','access_key':'TEST-ACCESS','secret_key':'test-secret-never-return','media_url':'https://media.example.test','media_enabled':False}


@pytest.fixture
def configured(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    remote={};deleted=[]
    class S3:
        def upload_file(self,source,bucket,key):remote[(bucket,key)]=Path(source).read_bytes()
        def download_file(self,bucket,key,target):Path(target).write_bytes(remote[(bucket,key)])
        def put_object(self,Bucket,Key,Body,**kwargs):remote[(Bucket,Key)]=Body
        def get_object(self,Bucket,Key):return {'Body':io.BytesIO(remote[(Bucket,Key)])}
        def delete_object(self,Bucket,Key):deleted.append((Bucket,Key));remote.pop((Bucket,Key),None)
    monkeypatch.setattr(storage.Storage,'s3',lambda self:S3())
    with TestClient(app) as client:
        headers,project,page,task,template,asset,content=seed(client,tmp_path)
        yield client,headers,project,page,task,template,content,remote,deleted


def add(client,headers,value):
    response=client.post('/api/v1/storage-connections',headers=headers,json=value)
    assert response.status_code==201,response.text
    return response.json()


def test_admin_connection_credentials_rotation_and_probe(configured,tmp_path):
    client,headers,project,*_=configured
    value=connection();saved=add(client,headers,value)
    assert not saved['media_enabled'] and saved['credentials_saved']
    assert 'access_key' not in saved and 'secret_key' not in saved and 'credentials' not in saved
    assert client.get('/api/v1/storage-connections').status_code==401
    credentials={'username':'teacher','password':'teacher-long-password','name':'教师'}
    client.post('/api/v1/users',json=credentials,headers=headers)
    teacher={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=credentials).json()['token']}
    assert client.get('/api/v1/storage-connections',headers=teacher).status_code==403
    assert client.post('/api/v1/storage-connections/test',headers=teacher,json=value).status_code==403
    updated=client.put('/api/v1/storage-connections/'+saved['id'],headers=headers,json={**value,'access_key':'','secret_key':''})
    assert updated.status_code==200 and config(saved['id'])['secret_key']==value['secret_key']
    result=client.post('/api/v1/storage-connections/'+saved['id']+'/test',headers=headers,json={}).json()
    assert result['object_io']=='passed' and result['test_object_deleted']
    with db.connect() as c:
        assert value['secret_key'] not in json.dumps([dict(row) for row in c.execute('SELECT * FROM objects')])
        assert value['secret_key'] not in json.dumps([dict(row) for row in c.execute('SELECT * FROM audit')])
    backup=client.post('/api/v1/system/backup',headers=headers).json()
    data=client.get(backup['download_url'],headers=headers).content
    assert value['secret_key'].encode() not in data and value['access_key'].encode() not in data


def test_project_switch_preserves_original_remote_and_release_all_copies(configured):
    client,headers,project,page,task,template,content,remote,deleted=configured
    first=add(client,headers,connection('first-bucket'));second=add(client,headers,connection('second-bucket'))
    path='pages/'+page['id']+'.image'
    for saved in (first,second):
        assert client.put(f"/api/v1/projects/{project['id']}/storage",headers=headers,json={'connection_id':saved['id']}).status_code==200
        storage.mirror(path,project['id'])
    with db.connect() as c:refs=db.find(c,'storage-assets',relative=path)
    assert {r['connection_id'] for r in refs}=={first['id'],second['id']}
    assert client.delete('/api/v1/storage-connections/'+first['id'],headers=headers).status_code==409
    changed=client.put('/api/v1/storage-connections/'+first['id'],headers=headers,json={**connection('changed-bucket')})
    assert changed.status_code==409
    storage.local_path(path).unlink()
    assert storage.materialize(path).read_bytes()==content
    archive=client.post(f"/api/v1/projects/{project['id']}/archive",headers=headers).json()
    preview=client.post(f"/api/v1/projects/{project['id']}/release-preview",headers=headers,json={'archive_id':archive['id'],'mode':'all'})
    assert preview.status_code==200,preview.text
    assert len(preview.json()['files'][0]['remote_ids'])==2
    result=client.post(f"/api/v1/projects/{project['id']}/release",headers=headers,json={'plan_id':preview.json()['id'],'confirm':True})
    assert result.status_code==200 and result.json()['status']=='completed',result.text
    assert {bucket for bucket,key in deleted}=={'first-bucket','second-bucket'} and not remote


def test_media_ignored_or_failed_falls_back_to_authenticated_server_crop(configured,monkeypatch):
    client,headers,project,page,task,template,content,remote,deleted=configured
    value=connection();value['media_enabled']=True;saved=add(client,headers,value)
    client.put(f"/api/v1/projects/{project['id']}/storage",headers=headers,json={'connection_id':saved['id']})
    relative='pages/'+page['id']+'.png'
    with db.connect() as c:
        row=db.get(c,page['id']);row['normalized_sha256']=hashlib.sha256(content).hexdigest();db.put(c,'pages',row)
    storage.mirror(relative,project['id'])
    called=[]
    def failure(self,key,rect,force=False):called.append(rect);raise ValueError('Media not ready')
    monkeypatch.setattr(storage.Storage,'fetch_crop',failure)
    storage.local_path(relative).unlink()
    response=client.get(f"/api/v1/tasks/{task['id']}/image",headers=headers)
    assert response.status_code==200 and response.headers['cache-control']=='private, no-store'
    with Image.open(io.BytesIO(response.content)) as im:assert im.size==(400,120)
    assert called==[(40,440,400,120)]
    assert client.get(f"/api/v1/tasks/{task['id']}/image").status_code==401
    with db.connect() as c:row=db.get(c,saved['id']);row['media_enabled']=False;db.put(c,'storage-connections',row)
    called.clear();assert client.get(f"/api/v1/tasks/{task['id']}/image",headers=headers).status_code==200 and not called


def test_media_probe_detects_full_image_and_cleans_only_test_object(configured,monkeypatch):
    *_,remote,deleted=configured
    remote[('exam-bucket','existing.png')]=b'existing'
    def ignored(self,key,rect,force=False):return remote[(self.bucket,self.key(key))]
    monkeypatch.setattr(storage.Storage,'fetch_crop',ignored)
    result=probe(connection(),True)
    assert result['object_io']=='passed' and result['media']=='unavailable' and result['test_object_deleted']
    assert remote=={('exam-bucket','existing.png'):b'existing'}


def test_media_success_is_forwarded_without_exposing_original(configured,monkeypatch):
    client,headers,project,page,task,template,content,*_=configured
    value=connection();value['media_enabled']=True;saved=add(client,headers,value)
    client.put(f"/api/v1/projects/{project['id']}/storage",headers=headers,json={'connection_id':saved['id']})
    relative='pages/'+page['id']+'.png'
    with db.connect() as c:
        row=db.get(c,page['id']);row['normalized_sha256']=hashlib.sha256(content).hexdigest();db.put(c,'pages',row)
    storage.mirror(relative,project['id']);storage.local_path(relative).unlink()
    def cropped(self,key,rect,force=False):
        buf=io.BytesIO();Image.new('RGB',rect[2:],'red').save(buf,'PNG');return buf.getvalue()
    monkeypatch.setattr(storage.Storage,'fetch_crop',cropped)
    monkeypatch.setattr(storage,'materialize',lambda *args:pytest.fail('Full page must not be retrieved on media success'))
    response=client.get(f"/api/v1/tasks/{task['id']}/image",headers=headers)
    assert response.status_code==200 and 'location' not in response.headers
    with Image.open(io.BytesIO(response.content)) as im:assert im.size==(400,120) and im.getpixel((0,0))[0]>240


def test_signed_media_request_binds_rect_and_rejects_ignored_transform(tmp_path,monkeypatch):
    import httpx
    from types import SimpleNamespace
    from botocore.credentials import Credentials
    from urllib.parse import parse_qs
    provider=storage.Storage(settings={**connection(),'media_enabled':True})
    monkeypatch.setattr(provider,'s3',lambda:SimpleNamespace(_request_signer=SimpleNamespace(_credentials=Credentials('fake-access','fake-secret'))))
    sizes=[(80,60),(30,20)];requests=[]
    def respond(request):
        requests.append(request);buf=io.BytesIO();Image.new('RGB',sizes.pop(0),'red').save(buf,'PNG')
        return httpx.Response(200,content=buf.getvalue(),headers={'content-type':'image/png'})
    real_client=httpx.Client
    monkeypatch.setattr(httpx,'Client',lambda **kwargs:real_client(transport=httpx.MockTransport(respond),**kwargs))
    with pytest.raises(ValueError,match='未生效'):provider.fetch_crop('page.png',(10,20,30,20))
    result=provider.fetch_crop('page.png',(10,20,30,20))
    with Image.open(io.BytesIO(result)) as image:assert image.size==(30,20)
    query=parse_qs(requests[0].url.query.decode())
    assert query['rect']==['10,20,30,20'] and query['fmt']==['png'] and 'X-Amz-Signature' in query


def test_media_local_priority_failure_cooldown_and_config_refresh(configured,monkeypatch):
    client,headers,project,page,task,template,content,*_=configured
    value=connection();value['media_enabled']=True;saved=add(client,headers,value)
    client.put(f"/api/v1/projects/{project['id']}/storage",headers=headers,json={'connection_id':saved['id']})
    relative='pages/'+page['id']+'.png'
    with db.connect() as c:
        row=db.get(c,page['id']);row['normalized_sha256']=hashlib.sha256(content).hexdigest();db.put(c,'pages',row)
    storage.mirror(relative,project['id'])
    called=[]
    def failure(self,*args,**kwargs):called.append(1);raise ValueError('Media failed')
    monkeypatch.setattr(storage.Storage,'fetch_crop',failure)
    region=template['questions'][0]['regions'][0]
    assert storage.remote_piece(relative,region) is None and not called
    storage.local_path(relative).unlink()
    clock=[100.0];monkeypatch.setattr(storage.time,'monotonic',lambda:clock[0])
    assert storage.remote_piece(relative,region) is None and len(called)==1
    assert storage.remote_piece(relative,region) is None and len(called)==1
    with db.connect() as c:
        row=db.get(c,saved['id']);row['revision']+=1;db.put(c,'storage-connections',row)
    assert storage.remote_piece(relative,region) is None and len(called)==2
    clock[0]+=61
    assert storage.remote_piece(relative,region) is None and len(called)==3
    # The authenticated endpoint still recovers the original and returns a usable crop.
    response=client.get(f"/api/v1/tasks/{task['id']}/image",headers=headers)
    assert response.status_code==200 and len(called)==3
    with Image.open(io.BytesIO(response.content)) as image:assert image.size==(400,120)
