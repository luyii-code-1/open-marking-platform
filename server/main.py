import hashlib
import hmac
import json
import secrets
import time
import os
import threading
import asyncio
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import uuid4

from fastapi import FastAPI, Depends, Header, HTTPException, UploadFile, File, Form, Request, Body
from fastapi.responses import Response, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .db import connect, get, initialize, objects, put
from .scoring import cents, final_score
from . import db as database
from . import paper


@asynccontextmanager
async def lifespan(app):
    initialize()
    from .request_log import Journal
    app.state.request_journal=Journal(database.ROOT)
    from .realtime import Hub
    app.state.event_hub=await Hub().start()
    stop=threading.Event();recovery=None
    if os.getenv('OMP_TASK_MODE','inline')=='inline':
        from .jobs import recover
        recover()
        def resume_local():
            while not stop.wait(15):
                try:recover()
                except Exception:pass
        recovery=threading.Thread(target=resume_local,daemon=True,name='omp-local-recovery');recovery.start()
    try:yield
    finally:
        stop.set()
        if recovery:recovery.join(timeout=1)
        await app.state.event_hub.stop()
        await asyncio.to_thread(app.state.request_journal.close)


app = FastAPI(title='Open Marking Platform',version='0.1.0',lifespan=lifespan)
from .request_log import record_request
app.middleware('http')(record_request)

from .identifiers import InvalidIdentifier,IdentifierConflict,prepare_questions

@app.exception_handler(InvalidIdentifier)
async def invalid_identifier(request,error):
    return JSONResponse(status_code=422,content={'detail':str(error)})

@app.exception_handler(IdentifierConflict)
async def conflicting_identifier(request,error):
    return JSONResponse(status_code=409,content={'detail':str(error)})


from .dependencies import password_hash,user,admin,scan_user,scan_admin,require,scan_batch


class Login(BaseModel):
    username: str = Field(min_length=1,max_length=100)
    password: str = Field(min_length=1,max_length=200)
    portal: str | None = None


class Account(Login):
    name: str = Field(min_length=1,max_length=100)
    role: str = 'teacher'


@app.post('/api/v1/auth/bootstrap')
def bootstrap(body: Account,request:Request=None):
    if len(body.password)<10:
        raise HTTPException(422,'管理员密码至少10个字符')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM users LIMIT 1').fetchone():
            raise HTTPException(409,'管理员已创建')
        identifier=str(uuid4())
        db.execute('INSERT INTO users VALUES(?,?,?,?,?)',(identifier,body.username,body.name,'admin',password_hash(body.password)))
        put(db,'account-events',{'user_id':identifier,'action':'bootstrap','username':body.username,'name':body.name,'role':'admin'},identifier)
    if request is not None:request.state.actor=identifier
    return {'status':'created'}


@app.post('/api/v1/auth/login')
def login(body: Login,request:Request=None):
    with connect() as db:
        row=db.execute('SELECT * FROM users WHERE username=?',(body.username,)).fetchone()
        stored=row['password'] if row else password_hash('invalid-password')
        if not hmac.compare_digest(stored,password_hash(body.password,stored.split(':')[0])) or row is None:
            raise HTTPException(401,'账号或密码错误')
        if body.portal not in (None,'admin','marking'):raise HTTPException(422,'登录入口无效')
        if body.portal=='admin' and row['role'] not in ('admin','manager'):raise HTTPException(403,'此账号没有管理后台权限，请使用阅卷台入口')
        token=secrets.token_urlsafe(40)
        db.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),row['id'],time.time()+43200))
        put(db,'account-events',{'user_id':row['id'],'action':'login','method':'password'},row['id'])
        if request is not None:request.state.actor=row['id']
        return {'token':token,'user':{k:row[k] for k in ('id','username','name','role')}}


@app.get('/api/v1/auth/me')
def me(current=Depends(user)):
    return current


@app.get('/api/v1/users')
def users(current=Depends(admin)):
    with connect() as db:
        return [dict(r) for r in db.execute('SELECT id,username,name,role FROM users')]


@app.post('/api/v1/users')
def create_user(body: Account,current=Depends(admin)):
    if body.role not in ('admin','manager','teacher') or len(body.password)<10:
        raise HTTPException(422,'角色无效或密码不足10位')
    if current['role']=='manager' and body.role!='teacher':raise HTTPException(403,'管理教师只能创建普通教师账号')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM users WHERE username=?',(body.username,)).fetchone():
            raise HTTPException(409,'账号已存在')
        result={'id':str(uuid4()),'username':body.username,'name':body.name,'role':body.role}
        db.execute('INSERT INTO users VALUES(?,?,?,?,?)',(*result.values(),password_hash(body.password)))
        put(db,'account-events',{'user_id':result['id'],'action':'created',**{k:result[k] for k in ('username','name','role')}},current['id'])
    return result


KINDS={'projects':(), 'subjects':('project_id','projects'), 'groups':('subject_id','subjects'), 'classes':(), 'students':('class_id','classes'), 'templates':('group_id','groups'), 'scan-batches':('group_id','groups'), 'assignments':('template_id','templates'), 'score-conversions':()}


def list_route(kind):
    def endpoint(current=Depends(scan_user if kind in ('projects','subjects','groups','templates','scan-batches') else user)):
        with connect() as db:
            values=objects(db,kind)
            if current['role'] in ('admin','manager'):
                return values
            if current['role']=='scanner':
                if kind=='scan-batches':return [v for v in values if v.get('scanner_device_id')==current['id']]
                if kind=='templates':return [{k:v[k] for k in ('id','name','group_id','paper','sides','status','revision','layout_version') if k in v} for v in values]
                fields={'projects':('id','name','status'),'subjects':('id','name','project_id'),'groups':('id','name','subject_id','template_id','frozen')}
                return [{k:v[k] for k in fields[kind] if k in v} for v in values]
            assigned=[a for a in objects(db,'assignments') if current['id'] in (a.get('user_ids',[])+a.get('arbitrator_ids',[]))]
            templates={a['template_id'] for a in assigned}
            if kind=='assignments': return assigned
            if kind=='templates': return [t for t in values if t['id'] in templates]
            groups={t['group_id'] for t in objects(db,'templates') if t['id'] in templates}
            from .visibility import result_groups
            groups.update(result_groups(db,current['id']))
            if kind=='groups': return [g for g in values if g['id'] in groups]
            subjects={g['subject_id'] for g in objects(db,'groups') if g['id'] in groups and 'subject_id' in g}
            if kind=='subjects': return [s for s in values if s['id'] in subjects]
            projects={s['project_id'] for s in objects(db,'subjects') if s['id'] in subjects}
            if kind=='projects': return [p for p in values if p['id'] in projects]
            raise HTTPException(403,'需要管理员权限')
    return endpoint


def create_route(kind):
    def endpoint(body:dict,current=Depends(scan_admin if kind=='scan-batches' else admin)):
        if kind=='score-conversions' and current['role']!='admin':raise HTTPException(403,'需要系统管理员权限')
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            parent=KINDS[kind]
            if parent:
                if not isinstance(body.get(parent[0]),str):raise HTTPException(422,'所属记录编号无效')
                require(db,body.get(parent[0]),parent[1])
            value=dict(body)
            if kind=='scan-batches':value={k:body[k] for k in ('group_id','room','back_order','room_tag_ids') if k in body}
            value.pop('id',None)
            if kind in ('projects','subjects','groups','classes','students','templates') and not str(value.get('name','')).strip():
                raise HTTPException(422,'请填写名称')
            if kind=='projects': value['status']='draft'
            if kind=='subjects' and value.get('group_mode','custom') not in ('custom','default'):raise HTTPException(422,'分组方式无效')
            if kind=='groups': value['template_id']=None
            if kind=='templates':
                if value.get('paper') not in ('A3','A4') or value.get('sides') not in (1,2):
                    raise HTTPException(422,'纸型或单双面无效')
                value.update(revision=0,status='draft',layout_version=3)
                value.setdefault('notice_template','standard-v1')
                prepare_questions(value)
            if kind=='assignments':
                template=require(db,value['template_id'],'templates')
                if not any(q['id']==value.get('question_id') for q in template['questions']): raise HTTPException(422,'题目不存在')
                ids=value.get('user_ids',[])
                if not ids or not isinstance(ids,list) or len(set(ids))!=len(ids): raise HTTPException(422,'请选择不重复的阅卷教师')
                for identifier in ids:
                    if not db.execute('SELECT 1 FROM users WHERE id=?',(identifier,)).fetchone(): raise HTTPException(422,'教师不存在')
                weights=value.get('weights',{})
                if not isinstance(weights,dict) or any(k not in ids or not isinstance(w,(int,float)) or not 0<=w<=255 for k,w in weights.items()): raise HTTPException(422,'教师权重应在0至255之间')
                arbitrators=value.get('arbitrator_ids',[])
                if not isinstance(arbitrators,list) or any(not db.execute('SELECT 1 FROM users WHERE id=?',(identifier,)).fetchone() for identifier in arbitrators):raise HTTPException(422,'仲裁教师无效')
                from .allocation import validate as validate_assignment
                question=next(q for q in template['questions'] if q['id']==value['question_id'])
                if question['type']!='subjective':raise HTTPException(422,'客观题无需分配教师')
                validate_assignment(value,question)
                previous=[a for a in objects(db,'assignments') if a['template_id']==value['template_id'] and a['question_id']==value['question_id']]
                if previous: value['id']=previous[-1]['id']
            if kind=='students':
                if not isinstance(value.get('candidate_number'),str) or not value['candidate_number'].isdigit(): raise HTTPException(422,'准考证号应为数字字符串')
                if any(s['candidate_number']==value['candidate_number'] for s in objects(db,'students')): raise HTTPException(409,'准考证号已存在')
            if kind=='score-conversions':
                from .conversion import validate_conversion
                if not isinstance(value.get('name'),str) or not 1<=len(value['name'].strip())<=100:raise HTTPException(422,'请填写100字以内方案名称')
                try: validate_conversion(value)
                except (ValueError,KeyError,TypeError) as error: raise HTTPException(422,str(error))
                value['revision']=1
            if kind=='scan-batches':
                if value.get('back_order','same') not in ('same','reverse') or not isinstance(value.get('room',''),str) or len(value.get('room',''))>100:raise HTTPException(422,'背面顺序或考场备注无效')
                value.setdefault('back_order','same')
                value.pop('scanner_device_id',None)
                if current['role']=='scanner':value['scanner_device_id']=current['id']
                group=require(db,value['group_id'],'groups')
                from .room_tags import snapshot,project_for_group
                tag_ids=value.pop('room_tag_ids',[])
                if not isinstance(tag_ids,list):raise HTTPException(422,'考场标签应为编号列表')
                value['room_tags']=snapshot(db,project_for_group(db,group['id']),tag_ids) if tag_ids else []
                if group.get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核')
                if not group.get('template_id'):
                    raise HTTPException(422,'请先发布题卡')
                template=require(db,group['template_id'],'templates')
                value.update(status='front',template_id=template['id'],template_revision=template['revision'])
            result=put(db,kind,value,current['id'])
            if kind=='subjects' and value.get('group_mode')=='default':
                from .templates import default_group
                group=default_group(db,result['id'],current['id']);result['default_group_id']=group['id']
            if kind=='assignments':
                from .allocation import ensure
                ensure(db,template,question,result)
            return result
    return endpoint


for kind in KINDS:
    app.add_api_route('/api/v1/'+kind,list_route(kind),methods=['GET'],name='list_'+kind)
    app.add_api_route('/api/v1/'+kind,create_route(kind),methods=['POST'],name='create_'+kind)


@app.get('/api/v1/dashboard')
def dashboard(current=Depends(user)):
    with connect() as db:
        if current['role'] not in ('admin','manager'):
            assigned={a['template_id'] for a in objects(db,'assignments') if current['id'] in (a.get('user_ids',[])+a.get('arbitrator_ids',[]))}
            templates=[t for t in objects(db,'templates') if t['id'] in assigned]
            return {'groups':len({t['group_id'] for t in templates}),'pending_tasks':sum(t['user_id']==current['id'] and t['status']=='claimed' for t in objects(db,'tasks'))}
        result={k:len(objects(db,k)) for k in ('projects','groups','students','exceptions')}
        result['pending_tasks']=sum(t.get('status')!='completed' for t in objects(db,'tasks'))
        return result


@app.put('/api/v1/templates/{identifier}')
def edit_template(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        old=require(db,identifier,'templates')
        if old['status']=='published': raise HTTPException(409,'已发布版式不能直接编辑，请复制新题卡')
        body={**old,**body,'id':identifier,'group_id':old['group_id'],'status':'draft','revision':old['revision'],'layout_version':3}
        body.setdefault('notice_template','standard-v1')
        prepare_questions(body)
        return put(db,'templates',body,current['id'])


@app.post('/api/v1/templates/{identifier}/publish')
def publish(identifier:str,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        template=require(db,identifier,'templates')
        group=require(db,template['group_id'],'groups')
        if template['status']!='published':
            if group.get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核或选择新的题卡组')
            if group.get('template_id') and group['template_id']!=identifier and (database.find(db,'scan-batches',group_id=group['id']) or database.find(db,'submissions',group_id=group['id'])):raise HTTPException(409,'本组已有扫描批次或答卷，请为新题卡新建题卡组')
        from .template_checks import issues,asset_ids
        errors=issues(template,complete=True)
        if errors:raise HTTPException(422,'；'.join(errors))
        try:assets=asset_ids(template)
        except (ValueError,KeyError,TypeError) as error:raise HTTPException(422,str(error))
        for asset_id in assets:require(db,asset_id,'assets')
        if template['status']!='published':
            template.update(status='published',revision=template['revision']+1)
            put(db,'templates',template,current['id'])
            group=require(db,template['group_id'],'groups')
            group['template_id']=identifier
            put(db,'groups',group,current['id'])
        return template


@app.get('/api/v1/scan-batches/{identifier}')
def batch(identifier:str,current=Depends(scan_admin)):
    with connect() as db:
        value=scan_batch(db,identifier,current)
        return {**value,'group_frozen':bool(require(db,value['group_id'],'groups').get('frozen'))}


@app.get('/api/v1/health')
def health():
    with connect() as db: db.execute('SELECT 1')
    return {'status':'ok'}


@app.get('/api/v1/templates/{identifier}/pdf')
def print_template(identifier:str,current=Depends(admin)):
    with connect() as db: template=require(db,identifier,'templates')
    if template['status']!='published': raise HTTPException(409,'请先发布题卡')
    return Response(paper.pdf(template),media_type='application/pdf',headers={'Content-Disposition':'attachment; filename=answer-sheet.pdf'})


@app.get('/api/v1/scan-batches/{identifier}/pages')
def pages(identifier:str,current=Depends(scan_admin)):
    with connect() as db:
        scan_batch(db,identifier,current)
        return sorted([p for p in objects(db,'pages') if p['batch_id']==identifier],key=lambda p:(p['side'],p['sequence']))


@app.post('/api/v1/scan-batches/{identifier}/pages')
def upload_page(identifier:str,file:UploadFile=File(),capture_id:str=Form(),side:str=Form(),sequence:int=Form(),quality_report:str=Form('{}'),current=Depends(scan_admin)):
    from .scan_quality import parse,ISSUES
    quality=parse(quality_report)
    from uuid import UUID
    try: capture_id=str(UUID(capture_id))
    except ValueError: raise HTTPException(422,'采集编号无效')
    if side not in ('front','back') or sequence<1: raise HTTPException(422,'面或顺序无效')
    data=file.file.read(30*1024*1024+1)
    if len(data)>30*1024*1024: raise HTTPException(413,'图片超过30MB')
    digest=hashlib.sha256(data).hexdigest()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        batch=scan_batch(db,identifier,current)
        existing=get(db,capture_id,'pages')
        if existing:
            if existing['sha256']!=digest or existing['batch_id']!=identifier or existing['side']!=side or existing['sequence']!=sequence: raise HTTPException(409,'采集编号冲突')
            if existing['status']=='quarantined': return JSONResponse(status_code=409,content={**existing,'detail':'该页已隔离，批次冻结'})
            return existing
        if require(db,batch['group_id'],'groups').get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核')
        if batch['status'] in ('frozen','paired'): raise HTTPException(409,'批次已冻结或已确认')
        template=require(db,batch['template_id'],'templates')
        try:image,value=paper.decode(data,template)
        except ValueError as error:raise HTTPException(422,str(error))
        if side=='back' and template['sides']==1: raise HTTPException(422,'单面题卡不需要背面')
        if any(p['batch_id']==identifier and p['side']==side and p['sequence']==sequence and not p.get('excluded') for p in objects(db,'pages')): raise HTTPException(409,'该顺序已采集，请处理补扫')
        from .lifecycle import writable
        writable(db,'scan-batches',batch)
        storage=database.ROOT/'pages'; storage.mkdir(parents=True,exist_ok=True)
        path=storage/(capture_id+'.image')
        temporary=path.with_suffix('.tmp'); temporary.write_bytes(data); temporary.replace(path)
        page={'id':capture_id,'batch_id':identifier,'side':side,'sequence':sequence,'sha256':digest,'status':'received','candidate_number':None,'image_url':f'/api/v1/pages/{capture_id}/image'}
        if quality:
            page['scanner_quality']=quality
            if quality['issues']:
                batch['status']='frozen'
                put(db,'scan-batches',batch,current['id'])
                put(db,'exceptions',{'batch_id':identifier,'group_id':batch['group_id'],'page_id':capture_id,'kind':'scan_quality','source':'scanner','status':'open','reason':'；'.join(ISSUES[i] for i in quality['issues']),'evidence':quality},current['id'])
        status=200
        if not paper.manual_binding(template) and value!=paper.code(template,side):
            page['status']='quarantined'; batch['status']='frozen'
            put(db,'scan-batches',batch,current['id'])
            put(db,'exceptions',{'batch_id':identifier,'page_id':capture_id,'kind':'wrong_paper','status':'open','reason':'二维码与所选考卷或面不符'},current['id'])
            status=409
        put(db,'pages',page,current['id'])
    if status==200:
        from .jobs import queue
        queue('process-page',{'page_id':capture_id})
        with connect() as db:page=require(db,capture_id,'pages')
    return JSONResponse(status_code=status,content={**page,'quality_review_required':bool(quality and quality['issues'])} if status==200 else {**page,'detail':'扫描中断：二维码不符，批次已冻结'})


@app.get('/api/v1/pages/{identifier}/image')
def page_image(identifier:str,current=Depends(admin)):
    with connect() as db: require(db,identifier,'pages')
    from .storage import materialize
    try:path=materialize('pages/'+identifier+'.png')
    except FileNotFoundError:path=materialize('pages/'+identifier+'.image')
    return FileResponse(path)


@app.post('/api/v1/scan-batches/{identifier}/pair')
def pair(identifier:str,body:dict|None=Body(default=None),current=Depends(scan_admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        batch=scan_batch(db,identifier,current)
        if batch['status']=='frozen': raise HTTPException(409,'批次已冻结，请处理异常')
        if batch['status']=='paired': return batch
        if require(db,batch['group_id'],'groups').get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核')
        template=require(db,batch['template_id'],'templates')
        all_pages=[p for p in objects(db,'pages') if p['batch_id']==identifier and not p.get('excluded')]
        page_list=[p for p in all_pages if not p.get('linked_submission_id')]
        if all_pages and not page_list:
            batch['status']='paired';return put(db,'scan-batches',batch,current['id'])
        fronts=sorted([p for p in page_list if p['side']=='front'],key=lambda p:p['sequence'])
        backs=sorted([p for p in page_list if p['side']=='back'],key=lambda p:p['sequence'],reverse=batch.get('back_order')=='reverse')
        if not fronts or (template['sides']==2 and len(fronts)!=len(backs)): raise HTTPException(409,'正反面数量不符')
        if any(p['status']=='received' for p in page_list):raise HTTPException(425,'页面正在后台识别，请稍后重试')
        if any(p['status']!='recognized' for p in page_list): raise HTTPException(409,'存在待处理识别异常')
        numbers=[p['candidate_number'] for p in fronts]
        if any(not number or '?' in number for number in numbers) or len(set(numbers))!=len(numbers): raise HTTPException(409,'考号缺失或重复，请处理后配对')
        if body and 'local_pairs' in body:
            local=[{'candidate_number':front['candidate_number'],'pages':[front['id']]+([backs[i]['id']] if template['sides']==2 else [])} for i,front in enumerate(fronts)]
            if body['local_pairs']!=local:raise HTTPException(409,'本地配页清单与服务器页面记录不一致，请核查后重新确认')
        students={s['candidate_number']:s for s in objects(db,'students')}
        group=require(db,batch['group_id'],'groups')
        if group.get('roster_id'):students.update({s['candidate_number']:s for s in require(db,group['roster_id'],'rosters')['students']})
        if any(number not in students for number in numbers): raise HTTPException(409,'考号不在学生名单中')
        for index,front in enumerate(fronts):
            student=students[front['candidate_number']]
            from .student_history import snapshot
            student=snapshot(db,student)
            if any(s['group_id']==batch['group_id'] and s['student_id']==student['id'] for s in objects(db,'submissions')): raise HTTPException(409,'已有该学生答卷，请明确执行补扫替换')
            submission=put(db,'submissions',{'group_id':batch['group_id'],'template_id':template['id'],'student_id':student['id'],'student_snapshot':student,'room_tags':batch.get('room_tags',[]),'candidate_number':front['candidate_number'],'pages':[front['id']]+([backs[index]['id']] if template['sides']==2 else []),'status':'absent' if front.get('absent_mark') else 'ready','attendance_source':'scan_mark' if front.get('absent_mark') else 'scan'},current['id'])
            from .answer_slices import sync
            submission=sync(db,submission,template,current['id'])
            from .anomalies import check_submission
            check_submission(db,submission,current['id'])
        batch['status']='paired'
        return put(db,'scan-batches',batch,current['id'])


from .review import router as review_router
app.include_router(review_router)
from .operations import router as operations_router
app.include_router(operations_router)
from .corrections import router as corrections_router
app.include_router(corrections_router)
from .accounts import router as accounts_router
app.include_router(accounts_router)
from .passkeys import router as passkeys_router
app.include_router(passkeys_router)
from .anomalies import router as anomalies_router
app.include_router(anomalies_router)
from .analysis import router as analysis_router
app.include_router(analysis_router)
from .roster import router as roster_router
app.include_router(roster_router)
from .release import router as release_router
app.include_router(release_router)
from .storage_jobs import router as storage_jobs_router
app.include_router(storage_jobs_router)
from .storage_connections import router as storage_connections_router
app.include_router(storage_connections_router)
from .alignment import router as alignment_router
app.include_router(alignment_router)
from .scanner_auth import router as scanner_auth_router
app.include_router(scanner_auth_router)
from .templates import router as templates_router
app.include_router(templates_router)
from .realtime import router as realtime_router
app.include_router(realtime_router)
from .audit import router as audit_router
app.include_router(audit_router)
from .conversion_routes import router as conversion_router
app.include_router(conversion_router)
from .deletion import router as deletion_router
app.include_router(deletion_router)
from .scanner_pipeline import router as scanner_pipeline_router
app.include_router(scanner_pipeline_router)
from .room_tags import router as room_tags_router
app.include_router(room_tags_router)
from .scanner_workbench import router as scanner_workbench_router
app.include_router(scanner_workbench_router)

web_distribution=Path(__file__).resolve().parents[1]/'web'/'dist'
if web_distribution.exists():
    app.mount('/',StaticFiles(directory=web_distribution,html=True),name='web')
