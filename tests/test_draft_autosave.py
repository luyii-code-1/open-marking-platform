from uuid import uuid4
from fastapi.testclient import TestClient
from server import db
from server.main import app
from test_templates import setup,definition

def test_draft_autosave_retry_conflict_and_publication(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        headers=setup(client)
        with db.connect() as connection:group=db.put(connection,'groups',{'name':'题卡'})
        identifier=str(uuid4());url=f"/api/v1/groups/{group['id']}/drafts/{identifier}"
        body={'value':definition(group['id']),'request_id':str(uuid4()),'base_version':0}
        assert client.put(url,json=body).status_code==401
        saved=client.put(url,json=body,headers=headers)
        assert saved.status_code==200,saved.text
        assert saved.json()['draft_version']==1
        assert client.put(url,json=body,headers=headers).json()==saved.json()
        conflict={**body,'request_id':str(uuid4())}
        assert client.put(url,json=conflict,headers=headers).status_code==409
        updated=client.put(url,json={**conflict,'base_version':1},headers=headers)
        assert updated.status_code==200,updated.text
        assert updated.json()['draft_version']==2
        assert client.put('/api/v1/templates/'+identifier,json=saved.json(),headers=headers).status_code==409
        published=client.post(f'/api/v1/templates/{identifier}/publish',headers=headers)
        assert published.status_code==200,published.text
        assert client.put(url,json={**body,'base_version':2,'request_id':str(uuid4())},headers=headers).status_code==409
