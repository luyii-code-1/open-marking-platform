"""Headless Windows scanner/API integration using an isolated temporary server."""
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import cv2
import httpx
from server import paper


def run(scanner_dll=None):
    repo=Path(__file__).resolve().parents[1]
    dll=Path(scanner_dll).resolve() if scanner_dll else repo/'scanner/bin/Debug/net8.0-windows/OMP.Scanner.dll'
    if not dll.exists():raise RuntimeError('请先构建扫描客户端')
    renderer=shutil.which('pdftoppm')
    if not renderer:raise RuntimeError('需要pdftoppm生成扫描样本')
    with tempfile.TemporaryDirectory(prefix='omp-scanner-smoke-') as temporary:
        root=Path(temporary).resolve()
        if not root.is_relative_to(Path(tempfile.gettempdir()).resolve()) or not root.name.startswith('omp-scanner-smoke-'):raise RuntimeError('临时目录边界无效')
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
        env={**os.environ,'OMP_DATA':str(root/'server-data'),'OMP_TASK_MODE':'inline'}
        with (root/'server.log').open('w',encoding='utf-8') as log:
            process=subprocess.Popen([sys.executable,'-m','uvicorn','server.main:app','--host','127.0.0.1','--port',str(port),'--log-level','warning'],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            try:
                base=f'http://127.0.0.1:{port}'
                with httpx.Client(base_url=base+'/api/v1/',timeout=30) as client:
                    deadline=time.monotonic()+15
                    while True:
                        try:
                            if client.get('health').is_success:break
                        except httpx.HTTPError:pass
                        if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('临时服务启动失败')
                        time.sleep(.05)
                    credentials={'username':'scanner-smoke-admin','password':secrets.token_urlsafe(24),'name':'自检管理员'}
                    client.post('auth/bootstrap',json=credentials).raise_for_status()
                    response=client.post('auth/login',json=credentials);response.raise_for_status()
                    client.headers['Authorization']='Bearer '+response.json()['token']
                    def create(kind,value):
                        response=client.post(kind,json=value);response.raise_for_status();return response.json()
                    project=create('projects',{'name':'扫描端联调'})
                    subject=create('subjects',{'project_id':project['id'],'name':'测试科目'})
                    group=create('groups',{'subject_id':subject['id'],'name':'测试组'})
                    cls=create('classes',{'name':'测试班','grade':'10'})
                    create('students',{'name':'测试学生','candidate_number':'123','class_id':cls['id']})
                    template=create('templates',{'name':'Scanner smoke','group_id':group['id'],'paper':'A4','sides':1,'candidate_length':3,'questions':[{'number':1,'type':'single','options':4,'points':3,'answer':['B'],'regions':[{'page':1,'x':15,'y':110,'width':90,'height':20}]}]})
                    response=client.post(f"templates/{template['id']}/publish");response.raise_for_status();template=response.json()
                    pdf=root/'sheet.pdf';response=client.get(f"templates/{template['id']}/pdf");response.raise_for_status();pdf.write_bytes(response.content)
                    subprocess.run([renderer,'-r','150','-singlefile','-png',str(pdf),str(root/'sheet')],capture_output=True,check=True)
                    image=cv2.imread(str(root/'sheet.png'),cv2.IMREAD_GRAYSCALE);sx=image.shape[1]/210;sy=image.shape[0]/297
                    def fill(x,y):cv2.rectangle(image,(round((x-1.5)*sx),round((y-1)*sy)),(round((x+1.5)*sx),round((y+1)*sy)),0,-1)
                    for column,digit in enumerate('123'):fill(18+column*6,57+int(digit)*3.5)
                    _,x,y=paper.bubbles(template['questions'][0],template['questions'][0]['regions'][0])[1];fill(x,y)
                    image_path=root/'filled.png';cv2.imwrite(str(image_path),image)
                    cv2.imwrite(str(root/'blurred.png'),cv2.GaussianBlur(image,(31,31),10))
                    damaged=image.copy();cv2.rectangle(damaged,(0,0),(round(14*sx),round(14*sy)),255,-1)
                    cv2.imwrite(str(root/'missing-corner.png'),damaged)
                    tested=subprocess.run(['dotnet',str(dll),'--self-test',base,str(root/'client'),str(image_path),group['id'],credentials['username'],credentials['password']],cwd=repo,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=60,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
                    if tested.returncode:raise RuntimeError((tested.stdout+tested.stderr).strip())
                    response=client.get('results',params={'group_id':group['id']});response.raise_for_status();rows=response.json()
                    if len(rows)!=1 or rows[0]['candidate_number']!='123' or rows[0]['total']!=3:raise RuntimeError('服务端结分与客户端上传不一致')
                    files=list((root/'client/devices').glob('*.json'))
                    if len(files)!=1 or set(json.loads(files[0].read_text()))!={'device_id'}:raise RuntimeError('客户端设备登记文件包含非预期内容')
                    print(tested.stdout.strip())
                    print(json.dumps({'scope':'headless Windows queue and signed device API','candidate_number':rows[0]['candidate_number'],'final_score':rows[0]['total'],'status':'passed'},ensure_ascii=False))
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scanner-dll',type=Path,help='Use an extracted published scanner DLL')
    run(parser.parse_args().scanner_dll)
