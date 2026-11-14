from server.scoring import objective_score,final_score


def test_scoring_boundaries():
    assert objective_score(['A'],['A'],3)==300
    assert objective_score(['A','B'],['A'],3)==0
    assert objective_score(['A'],['A','B'],4,{'mode':'partial','partial_points':2})==200
    assert objective_score(['A','C'],['A','B'],4,{'mode':'per_option','correct_points':1,'wrong_penalty':2})==0
    assert final_score([1000,1200],'double',2)==1100
    assert final_score([1000,1201],'double',2) is None
    assert final_score([1000,1300,1250],'double',2)==1250


def test_auth_and_persistence(tmp_path,monkeypatch):
    from server import db
    from server.main import app
    from fastapi.testclient import TestClient
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        assert client.get('/api/v1/projects').status_code==401
        account={'username':'admin','password':'test-password-123','name':'管理员'}
        assert client.get('/api/v1/auth/bootstrap-status').json()=={'available':True}
        assert client.post('/api/v1/auth/bootstrap',json=account).status_code==200
        assert client.get('/api/v1/auth/bootstrap-status').json()=={'available':False}
        assert client.post('/api/v1/auth/bootstrap',json=account).status_code==409
        token=client.post('/api/v1/auth/login',json=account).json()['token']
        headers={'Authorization':'Bearer '+token}
        project=client.post('/api/v1/projects',json={'name':'考试'},headers=headers).json()
        assert client.get('/api/v1/projects',headers=headers).json()[0]['id']==project['id']
        assert client.post('/api/v1/subjects',json={'project_id':'missing','name':'数学'},headers=headers).status_code==404
        teacher={'username':'teacher','password':'teacher-password-123','name':'教师','role':'teacher'}
        assert client.post('/api/v1/users',json=teacher,headers=headers).status_code==200
        teacher_token=client.post('/api/v1/auth/login',json=teacher).json()['token']
        assert client.get('/api/v1/users',headers={'Authorization':'Bearer '+teacher_token}).status_code==403
