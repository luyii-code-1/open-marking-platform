import io
import json
import zipfile
import pytest
from fastapi.testclient import TestClient
from server import db
from server.main import app
from server.conversion import convert,validate_conversion


def test_conversion_rounding_and_boundaries():
    config={'mode':'segments','segments':[{'min':0,'max':100,'target_min':40,'target_max':100}]}
    assert convert(0,config)==40
    assert convert(100,config)==100
    assert convert(33.33,config)==60
    assert convert(50,{'mode':'table','table':{'50':72.5}})==72.5
    with pytest.raises(ValueError): convert(51,{'mode':'table','table':{'50':72.5}})
    with pytest.raises(ValueError): validate_conversion({'segments':[]})
    with pytest.raises(ValueError): validate_conversion({'segments':[{'min':0,'max':10,'target_min':40,'target_max':50},{'min':9,'max':20,'target_min':50,'target_max':60}]})


def test_archive_scopes_project_and_backup_is_readable(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'long-admin-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        with db.connect() as connection:
            first=db.put(connection,'projects',{'name':'考试一'})
            other=db.put(connection,'projects',{'name':'考试二'})
            subject=db.put(connection,'subjects',{'project_id':first['id'],'name':'语文'})
            group=db.put(connection,'groups',{'subject_id':subject['id'],'name':'组'})
            batch=db.put(connection,'scan-batches',{'group_id':group['id']})
            page=db.put(connection,'pages',{'batch_id':batch['id']})
            directory=tmp_path/'pages'; directory.mkdir()
            (directory/(page['id']+'.image')).write_bytes(b'image evidence')
        response=client.post('/api/v1/projects/'+first['id']+'/archive',headers=headers)
        assert response.status_code==200,response.text
        archive=response.json()
        download=client.get(archive['download_url'],headers=headers)
        assert download.status_code==200
        with zipfile.ZipFile(io.BytesIO(download.content)) as package:
            data=json.loads(package.read('data.json'))
            ids={r['data']['id'] for r in data['records']}
            assert first['id'] in ids and page['id'] in ids and other['id'] not in ids
            assert package.read('pages/'+page['id']+'.image')==b'image evidence'
            assert {entry['path'] for entry in json.loads(package.read('manifest.json'))}=={'data.json','pages/'+page['id']+'.image'}
        backup=client.post('/api/v1/system/backup',headers=headers)
        assert backup.status_code==200
        import sqlite3
        with sqlite3.connect(tmp_path/'backups'/(backup.json()['id']+'.sqlite3')) as snapshot:
            assert snapshot.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
