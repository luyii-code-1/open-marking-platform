import json
import sqlite3
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from server import db
from server.main import app
from server.identifiers import IdentifierConflict


def test_question_ids_global_retired_and_transactional_through_api(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        login=client.post('/api/v1/auth/login',json=account).json()
        headers={'Authorization':'Bearer '+login['token']}
        with db.connect() as connection:
            project=db.put(connection,'projects',{'name':'考试'})
            subject=db.put(connection,'subjects',{'name':'语文','project_id':project['id']})
            group=db.put(connection,'groups',{'name':'组','subject_id':subject['id']})
        question={'id':str(uuid4()),'number':1,'type':'subjective','points':10,'regions':[]}
        body={'name':'草稿','group_id':group['id'],'paper':'A4','sides':1,'questions':[question]}
        def create(value):return client.post('/api/v1/templates',json=value,headers=headers)
        saved=create(body);assert saved.status_code==200,saved.text
        tid=saved.json()['id'];url='/api/v1/templates/'+tid
        assert create(body).status_code==409
        assert create({**body,'questions':[{**question,'id':login['user']['id']}]}).status_code==409
        assert create({**body,'questions':[{**question,'id':project['id']}]}).status_code==409
        assert create({**body,'questions':[question,question]}).status_code==409
        assert create({**body,'questions':[None]}).status_code==422
        assert create({**body,'questions':[{**question,'id':'invalid'}]}).status_code==422
        assert client.put(url,json={'questions':[question],'name':'编辑原题'},headers=headers).status_code==200
        unused=str(uuid4())
        failed=client.put(url,json={'questions':[{**question,'id':unused},{**question,'id':project['id']}]},headers=headers)
        assert failed.status_code==409
        with db.connect() as connection:
            assert not connection.execute('SELECT 1 FROM identifiers WHERE id=?',(unused,)).fetchone()
            assert db.get(connection,tid)['questions']==[question]
        copied=create({**body,'name':'副本','questions':[{**question,'id':str(uuid4())}]})
        assert copied.status_code==200
        assert client.put(url,json={'questions':[]},headers=headers).status_code==200
        assert client.put(url,json={'questions':[question]},headers=headers).status_code==409
        assert create(body).status_code==409
    # A restart cannot make a removed question available again.
    db.initialize()
    with db.connect() as connection:
        row=connection.execute('SELECT retired FROM identifiers WHERE id=?',(question['id'],)).fetchone()
        assert row['retired']==1


def test_user_object_delete_tombstones_and_direct_sql_collision(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);db.initialize()
    with db.connect() as connection:
        for invalid in (None,'invalid',str(uuid4()).upper()):
            with pytest.raises(sqlite3.IntegrityError):connection.execute('INSERT INTO users VALUES(?,?,?,?,?)',(invalid,'bad','name','teacher','hash'))
        obj=db.put(connection,'groups',{'name':'组'})
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute('INSERT INTO users VALUES(?,?,?,?,?)',(obj['id'],'user','name','teacher','hash'))
        connection.execute('UPDATE objects SET deleted=1 WHERE id=?',(obj['id'],))
    with db.connect() as connection:
        with pytest.raises(IdentifierConflict):db.put(connection,'groups',obj)
    with db.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError):connection.execute('UPDATE objects SET deleted=0 WHERE id=?',(obj['id'],))
        identifier=str(uuid4())
        connection.execute('INSERT INTO users VALUES(?,?,?,?,?)',(identifier,'user','name','teacher','hash'))
        connection.execute('DELETE FROM users WHERE id=?',(identifier,))
    with db.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError):connection.execute('INSERT INTO users VALUES(?,?,?,?,?)',(identifier,'new','name','teacher','hash'))
    with db.connect() as connection:
        connection.execute('DELETE FROM objects WHERE id=?',(obj['id'],))
    with db.connect() as connection:
        with pytest.raises(IdentifierConflict):db.put(connection,'projects',{'id':obj['id']})


def test_migration_reserves_removed_questions_from_template_history(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path);db.initialize()
    removed=str(uuid4());active=str(uuid4())
    with db.connect() as connection:
        template=db.put(connection,'templates',{'questions':[{'id':removed},{'id':active}]})
        template['questions']=[{'id':active}];db.put(connection,'templates',template)
        # Reconstruct an earlier schema with template history but no identifier registry.
        connection.execute('DELETE FROM identifiers')
        connection.execute("DELETE FROM schema_migrations WHERE name='identifiers-v1'")
    db.initialize();db.initialize()
    with db.connect() as connection:
        rows={r['id']:r['retired'] for r in connection.execute("SELECT * FROM identifiers WHERE kind='questions'")}
        assert rows=={removed:1,active:0}
        with pytest.raises(IdentifierConflict):db.put(connection,'groups',{'id':removed,'name':'不可复用'})


def test_account_events_record_actor_without_password_or_token(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        client.post('/api/v1/auth/bootstrap',json=account)
        login=client.post('/api/v1/auth/login',json=account).json()
        headers={'Authorization':'Bearer '+login['token']}
        user=client.post('/api/v1/users',json={'username':'teacher','password':'teacher-password','name':'教师'},headers=headers).json()
        assert client.post('/api/v1/auth/logout',headers=headers).status_code==200
        with db.connect() as connection:
            events=db.objects(connection,'account-events')
            assert {e['action'] for e in events}=={'bootstrap','login','created','logout'}
            created=next(e for e in events if e['action']=='created')
            audit=connection.execute('SELECT actor,body FROM audit WHERE object_id=?',(created['id'],)).fetchone()
            assert audit['actor']==login['user']['id'] and created['user_id']==user['id']
            serialized=json.dumps([dict(r) for r in connection.execute('SELECT * FROM audit')])
            for secret in (account['password'],'teacher-password',login['token']):assert secret not in serialized
