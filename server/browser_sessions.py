"""Browser sessions use a twelve-hour lease renewed only by explicit activity."""
import hashlib
import json
import secrets
import time
from uuid import uuid4

SESSION_SECONDS=12*60*60
SINGLE_SESSION_ROLES=('teacher','manager')
KICK_MESSAGES={
    'replaced':'您的账号已在其他设备登录，当前登录已下线',
    'force_logout':'您的账号已被管理员强制下线，请重新登录',
}


def digest(token):return hashlib.sha256(token.encode()).hexdigest()


def record_revoked(db,tokens,reason,now=None):
    if not tokens:return
    now=time.time() if now is None else now
    rows=db.execute("SELECT id,body FROM objects WHERE kind='session-revocations' AND deleted=0 ORDER BY rowid LIMIT 100").fetchall()
    expired_ids=[row['id'] for row in rows if json.loads(row['body']).get('expires_at',0)<now]
    if expired_ids:
        db.execute('DELETE FROM objects WHERE id IN ('+','.join('?' for _ in expired_ids)+')',expired_ids)
    for token_hash,old_expires in tokens:
        body=json.dumps({'token_hash':token_hash,'reason':reason,'expires_at':max(float(old_expires or 0),now+3600)},ensure_ascii=False)
        db.execute("INSERT INTO objects(id,kind,body) VALUES(?,?,?)",(str(uuid4()),'session-revocations',body))


def revoke_user_sessions(db,user_id,reason,keep_token=None):
    now=time.time()
    rows=db.execute('SELECT token,expires FROM sessions WHERE user_id=? AND expires>?',(user_id,now)).fetchall()
    revoked=[(row['token'],row['expires']) for row in rows if row['token']!=keep_token]
    if keep_token is None:
        db.execute('DELETE FROM sessions WHERE user_id=?',(user_id,))
    else:
        db.execute('DELETE FROM sessions WHERE user_id=? AND token<>?',(user_id,keep_token))
    record_revoked(db,revoked,reason,now)
    return len(revoked)


def enforce_single_session_role(db,user_id,role):
    if role not in SINGLE_SESSION_ROLES:return 0
    now=time.time()
    newest=db.execute('SELECT token FROM sessions WHERE user_id=? AND expires>? ORDER BY expires DESC LIMIT 1',(user_id,now)).fetchone()
    if newest is None:return 0
    return revoke_user_sessions(db,user_id,'replaced',keep_token=newest['token'])


def lookup_revoked(db,token_digest):
    now=time.time()
    rows=db.execute("SELECT body FROM objects WHERE kind='session-revocations' AND deleted=0 AND json_extract(body,'$.token_hash')=? ORDER BY rowid DESC",(token_digest,)).fetchall()
    for row in rows:
        item=json.loads(row['body'])
        if item.get('expires_at',0)>now:
            reason=item.get('reason','replaced')
            return reason,KICK_MESSAGES.get(reason,KICK_MESSAGES['replaced'])
    return None


def issue(db,person):
    now=time.time();expires=now+SESSION_SECONDS;token=secrets.token_urlsafe(40)
    if person.get('role') in SINGLE_SESSION_ROLES:
        revoke_user_sessions(db,person['id'],'replaced')
    db.execute('INSERT INTO sessions VALUES(?,?,?)',(digest(token),person['id'],expires))
    return {'token':token,'expires_at':expires,'server_time':now,'user':{k:person[k] for k in ('id','username','name','role')}}
