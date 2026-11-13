"""Browser sessions use a twelve-hour lease renewed only by explicit activity."""
import hashlib
import secrets
import time

SESSION_SECONDS=12*60*60


def digest(token):return hashlib.sha256(token.encode()).hexdigest()


def issue(db,person):
    now=time.time();expires=now+SESSION_SECONDS;token=secrets.token_urlsafe(40)
    db.execute('INSERT INTO sessions VALUES(?,?,?)',(digest(token),person['id'],expires))
    return {'token':token,'expires_at':expires,'server_time':now,'user':{k:person[k] for k in ('id','username','name','role')}}
