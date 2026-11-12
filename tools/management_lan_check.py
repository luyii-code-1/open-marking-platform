"""Exercise manager pairing, labels and lifecycle on an isolated LAN exam."""
import hashlib
import io
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
from uuid import uuid4
import cv2
import httpx
from PIL import Image
from cryptography.hazmat.primitives import serialization,hashes
from cryptography.hazmat.primitives.asymmetric import ec
from server.scanner_auth import encode,message


def validate(system,ca_file,revision,installer_sha,on_account=None,remote_check=None):
    report={'status':'running'}
    state=Path('dist/management-check-state.json');state.parent.mkdir(exist_ok=True)
    def checkpoint(**values):report.update(values);state.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    def post(api,path,body=None,status=200):
        response=api.post(path,json=body);assert response.status_code==status,(path,response.status_code,response.text[:180]);return response.json()
    def wait(api,identifier):
        checkpoint(last_job_id=identifier);next_report=0;deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            response=api.get('jobs/'+identifier);response.raise_for_status();job=response.json()
            if job['status']=='completed':return job['result']
            if job['status'] in ('failed','needs_review'):raise RuntimeError('验证任务未完成：'+identifier)
            if time.monotonic()>next_report:print('验证任务 '+identifier+'：'+job['status'],flush=True);next_report=time.monotonic()+15
            time.sleep(.5)
        raise TimeoutError('请继续观测原验证任务：'+identifier)
    account={'username':'manager-check-'+secrets.token_hex(4),'password':secrets.token_urlsafe(24),'name':'管理教师联调','role':'manager'}
    person=post(system,'users',account);checkpoint(manager_id=person['id'],manager_username=account['username'])
    if on_account:on_account(account)
    login=post(system,'auth/login',{**account,'portal':'admin'})
    with httpx.Client(base_url=str(system.base_url),verify=ca_file,timeout=60,headers={'Authorization':'Bearer '+login['token']}) as api:
        for path in ('system/backups','system/audit','storage-connections','scanner/devices'):
            assert api.get(path).status_code==403,path
        response=api.get('scanner/distribution');response.raise_for_status();package=response.json();assert package['available'] and package['sha256']==installer_sha
        link=post(api,'scanner/download-link');digest=hashlib.sha256();size=0
        with api.stream('GET',str(system.base_url).split('/api/v1/')[0]+link['url']) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes():digest.update(chunk);size+=len(chunk)
        assert digest.hexdigest()==installer_sha and size==package['size'];checkpoint(installer_download='passed')
        pair=post(api,'scanner/pairings',status=201);key=ec.generate_private_key(ec.SECP256R1())
        public=encode(key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo))
        body={'code':pair['code'],'public_key':public,'label':'管理扫描台自动验证'}
        device=post(api,'scanner/pair',body)['device'];checkpoint(device_id=device['id'])
        assert api.post('scanner/pair',json=body).status_code==403
        challenge=post(api,'scanner/challenge',{'device_id':device['id']})
        session=post(api,'scanner/authenticate',{'challenge_id':challenge['id'],'signature':encode(key.sign(message(challenge),ec.ECDSA(hashes.SHA256())))})
        with httpx.Client(base_url=str(system.base_url),verify=ca_file,timeout=60,headers={'Authorization':'Bearer '+session['token']}) as scanner:
            response=scanner.get('scanner/catalog');response.raise_for_status()
            project=post(api,'projects',{'name':'管理扫描台验证-'+revision[:8]});checkpoint(project_id=project['id'])
            choices=api.get('storage-connections/choices');choices.raise_for_status()
            storage=next(c for c in choices.json() if c['name']=='ROS 内网测试')
            response=api.put('projects/'+project['id']+'/storage',json={'connection_id':storage['id']});response.raise_for_status()
            subject=post(api,'subjects',{'project_id':project['id'],'name':'验证科目','group_mode':'default'});group_id=subject['default_group_id'];checkpoint(group_id=group_id)
            tags=[post(api,'projects/'+project['id']+'/room-tags',{'name':name},201) for name in ('第一考场','二楼')]
            response=api.get('students');response.raise_for_status();student=next(s for s in response.json() if str(s['candidate_number']).isdigit())
            candidate=student['candidate_number']
            template=post(api,'templates',{'name':'扫描台验证卷','group_id':group_id,'paper':'A4','sides':1,'candidate_length':len(candidate),'questions':[
                {'number':1,'type':'single','choice_style':'bracket','options':4,'points':1,'answer':['B'],'regions':[{'page':1,'x':15,'y':110,'width':90,'height':6}]},
                {'number':2,'type':'subjective','points':1,'review_mode':'single','regions':[{'page':1,'x':15,'y':150,'width':80,'height':20}]}]})
            template=post(api,'templates/'+template['id']+'/publish');checkpoint(template_id=template['id'])
            response=scanner.get('scanner/projects/'+project['id']+'/package');response.raise_for_status();pack=response.json();config=pack['groups'][0]
            assert pack['protocol']=='omp-scanner-4' and len(pack['room_tags'])==2
            assert 'answer' not in config['template']['questions'][0]
            batch_id=str(uuid4());tag_ids=[t['id'] for t in tags]
            batch=post(scanner,'scanner/batches/'+batch_id,{'group_id':group_id,'template_id':template['id'],'template_revision':template['revision'],'config_sha256':config['config_sha256'],'capture_mode':'separate','back_order':'same','room_tag_ids':tag_ids})
            page_id=str(uuid4());checkpoint(batch_id=batch_id,page_id=page_id)
            with tempfile.TemporaryDirectory(prefix='omp-manager-lan-') as temporary:
                root=Path(temporary).resolve();assert root.parent==Path(tempfile.gettempdir()).resolve()
                pdf=api.get('templates/'+template['id']+'/pdf');pdf.raise_for_status();(root/'paper.pdf').write_bytes(pdf.content)
                subprocess.run([shutil.which('pdftoppm'),'-r','150','-singlefile','-png',str(root/'paper.pdf'),str(root/'sheet')],check=True,capture_output=True)
                image=cv2.imread(str(root/'sheet.png'),cv2.IMREAD_GRAYSCALE);sx=image.shape[1]/210;sy=image.shape[0]/297
                def fill(x,y):cv2.rectangle(image,(round((x-1.5)*sx),round((y-1)*sy)),(round((x+1.5)*sx),round((y+1)*sy)),0,-1)
                for col,digit in enumerate(candidate):fill(18+col*6,57+int(digit)*3.5)
                from server.paper import bubbles
                _,x,y=bubbles(template['questions'][0],template['questions'][0]['regions'][0])[1];fill(x,y)
                source=root/'pages'/batch_id/(page_id+'.jpg');source.parent.mkdir(parents=True);content=cv2.imencode('.jpg',image)[1].tobytes();source.write_bytes(content)
                from scanner_engine.main import process
                recognized=process(root,{'batch_id':batch_id,'capture_id':page_id,'side':'front','template':config['template'],'config_sha256':config['config_sha256'],'source_sha256':hashlib.sha256(content).hexdigest()})
                derived=root/'processed'/page_id
                response=scanner.post('scanner/batches/'+batch_id+'/pages',data={'capture_id':page_id,'side':'front','sequence':'1','manifest':json.dumps(recognized)},files={'file':('scan.jpg',content,'image/jpeg'),'normalized':('normalized.png',(derived/'normalized.png').read_bytes(),'image/png'),'cuts':('cuts.zip',(derived/'cuts.zip').read_bytes(),'application/zip')});response.raise_for_status()
            response=api.get('jobs',params={'project_id':project['id']});response.raise_for_status()
            mirrors=[j for j in response.json() if j['kind']=='mirror'];assert len(mirrors)==3
            for job in mirrors:wait(api,job['id'])
            if remote_check:remote_check(project['id'],page_id,True,True)
            post(scanner,'scan-batches/'+batch_id+'/pair',{'local_pairs':[{'candidate_number':candidate,'pages':[page_id]}]})
            post(api,'assignments',{'template_id':template['id'],'question_id':template['questions'][1]['id'],'user_ids':[person['id']]})
            task=post(api,'tasks/claim',{'template_id':template['id'],'question_id':template['questions'][1]['id']})
            image=api.get('tasks/'+task['id']+'/image');image.raise_for_status()
            with Image.open(io.BytesIO(image.content)) as cut:assert cut.size==(320,80)
            post(api,'tasks/'+task['id']+'/score',{'score':0,'idempotency_key':str(uuid4())})
            params={'group_id':group_id,'room_tag_id':tag_ids[0]}
            response=api.get('results',params=params);response.raise_for_status();rows=response.json()
            assert len(rows)==1 and rows[0]['total']==1 and {t['name'] for t in rows[0]['room_tags']}=={'第一考场','二楼'}
            response=api.get('analysis/group',params=params);response.raise_for_status();assert response.json()['summary']['records']==1
            response=api.get('results/export',params=params);response.raise_for_status();assert '第一考场' in response.text and '二楼' in response.text
            exception=post(api,'tasks/'+task['id']+'/report',{'kind':'excellent','reason':'考场标签验证'})
            response=api.get('exports/exceptions',params={'room_tag_id':tag_ids[0]});response.raise_for_status();assert '第一考场' in response.text
            post(api,'exceptions/'+exception['id']+'/resolve',{'resolution':'验证完成'})
            post(api,'results/publish',{'group_id':group_id})
            checkpoint(pairing='passed',tag_filter_export='passed',score=1)
            archive_job=post(api,'projects/'+project['id']+'/archive-jobs',status=202);archive=wait(api,archive_job['id'])
            response=api.get('archives/'+archive['id']+'/download');response.raise_for_status();assert hashlib.sha256(response.content).hexdigest()==archive['sha256']
            plan=post(api,'projects/'+project['id']+'/deletion-preview');assert not plan['blockers']
            assert next(v['count'] for v in plan['counts'] if v['kind']=='room-tags')==2
            confirmed=post(api,'deletion-plans/'+plan['id']+'/confirm',{'confirm':True,'reason':'管理教师、扫描台及标签联调完成'},202)
            deleted=wait(api,confirmed['job_id']);assert deleted['status']=='completed' and deleted['file_count']==3
            if remote_check:remote_check(project['id'],page_id,False,True)
            post(system,'scanner/devices/'+device['id']+'/status',{'enabled':False,'reason':'自动验证结束，保留设备审计'})
            response=api.get('archives/'+archive['id']+'/download');response.raise_for_status();assert hashlib.sha256(response.content).hexdigest()==archive['sha256']
            checkpoint(status='passed',archive_preserved=True,cleanup='local and remote scans plus exam labels',device_revoked=True)
        post(api,'auth/logout')
    return report
