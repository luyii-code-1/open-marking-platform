import hashlib
import io
import shutil
import sqlite3
import time
import json
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from uuid import uuid4
from PIL import Image
import pytest
from fastapi.testclient import TestClient
from server import db,backups,recovery,jobs
from server.main import app


def seed(client,root):
    account={'username':'admin','password':'administrator-password','name':'管理员'}
    client.post('/api/v1/auth/bootstrap',json=account)
    logged=client.post('/api/v1/auth/login',json=account).json();headers={'Authorization':'Bearer '+logged['token']}
    buffer=io.BytesIO();Image.new('RGB',(840,1188),'white').save(buffer,format='PNG');data=buffer.getvalue()
    (root/'pages').mkdir();(root/'assets').mkdir()
    with db.connect() as connection:
        project=db.put(connection,'projects',{'name':'考试'})
        subject=db.put(connection,'subjects',{'name':'语文','project_id':project['id']})
        group=db.put(connection,'groups',{'name':'组','subject_id':subject['id'],'frozen':True})
        q={'id':str(uuid4()),'number':1,'type':'subjective','points':10,'review_mode':'single','regions':[{'page':1,'x':15,'y':110,'width':160,'height':60}]}
        template=db.put(connection,'templates',{'name':'题卡','group_id':group['id'],'paper':'A4','sides':1,'revision':1,'status':'published','questions':[q]})
        group['template_id']=template['id'];db.put(connection,'groups',group)
        student=db.put(connection,'students',{'name':'学生','candidate_number':'001','class_id':'class'})
        batch=db.put(connection,'scan-batches',{'group_id':group['id'],'template_id':template['id'],'status':'paired'})
        page=db.put(connection,'pages',{'batch_id':batch['id'],'side':'front','sequence':1,'status':'recognized','candidate_number':'001','sha256':hashlib.sha256(data).hexdigest(),'normalized_sha256':hashlib.sha256(data).hexdigest()})
        submission=db.put(connection,'submissions',{'group_id':group['id'],'template_id':template['id'],'student_id':student['id'],'student_snapshot':student,'candidate_number':'001','pages':[page['id']],'status':'ready'})
        task=db.put(connection,'tasks',{'submission_id':submission['id'],'template_id':template['id'],'question_id':q['id'],'user_id':logged['user']['id'],'status':'completed','score_cents':800,'created_at':time.time()})
        connection.execute('INSERT INTO scores VALUES(?,?,?,?,?)',(str(uuid4()),task['id'],logged['user']['id'],800,'score-key'))
        connection.execute('INSERT INTO review_results VALUES(?,?,?)',(submission['id'],q['id'],800))
    for suffix in ('.image','.png'):(root/'pages'/(page['id']+suffix)).write_bytes(data)
    return account,headers,project,group,page,task


def test_restore_released_scans_grades_and_audit_with_runtime_reset(tmp_path,monkeypatch):
    source=tmp_path/'source';monkeypatch.setattr(db,'ROOT',source)
    with TestClient(app) as client:
        account,headers,project,group,page,task=seed(client,source)
        archived=client.post(f"/api/v1/projects/{project['id']}/archive",headers=headers);assert archived.status_code==200,archived.text
        archive=archived.json()
        ticket=client.post(f"/api/v1/archives/{archive['id']}/download-link",headers=headers).json()['url']
        codes=client.post('/api/v1/auth/recovery-codes',json={'password':account['password']},headers=headers).json()['codes']
        preview=client.post(f"/api/v1/projects/{project['id']}/release-preview",json={'archive_id':archive['id'],'mode':'local'},headers=headers).json()
        assert client.post(f"/api/v1/projects/{project['id']}/release",json={'plan_id':preview['id'],'confirm':True},headers=headers).status_code==200
        assert not (source/'pages'/(page['id']+'.image')).exists()
        with db.connect() as connection:
            pending=jobs.create_job(connection,'release-project',{'project_id':project['id']})
            device=db.put(connection,'scanner-devices',{'owner_id':client.get('/api/v1/auth/me',headers=headers).json()['id'],'revoked':False,'label':'设备','public_key':'public'})
            db.put(connection,'scanner-sessions',{'device_id':device['id'],'token_hash':'hash','expires_at':time.time()+900})
            plan=db.put(connection,'release-plans',{'project_id':project['id'],'status':'running','expires_at':time.time()+300,'lease_until':time.time()+300})
        created=client.post('/api/v1/system/backup',headers=headers);assert created.status_code==200,created.text
        backup=created.json();path=source/'backups'/(backup['id']+'.sqlite3');before=path.read_bytes()
        with closing(sqlite3.connect(path)) as snapshot:original_audit={r[0] for r in snapshot.execute('SELECT id FROM audit')}
        target=tmp_path/'recovered'
        report=recovery.restore(path,target,source,backup['sha256'],reason='验证恢复')
        assert path.read_bytes()==before and db.ROOT==source
        assert report['files']['from_archive']==2 and report['files']['verified']==3
        assert (target/'pages'/(page['id']+'.image')).read_bytes()==(target/'pages'/(page['id']+'.png')).read_bytes()
        with db.connect(target) as connection:
            assert connection.execute('SELECT score FROM scores').fetchone()[0]==800
            assert connection.execute('SELECT final_cents FROM review_results').fetchone()[0]==800
            assert connection.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]==0
            assert db.get(connection,pending['id'])['status']=='failed'
            assert db.get(connection,device['id'])['revoked'] is True
            assert db.get(connection,plan['id'])['expires_at']==0
            assert db.objects(connection,'recovery-events')[0]['source_sha256']==backup['sha256']
            assert original_audit <= {r[0] for r in connection.execute('SELECT id FROM audit')}
        assert client.get('/api/v1/auth/me',headers=headers).status_code==200
    monkeypatch.setattr(db,'ROOT',target)
    with TestClient(app) as client:
        assert client.get('/api/v1/auth/me',headers=headers).status_code==401
        assert client.get(ticket).status_code==403
        assert client.post('/api/v1/auth/recovery-login',json={'username':'admin','code':codes[0]}).status_code==401
        assert client.post('/api/v1/scanner/challenge',json={'device_id':device['id']}).status_code==403
        token=client.post('/api/v1/auth/login',json=account).json()['token'];fresh={'Authorization':'Bearer '+token}
        rows=client.get('/api/v1/results',params={'group_id':group['id']},headers=fresh).json()
        assert rows[0]['total']==8 and client.get(f"/api/v1/tasks/{task['id']}/image",headers=fresh).status_code==200
        jobs.execute(pending['id'])
        with db.connect() as connection:assert db.get(connection,pending['id'])['status']=='failed'


def test_restore_rejects_overwrite_mismatch_missing_files_and_wrong_database(tmp_path,monkeypatch):
    root=tmp_path/'source';monkeypatch.setattr(db,'ROOT',root)
    with TestClient(app) as client:
        account,headers,project,group,page,task=seed(client,root)
        record=client.post('/api/v1/system/backup',headers=headers).json();source=root/'backups'/(record['id']+'.sqlite3')
        existing=tmp_path/'existing';existing.mkdir();(existing/'keep').write_text('保留',encoding='utf-8')
        with pytest.raises(ValueError,match='不存在'):recovery.restore(source,existing,root)
        assert (existing/'keep').read_text(encoding='utf-8')=='保留'
        target=tmp_path/'new'
        with pytest.raises(ValueError,match='SHA-256'):recovery.restore(source,target,expected_sha256='0'*64)
        with pytest.raises(ValueError,match='缺少恢复文件'):recovery.restore(source,target)
        assert not target.exists()
        (root/'pages'/(page['id']+'.image')).write_bytes(b'changed')
        with pytest.raises(ValueError,match='版本不一致'):recovery.restore(source,target,root)
        assert not target.exists()
        report=recovery.restore(source,target,database_only=True)
        assert report['files']['scope']=='database-only' and not (target/'pages').exists()
        wrong=tmp_path/'wrong.sqlite3'
        with sqlite3.connect(wrong) as connection:connection.execute('CREATE TABLE unrelated(id)')
        with pytest.raises(ValueError,match='OMP'):recovery.restore(wrong,tmp_path/'invalid')


def test_backup_download_is_admin_only_and_checks_registered_digest(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account,headers,*_=seed(client,tmp_path)
        response=client.post('/api/v1/system/backup',headers=headers);record=response.json()
        downloaded=client.get(record['download_url'],headers=headers)
        assert downloaded.status_code==200 and downloaded.headers['cache-control']=='private, no-store'
        assert hashlib.sha256(downloaded.content).hexdigest()==record['sha256']
        assert client.get('/api/v1/system/backups',headers=headers).json()[0]['available'] is True
        teacher={'username':'teacher','password':'teacher-password','name':'教师'}
        client.post('/api/v1/users',json=teacher,headers=headers)
        token=client.post('/api/v1/auth/login',json=teacher).json()['token'];other={'Authorization':'Bearer '+token}
        assert client.get(record['download_url'],headers=other).status_code==403
        assert client.get('/api/v1/system/backups',headers=other).status_code==403
        with (tmp_path/'backups'/(record['id']+'.sqlite3')).open('ab') as output:output.write(b'changed')
        assert client.get(record['download_url'],headers=headers).status_code==409


def test_recovery_module_cli_restores_to_new_directory(tmp_path,monkeypatch):
    root=tmp_path/'source';monkeypatch.setattr(db,'ROOT',root)
    with TestClient(app) as client:
        account,headers,*_=seed(client,root)
        record=client.post('/api/v1/system/backup',headers=headers).json()
    source=root/'backups'/(record['id']+'.sqlite3');target=tmp_path/'cli-recovery'
    process=subprocess.run([sys.executable,'-X','utf8','-m','server.recovery',str(source),'--target',str(target),'--database-only','--sha256',record['sha256']],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,encoding='utf-8',timeout=20,creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess,'CREATE_NO_WINDOW') else 0)
    assert process.returncode==0,process.stderr
    report=json.loads(process.stdout)
    assert report['source_sha256']==record['sha256'] and report['files']['scope']=='database-only'
    assert (target/'recovery-report.json').is_file() and backups.inspect(target/'omp.sqlite3')['scores']==1
