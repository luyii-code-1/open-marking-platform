"""Resolve staffing sheet identities before applying the class assignments."""
from collections import defaultdict
import secrets
from uuid import uuid4
from fastapi import HTTPException
from .db import put
from .dependencies import password_hash


def resolve_accounts(db, entries, choices, commit, actor):
    by_name = defaultdict(list)
    for row in db.execute('SELECT id, username, name, role FROM users'):
        account = dict(row)
        by_name[''.join(row['name'].split())].append(account)

    occurrences = defaultdict(list)
    for cell, name, description in entries:
        occurrences[''.join(name.split())].append((cell, description))
    resolved, pending, created, planned = {}, [], [], []
    for name, places in occurrences.items():
        matches = by_name[name]
        ambiguous = len(places)>1 or len(matches)>1 or any(m['role']!='teacher' for m in matches)
        available = {m['id'] for m in matches if m['role']=='teacher'}
        new_ids = {}
        for cell, description in places:
            if ambiguous:
                decision = choices.get(cell)
                if not decision:
                    pending.append({'cell':cell,'name':name,'description':description,
                                    'accounts':[{'id':m['id'],'username':m['username']} for m in matches if m['role']=='teacher']})
                    continue
            else:
                decision = matches[0]['id'] if matches else 'new'
            if decision in available:
                resolved[cell] = decision
                continue
            if decision not in ('new','separate'):
                raise HTTPException(422,'教师匹配选项已变更，请重新预览')
            key = cell if decision=='separate' else name
            if key not in new_ids:
                uid = str(uuid4()) if commit else 'new:'+key
                planned.append({'name':name,'id':uid})
                if commit:
                    username=name
                    suffix=2
                    while db.execute('SELECT 1 FROM users WHERE username=?',(username,)).fetchone():
                        username=f'{name}{suffix}'
                        suffix+=1
                    password=secrets.token_urlsafe(15)
                    db.execute('INSERT INTO users VALUES(?,?,?,?,?)',(uid,username,name,'teacher',password_hash(password)))
                    put(db,'account-events',{'user_id':uid,'action':'created','username':username,'name':name,'role':'teacher'},actor)
                    created.append({'name':name,'username':username,'password':password})
                new_ids[key]=uid
            resolved[cell]=new_ids[key]
    return resolved,pending,created,planned
