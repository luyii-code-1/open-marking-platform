"""Headless WebView-host backend test, including a real server outage and restart."""
import argparse
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import cv2
import httpx
from server import paper


def run(scanner_dll=None,bundled=False,back_first=False):
    repo=Path(__file__).resolve().parents[1]
    dll=Path(scanner_dll).resolve() if scanner_dll else repo/'scanner/bin/Debug/net10.0-windows/OMP.Scanner.dll'
    if not dll.is_file():raise RuntimeError('请先编译.NET扫描端')
    with tempfile.TemporaryDirectory(prefix='omp-desktop-smoke-') as temporary:
        root=Path(temporary).resolve()
        if not root.is_relative_to(Path(tempfile.gettempdir()).resolve()):raise RuntimeError('验证目录无效')
        with socket.socket() as reserve:reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
        base=f'http://127.0.0.1:{port}';env={**os.environ,'OMP_DATA':str(root/'data'),'OMP_TASK_MODE':'inline'}
        log=(root/'server.log').open('w',encoding='utf-8');server=None;native=None
        def start():
            process=subprocess.Popen([sys.executable,'-m','uvicorn','server.main:app','--host','127.0.0.1','--port',str(port),'--log-level','warning'],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            for _ in range(100):
                try:
                    if httpx.get(base+'/api/v1/health',timeout=.5).is_success:return process
                except httpx.TransportError:pass
                if process.poll() is not None:raise RuntimeError('验证服务启动失败')
                time.sleep(.1)
            process.terminate();process.wait(timeout=5);raise RuntimeError('验证服务未能启动')
        def stop(process):
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        try:
            server=start()
            with httpx.Client(base_url=base+'/api/v1/',timeout=30) as api:
                account={'username':'desktop-admin','password':secrets.token_urlsafe(20),'name':'本机验证管理员'}
                api.post('auth/bootstrap',json=account).raise_for_status();session=api.post('auth/login',json=account);session.raise_for_status();api.headers['Authorization']='Bearer '+session.json()['token']
                manager={**account,'username':'desktop-manager','role':'manager'}
                response=api.post('users',json=manager);response.raise_for_status()
                session=api.post('auth/login',json=manager);session.raise_for_status();api.headers['Authorization']='Bearer '+session.json()['token']
                def post(path,body):
                    result=api.post(path,json=body);result.raise_for_status();return result.json()
                project=post('projects',{'name':'离线工作区验证'});subject=post('subjects',{'project_id':project['id'],'name':'语文','group_mode':'default'});group_id=subject['default_group_id']
                cls=post('classes',{'name':'一班','grade':'10'});post('students',{'class_id':cls['id'],'name':'学生','candidate_number':'123'})
                post('projects/'+project['id']+'/room-tags',{'name':'第一考场'});post('projects/'+project['id']+'/room-tags',{'name':'二楼'})
                pairing=post('scanner/pairings',None)
                template=post('templates',{'group_id':group_id,'name':'本机双面卷','paper':'A4','sides':2,'candidate_length':3,'questions':[
                    {'number':1,'type':'single','choice_style':'bracket','points':3,'options':4,'answer':['B'],'regions':[{'page':1,'x':15,'y':110,'width':90,'height':20},{'page':1,'x':15,'y':140,'width':90,'height':20}]},
                    {'number':2,'type':'single','choice_style':'bracket','points':2,'options':4,'answer':['A'],'regions':[{'page':2,'x':15,'y':110,'width':90,'height':20}]}]})
                template=post('templates/'+template['id']+'/publish',None)
                pdf=root/'sheet.pdf';pdf.write_bytes(paper.pdf(template));renderer=shutil.which('pdftoppm')
                if not renderer:raise RuntimeError('需要Poppler生成扫描样本')
                subprocess.run([renderer,'-r','150','-png',str(pdf),str(root/'sheet')],check=True,capture_output=True)
                images=[]
                for index in range(2):
                    image=cv2.imread(str(root/f'sheet-{index+1}.png'),cv2.IMREAD_GRAYSCALE);sx=image.shape[1]/210;sy=image.shape[0]/297
                    def fill(x,y):cv2.rectangle(image,(round((x-1.5)*sx),round((y-1)*sy)),(round((x+1.5)*sx),round((y+1)*sy)),0,-1)
                    if index==0:
                        for col,digit in enumerate('123'):fill(18+col*6,57+int(digit)*3.5)
                    question=template['questions'][index]
                    for region in question['regions']:
                        _,x,y=paper.bubbles(question,region)[1 if index==0 else 0];fill(x,y)
                    path=root/f'filled-{index}.png';path.write_bytes(cv2.imencode('.png',image)[1].tobytes());images.append(path)
                entry=[str(dll.with_suffix('.exe'))] if bundled else ['dotnet',str(dll)]
                native=subprocess.Popen([*entry,'--desktop-self-test',base,str(root/'client'),str(images[0]),str(images[1]),project['id'],'pair-code',pairing['code'],'-' if bundled else sys.executable,str(repo),'back' if back_first else 'front'],cwd=repo,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
                messages=queue.Queue()
                def collect():
                    for line in native.stdout:messages.put(line)
                    messages.put(None)
                threading.Thread(target=collect,daemon=True).start()
                batch=None;deadline=time.monotonic()+180
                while time.monotonic()<deadline:
                    try:line=messages.get(timeout=1)
                    except queue.Empty:continue
                    if line is None:raise RuntimeError('本机验证进程结束：'+native.stderr.read()[-2000:])
                    print(line.strip(),flush=True);event=json.loads(line);checkpoint=event['checkpoint']
                    if checkpoint=='ready_for_offline':
                        stop(server);server=None;native.stdin.write('continue\n');native.stdin.flush()
                    elif checkpoint=='offline_processed':
                        assert server is None;batch=event['result']['batch_id'];server=start();native.stdin.write('continue\n');native.stdin.flush()
                    elif checkpoint=='passed':break
                else:raise TimeoutError('本地识读验证未能完成')
                assert native.wait(timeout=10)==0,native.stderr.read()[-2000:]
                response=api.get('results',params={'group_id':group_id});response.raise_for_status();rows=response.json();assert len(rows)==1 and rows[0]['candidate_number']=='123' and rows[0]['total']==5
                assert {t['name'] for t in rows[0]['room_tags']}=={'第一考场','二楼'}
                status=api.get('scanner/pairings/'+pairing['id']);status.raise_for_status();assert status.json()['status']=='paired'
                result={'status':'passed','scope':'headless desktop controller','manager_pairing':True,'uri_and_single_instance':True,'offline_room_tags':True,'offline_server_outage_and_restart':True,'bundled_engine':bundled,'first_side':'back' if back_first else 'front','pages':2,'candidate_number':'123','final_score':5,'batch_id':batch}
                print(json.dumps(result,ensure_ascii=False),flush=True);return result
        finally:
            if native and native.poll() is None:stop(native)
            if server and server.poll() is None:stop(server)
            log.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--scanner-dll',type=Path);parser.add_argument('--bundled',action='store_true');parser.add_argument('--back-first',action='store_true');options=parser.parse_args();run(options.scanner_dll,options.bundled,options.back_first)
