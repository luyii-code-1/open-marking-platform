import time
import pytest
from fastapi.testclient import TestClient
from server import db
from server.browser_sessions import digest,SESSION_SECONDS
from server.main import app
from server.realtime import authenticate


@pytest.fixture
def browser(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    with TestClient(app) as client:
        account={'username':'admin','password':'administrator-password','name':'管理员'}
        assert client.post('/api/v1/auth/bootstrap',json=account).status_code==200
        def login(portal='admin'):
            response=client.post('/api/v1/auth/login',json={**account,'portal':portal});assert response.status_code==200
            value=response.json();assert value['expires_at']-value['server_time']==SESSION_SECONDS
            return value,{'Authorization':'Bearer '+value['token']}
        def expiry(token,value=None):
            with db.connect() as connection:
                if value is not None:connection.execute('UPDATE sessions SET expires=? WHERE token=?',(value,digest(token)))
                row=connection.execute('SELECT expires FROM sessions WHERE token=?',(digest(token),)).fetchone()
                return row[0] if row else None
        yield client,account,login,expiry


def test_queries_and_websocket_authentication_do_not_renew(browser):
    client,_,login,expiry=browser;session,headers=login();expires=time.time()+60;expiry(session['token'],expires)
    for path in ('auth/me','auth/session','dashboard','projects'):
        assert client.get('/api/v1/'+path,headers=headers).status_code==200
    assert authenticate(session['token']) is not None
    assert expiry(session['token'])==expires
    response=client.post('/api/v1/auth/activity',json={'idle_ms':2000},headers=headers)
    assert response.status_code==200
    result=response.json()
    assert result['expires_at']==pytest.approx(result['server_time']+SESSION_SECONDS-2)
    assert expiry(session['token'])==result['expires_at']


def test_only_current_browser_lease_is_renewed_and_revocation_is_final(browser):
    client,_,login,expiry=browser;first,a=login('admin');second,b=login('marking')
    first_end=second_end=time.time()+60
    expiry(first['token'],first_end);expiry(second['token'],second_end)
    assert client.post('/api/v1/auth/activity',json={},headers=a).status_code==200
    assert expiry(first['token'])>first_end and expiry(second['token'])==second_end
    assert client.post('/api/v1/auth/logout',headers=a).status_code==200
    assert client.post('/api/v1/auth/activity',json={},headers=a).status_code==401
    assert expiry(first['token']) is None
    assert client.get('/api/v1/auth/session',headers=b).status_code==200


def test_expired_sessions_cannot_be_revived_by_activity(browser):
    client,_,login,expiry=browser;value,headers=login();ended=time.time()-1;expiry(value['token'],ended)
    assert client.post('/api/v1/auth/activity',json={},headers=headers).status_code==401
    assert client.get('/api/v1/auth/session',headers=headers).status_code==401
    assert expiry(value['token'])==ended
    assert client.post('/api/v1/auth/activity',json={}).status_code==401


def test_activity_does_not_recreate_password_revoked_session(browser):
    client,account,login,expiry=browser;value,headers=login()
    assert client.post('/api/v1/auth/activity',json={'idle_ms':-1},headers=headers).status_code==422
    assert client.post('/api/v1/auth/password',json={'password':account['password'],'new_password':'replacement-password'},headers=headers).status_code==200
    assert client.post('/api/v1/auth/activity',json={},headers=headers).status_code==401
    assert expiry(value['token']) is None
