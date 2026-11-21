import hashlib
from PIL import Image
import io
from server import db,storage
from tests.test_storage_connections import configured,connection,add


def test_full_sheet_manifest_proxy_permissions_and_versions(configured,monkeypatch):
    client,headers,project,page,task,template,asset_content,*_=configured
    url=f"/api/v1/tasks/{task['id']}"
    response=client.get(url+'/image-manifest',headers=headers)
    assert response.status_code==200,response.text
    manifest=response.json()
    assert manifest['regions']==[{'page':0,'rect':[40,440,400,120]}]
    source=manifest['pages'][0]
    assert 'direct_url' not in source
    fetched=client.get('/api/v1'+source['proxy_url'],headers=headers)
    assert fetched.status_code==200 and fetched.content==asset_content
    with Image.open(io.BytesIO(fetched.content)) as image:assert image.size==(840,1188)
    assert client.get(url+'/image-manifest').status_code==401
    assert client.get('/api/v1'+source['proxy_url']).status_code==401
    assert client.get(url+'/image-source/0?version=stale',headers=headers).status_code==409
    assert client.get(url+'/image-source/7',headers=headers).status_code==404
    client.post('/api/v1/users',headers=headers,json={'username':'outsider','name':'其他教师','password':'long-password-123','role':'teacher'})
    login=client.post('/api/v1/auth/login',json={'username':'outsider','password':'long-password-123'}).json()
    other={'Authorization':'Bearer '+login['token']}
    assert client.get(url+'/image-manifest',headers=other).status_code==403
    assert client.get('/api/v1'+source['proxy_url'],headers=other).status_code==403


def test_sign_original_connection_and_project_proxy_choice(configured,monkeypatch):
    client,headers,project,page,task,template,content,*_=configured
    first=add(client,headers,connection('first'));second=add(client,headers,connection('second'))
    with db.connect() as c:
        row=db.get(c,page['id']);row['normalized_sha256']=hashlib.sha256(content).hexdigest();db.put(c,'pages',row)
    client.put(f"/api/v1/projects/{project['id']}/storage",headers=headers,json={'connection_id':first['id']})
    storage.mirror('pages/'+page['id']+'.png',project['id'])
    client.put(f"/api/v1/projects/{project['id']}/storage",headers=headers,json={'connection_id':second['id'],'review_image_delivery':'direct'})
    signed=[]
    def sign(self,key,expires=120):signed.append((self.bucket,key,expires));return 'https://signed.example.test/object?token=temporary'
    monkeypatch.setattr(storage.Storage,'signed_url',sign)
    path=f"/api/v1/tasks/{task['id']}/image-manifest"
    manifest=client.get(path,headers=headers).json()
    assert manifest['pages'][0]['direct_url'].startswith('https://signed.') and signed[0][0]=='first' and signed[0][2]==120
    client.put(f"/api/v1/projects/{project['id']}/storage",headers=headers,json={'connection_id':second['id'],'review_image_delivery':'proxy'})
    assert 'direct_url' not in client.get(path,headers=headers).json()['pages'][0]
    assert len(signed)==1
    assert client.put(f"/api/v1/projects/{project['id']}/storage",headers=headers,json={'review_image_delivery':'wrong'}).status_code==422


def test_multiple_regions_reuse_page_and_asset_override(configured):
    client,headers,project,page,task,template,content,*_=configured
    with db.connect() as c:
        row=db.get(c,task['submission_id']);row['region_overrides']={task['question_id']:{'regions':[{'page':1,'x':10,'y':110,'width':100,'height':30},{'page':1,'x':10,'y':150,'width':100,'height':20}]}};db.put(c,'submissions',row)
    url=f"/api/v1/tasks/{task['id']}/image-manifest"
    manifest=client.get(url,headers=headers).json()
    assert len(manifest['pages'])==1 and len(manifest['regions'])==2
    with db.connect() as c:
        asset=db.objects(c,'assets')[0];row=db.get(c,task['submission_id']);row['region_overrides']={task['question_id']:{'asset_id':asset['id']}};db.put(c,'submissions',row)
    manifest=client.get(url,headers=headers).json()
    assert manifest['regions']==[{'page':0,'rect':None}]
    assert client.get('/api/v1'+manifest['pages'][0]['proxy_url'],headers=headers).content==content


def test_three_column_essay_and_manual_back_frame(configured):
    from uuid import uuid4
    from server.template_checks import issues

    client,headers,project,front,task,template,*_=configured
    question=template['questions'][0]
    def area(page,x,y,w,h):
        return dict(page=page,x=x,y=y,width=w,height=h)
    columns=[area(2,12+i*134,42,120,190) for i in range(3)]
    front_answer=area(1,12,120,120,24)
    question.update(review_layout='paper',regions=[front_answer,*columns])
    template.update(paper='A3',sides=2)
    # The other item sits between the first and second columns.
    template['questions'].append(dict(id=str(uuid4()),number=2,type='subjective',points=5,regions=[area(2,134,80,8,20)]))
    with db.connect() as c:
        db.put(c,'templates',template)
        back=db.put(c,'pages',{**front,'id':str(uuid4()),'side':'back'})
        sub=db.get(c,task['submission_id'])
        db.put(c,'submissions',{**sub,'pages':[front['id'],back['id']]})
    back_image=Image.new('RGB',(1680,1188),'white')
    for column in columns:
        left=column['x']*4
        back_image.paste('black',(left+10,200,left+30,220))
    back_image.paste('black',(536,320,568,400))
    back_image.save(db.ROOT/'pages'/(back['id']+'.png'))
    path=f"/api/v1/tasks/{task['id']}/image-manifest"
    def manifest():
        response=client.get(path,headers=headers)
        assert response.status_code==200,response.text
        return response.json()['regions']
    auto=manifest()
    assert auto==[{'page':0,'rect':[48,480,480,96]},
                  {'page':1,'rect':[48,168,1552,760],'masks':[[536,320,32,80]]}]
    response=client.get(path.replace('/image-manifest','/image'),headers=headers)
    assert response.status_code==200
    with Image.open(io.BytesIO(response.content)) as rendered:
        assert rendered.size==(1552,96+12+760)
        for column in columns:
            assert max(rendered.getpixel((column['x']*4+20-48,108+210-168)))<16
        assert min(rendered.getpixel((552-48,108+360-168)))>240
    full=area(2,0,0,420,297)
    question['review_frames']=[full]
    with db.connect() as c:db.put(c,'templates',template)
    assert manifest()==[auto[0],{'page':1,'rect':[0,0,1680,1188],'masks':[[536,320,32,80]]}]
    # A corrected scan uses its individual region on that face.
    corrected=area(2,10,45,100,64)
    with db.connect() as c:
        sub=db.get(c,task['submission_id']);sub['region_overrides']={question['id']:{'regions':[front_answer,corrected]}}
        db.put(c,'submissions',sub)
    assert manifest()==[auto[0],{'page':1,'rect':[40,180,400,256]}]
    question['review_frames']=[area(2,15,0,420,297)]
    assert any('显示框' in issue for issue in issues(template))
    question['review_frames']=[full,full]
    assert any('显示框' in issue for issue in issues(template))
