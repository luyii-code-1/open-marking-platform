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
from fastapi.responses import Response, JSONResponse, FileResponse, RedirectResponse
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .lifecycle import RESULTS_REVIEW_GUIDE
from .db import connect, find, get, initialize, objects, put
from .scoring import cents, final_score
from . import db as database
from . import paper, statistics_sheet


@asynccontextmanager
async def lifespan(app):
    initialize()
    from .school import migrate
    migrate()
    from .statistics_projects import restore_empty_project_workspaces
    restore_empty_project_workspaces()
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
    from .review_writes import ReviewWriter
    review_writer = ReviewWriter(database.ROOT, persistent=True)
    from .http_guard import Guard
    guard = Guard(database.ROOT)
    await asyncio.to_thread(guard.prepare_routes, app)
    await asyncio.to_thread(guard.start)
    app.state.http_guard = guard
    try:yield {'review_writer': review_writer}
    finally:
        stop.set()
        if recovery:recovery.join(timeout=1)
        await review_writer.close()
        await app.state.event_hub.stop()
        await asyncio.to_thread(app.state.request_journal.close)
        await asyncio.to_thread(guard.close)


app = FastAPI(title='Open Marking Platform',version='0.1.0',lifespan=lifespan)
from .web_static import WebStaticFiles, PublicAssetMiddleware
web_distribution=Path(__file__).resolve().parents[1]/'web'/'dist'
web_files=WebStaticFiles(web_distribution) if web_distribution.is_dir() else None
if web_files is not None:
    app.add_middleware(PublicAssetMiddleware, files=web_files)
from .paper_fonts import router as paper_fonts_router
app.include_router(paper_fonts_router)
from .request_log import RequestLogMiddleware
app.add_middleware(RequestLogMiddleware)
from .http_guard import HttpGuardMiddleware
app.add_middleware(HttpGuardMiddleware)

from .identifiers import InvalidIdentifier,IdentifierConflict,prepare_questions

@app.exception_handler(InvalidIdentifier)
async def invalid_identifier(request,error):
    return JSONResponse(status_code=422,content={'detail':str(error)})

@app.exception_handler(IdentifierConflict)
async def conflicting_identifier(request,error):
    return JSONResponse(status_code=409,content={'detail':str(error)})


from .dependencies import password_hash,user,admin,scan_user,scan_admin,require,scan_batch,set_request_actor


@app.get('/api/v1/system/build')
def system_build():
    path=web_distribution/'version.json'
    if not path.is_file():return JSONResponse({'detail':'前端尚未构建'},status_code=503,headers={'Cache-Control':'no-store'})
    return JSONResponse(json.loads(path.read_text(encoding='utf-8')),headers={'Cache-Control':'no-store'})


class Login(BaseModel):
    username: str = Field(min_length=1,max_length=100)
    password: str = Field(min_length=1,max_length=200)
    portal: str | None = None


class Account(Login):
    name: str = Field(min_length=1,max_length=100)
    role: str = 'teacher'


@app.get('/api/v1/auth/bootstrap-status')
def bootstrap_status():
    with connect() as db:
        available = db.execute('SELECT 1 FROM users LIMIT 1').fetchone() is None
    return JSONResponse({'available': available}, headers={'Cache-Control': 'no-store'})


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
    set_request_actor(request, {'id':identifier,'username':body.username,'role':'admin'})
    return {'status':'created'}


@app.post('/api/v1/auth/login')
def login(body: Login,request:Request=None):
    with connect() as db:
        row=db.execute('SELECT * FROM users WHERE username=?',(body.username,)).fetchone()
        stored=row['password'] if row else password_hash('invalid-password')
        if not hmac.compare_digest(stored,password_hash(body.password,stored.split(':')[0])) or row is None:
            raise HTTPException(401,'账号或密码错误')
        if body.portal not in (None,'admin','marking'):raise HTTPException(422,'登录入口无效')
        if body.portal=='admin' and row['role'] not in ('admin','manager'):raise HTTPException(403,'此账号没有管理后台权限，请切换为教师角色登录')
        from .accounts import session
        db.execute('BEGIN IMMEDIATE')
        value=session(db,dict(row),'password')
        set_request_actor(request, dict(row))
        return value


@app.get('/api/v1/auth/me')
def me(current=Depends(user)):
    return current


@app.get('/api/v1/users')
def users(current=Depends(admin)):
    with connect() as db:
        profiles={p['id']:p for p in objects(db,'teacher-profiles')}
        return [{**dict(r),'subjects':profiles.get(r['id'],{}).get('subjects',[]),'grade_ids':profiles.get(r['id'],{}).get('grade_ids',[]),'tags':profiles.get(r['id'],{}).get('tags',[])} for r in db.execute('SELECT id,username,name,role FROM users')]


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
from .exam_status import ExamStatusFilter, STATUS_FIELDS, project_views, filter_projects


def list_route(kind):
    def endpoint(current=Depends(scan_user if kind in ('projects','subjects','groups','templates','scan-batches') else user)):
        with connect() as db:
            if kind=='projects':db.execute('BEGIN')
            values=objects(db,kind)
            if kind=='projects':values=project_views(db,values)
            if kind=='groups':
                grades={g['id']:g['name'] for g in objects(db,'grades')}
                scanned={r[0] for r in db.execute('SELECT group_id FROM scanned_groups')}
                statistics_projects={p['id'] for p in find(db,'projects',category='statistics')}
                statistics_subjects={s['id'] for s in objects(db,'subjects') if s.get('project_id') in statistics_projects}
                values=[{**v,'grade_name':grades.get(v.get('grade_id'),''),'template_locked':v['id'] in scanned,
                         'statistics_mode':v.get('subject_id') in statistics_subjects} for v in values]
            if kind=='scan-batches':
                from .room_tags import view as room_view
                from .workflow import batch_progress
                values=[{**v,'room_tags':room_view(db,v.get('room_tags',[])),**batch_progress(db,v)} for v in values]
            if current['role'] in ('admin','manager'):
                return values
            if current['role']=='scanner':
                if kind=='scan-batches':return [v for v in values if v.get('scanner_device_id')==current['id']]
                if kind=='templates':return [{k:v[k] for k in ('id','name','group_id','paper','sides','status','revision','layout_version') if k in v} for v in values]
                fields={'projects':('id','name','status',*STATUS_FIELDS),'subjects':('id','name','project_id'),'groups':('id','name','subject_id','template_id','frozen','grade_id','grade_name')}
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
    if kind=='projects':
        def projects_endpoint(exam_status:ExamStatusFilter='all',current=Depends(scan_user)):
            return filter_projects(endpoint(current),exam_status)
        return projects_endpoint
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
            if kind=='projects':
                category=value.get('category','exam')
                if category not in ('exam','statistics'):raise HTTPException(422,'项目类别无效')
                value['category']=category
                value.pop('statistics_group_id',None)
                value['status']='draft'
                for field in STATUS_FIELDS:value.pop(field,None)
                value['exam_status_mode']='auto'
                value['created_at']=time.time()
            if kind=='subjects' and value.get('group_mode','custom') not in ('custom','default'):raise HTTPException(422,'分组方式无效')
            if kind=='groups':
                from .statistics_projects import is_statistics_group
                value['template_id']=None
                value.pop('statistics_group', None)
                value.setdefault('roster_mode','open')
                if value.get('template_creation','native') not in ('native','blank','completed'):
                    raise HTTPException(422,'制卡方式无效')
                if value.get('grade_id'):require(db,value['grade_id'],'grades')
                enabled=bool(value.pop('conversion_enabled',False))
                cid=value.get('conversion_id') or None
                if enabled or cid:
                    if is_statistics_group(db, value):raise HTTPException(422,'请选择考试项目设置赋分')
                    if not cid:raise HTTPException(422,'启用赋分时请选择赋分方案')
                    config=require(db,cid,'score-conversions')
                    value['conversion_mode']='override'
                    value['conversion_id']=cid
                    value['conversion_revision']=config.get('revision',1)
                else:
                    value['conversion_mode']='none'
                    value['conversion_id']=None
            if kind=='classes':
                from .school import assign_class
                assign_class(db,value,body,current['id'])
            if kind=='templates':
                group=require(db,value['group_id'],'groups')
                if group.get('statistics_group'):raise HTTPException(422,'请在统计项目中设计题卡')
                if group.get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
                value.pop('statistics_sheet',None)
                if value.get('paper') not in ('A3','A4') or value.get('sides') not in (1,2):
                    raise HTTPException(422,'纸型或单双面无效')
                value.update(revision=0,status='draft',layout_version=3)
                value.setdefault('notice_template','standard-v1')
                from .sheet_style import defaults
                defaults(value)
                prepare_questions(value)
                from .statistics_projects import set_template_mode
                set_template_mode(db,group,value)
            if kind=='assignments':
                template=require(db,value['template_id'],'templates')
                if template.get('statistics_mode') or template.get('statistics_sheet'):
                    raise HTTPException(422,'请选择考试题卡分配评阅')
                if not any(q['id']==value.get('question_id') for q in template['questions']): raise HTTPException(422,'题目不存在')
                ids=value.get('user_ids',[])
                if not ids or not isinstance(ids,list) or len(set(ids))!=len(ids): raise HTTPException(422,'请选择不重复的阅卷教师')
                for identifier in ids:
                    if not db.execute('SELECT 1 FROM users WHERE id=?',(identifier,)).fetchone(): raise HTTPException(422,'教师不存在')
                weights=value.get('weights',{})
                if not isinstance(weights,dict) or any(k not in ids or not isinstance(w,(int,float)) or not 0<=w<=255 for k,w in weights.items()): raise HTTPException(422,'教师权重应在0至255之间')
                arbitrators=value.get('arbitrator_ids',[])
                if not isinstance(arbitrators,list) or any(not db.execute('SELECT 1 FROM users WHERE id=?',(identifier,)).fetchone() for identifier in arbitrators):raise HTTPException(422,'仲裁教师无效')
                arb_weights=value.get('arbitrator_weights',{})
                if not isinstance(arb_weights,dict) or any(k not in arbitrators or type(w) not in (int,float) or not 0<=w<=255 for k,w in arb_weights.items()):
                    raise HTTPException(422,'仲裁权重应在0至255之间')
                from .allocation import validate as validate_assignment
                question=next(q for q in template['questions'] if q['id']==value['question_id'])
                if question['type']!='subjective':raise HTTPException(422,'客观题无需分配教师')
                validate_assignment(value,question)
                previous=[a for a in objects(db,'assignments') if a['template_id']==value['template_id'] and a['question_id']==value['question_id']]
                if previous: value['id']=previous[-1]['id']
            if kind=='students':
                from .candidate_numbers import validate
                validate(db,value.get('candidate_number'))
            if kind=='score-conversions':
                if value.get('project_id'):require(db,value['project_id'],'projects')
                from .conversion import validate_conversion
                if not isinstance(value.get('name'),str) or not 1<=len(value['name'].strip())<=100:raise HTTPException(422,'请填写100字以内方案名称')
                try: validate_conversion(value)
                except (ValueError,KeyError,TypeError) as error: raise HTTPException(422,str(error))
                value['revision']=1
            if kind=='scan-batches':
                if value.get('back_order','same') not in ('same','reverse') or not isinstance(value.get('room',''),str) or len(value.get('room',''))>100:raise HTTPException(422,'背面顺序或备注无效')
                value.setdefault('back_order','same')
                value.pop('scanner_device_id',None)
                if current['role']=='scanner':value['scanner_device_id']=current['id']
                group=require(db,value['group_id'],'groups')
                from .room_tags import snapshot,project_for_group
                tag_ids=value.pop('room_tag_ids',[])
                if not isinstance(tag_ids,list):raise HTTPException(422,'考场标签应为编号列表')
                value['room_tags']=snapshot(db,project_for_group(db,group['id']),tag_ids,group=group)
                if group.get('grade_id'):value['grade_id']=group['grade_id']
                if group.get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
                if not group.get('template_id'):
                    raise HTTPException(422,'请先发布题卡')
                template=require(db,group['template_id'],'templates')
                if template.get('statistics_mode') or statistics_sheet.enabled(template):
                    value['room']=''
                value.update(status='front',template_id=template['id'],template_revision=template['revision'])
            if kind=='subjects':
                from .electives import subject_tag
                tag=subject_tag(db,value['name'],current['id'])
                value.update(name=tag['name'],subject_tag_id=tag['id'])
            catalog_ids=value.pop('catalog_ids',[]) if kind=='projects' else []
            result=put(db,kind,value,current['id'])
            if kind=='projects' and catalog_ids:
                from .electives import create_exam_subjects
                create_exam_subjects(db,result,catalog_ids,current['id'])
            if kind=='subjects' and value.get('group_mode')=='default':
                from .templates import default_group
                group=default_group(db,result['id'],current['id']);result['default_group_id']=group['id']
            if kind=='assignments':
                from .allocation import ensure
                ensure(db,template,question,result)
            if kind=='projects':return project_views(db,[result])[0]
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
            pending=db.execute("SELECT COUNT(*) FROM objects WHERE kind='tasks' AND deleted=0 AND json_extract(body,'$.user_id')=? AND json_extract(body,'$.status')='claimed'",(current['id'],)).fetchone()[0]
            return {'groups':len({t['group_id'] for t in templates}),'pending_tasks':pending}
        counts=dict(db.execute("SELECT kind,COUNT(*) FROM objects WHERE deleted=0 AND kind IN ('projects','groups','students','exceptions') GROUP BY kind").fetchall())
        pending=db.execute("SELECT COUNT(*) FROM objects WHERE kind='tasks' AND deleted=0 AND COALESCE(json_extract(body,'$.status'),'')!='completed'").fetchone()[0]
        return {
            'projects':counts.get('projects',0),
            'groups':counts.get('groups',0),
            'students':counts.get('students',0),
            'exceptions':counts.get('exceptions',0),
            'pending_tasks':pending,
        }


@app.put('/api/v1/templates/{identifier}')
def edit_template(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        old=require(db,identifier,'templates')
        if old.get('statistics_sheet') or body.get('statistics_sheet'):raise HTTPException(422,'请在统计项目中设计题卡')
        if old['status'] in ('published','superseded'): raise HTTPException(409,'已发布版式不能直接编辑，请复制新题卡')
        if body.get('draft_version',0)!=old.get('draft_version',0):raise HTTPException(409,'草稿已更新，请重新载入后编辑')
        body={**old,**body,'id':identifier,'group_id':old['group_id'],'status':'draft','revision':old['revision'],'layout_version':3,'draft_version':old.get('draft_version',0)+1}
        body['external_trials']=old.get('external_trials',{}) if 'external_sheet' in body else None
        if body['external_trials'] is None:body.pop('external_trials')
        body.pop('draft_request_id',None);body.pop('draft_signature',None)
        body.setdefault('notice_template','standard-v1')
        from .sheet_style import defaults
        defaults(body)
        prepare_questions(body)
        from .statistics_projects import set_template_mode
        group=require(db,old['group_id'],'groups')
        set_template_mode(db,group,body)
        return put(db,'templates',body,current['id'])


@app.post('/api/v1/templates/{identifier}/publish')
def publish(identifier:str,body:dict|None=None,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        template=require(db,identifier,'templates')
        group=require(db,template['group_id'],'groups')
        if template['status']!='published':
            if group.get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE + '也可以选择其他题卡。')
            if template['status']!='draft':raise HTTPException(409,'请选择草稿发布')
            if group.get('template_id')!=(body or {}).get('replace_id'):
                raise HTTPException(409,'当前正式版本已变化，请重新载入后确认替换')
            from .templates import require_replaceable
            require_replaceable(db,group['id'])
        from .template_checks import issues,asset_ids
        if template['status']=='draft' and not group.get('statistics_group'):
            from .statistics_projects import set_template_mode
            set_template_mode(db,group,template)
        errors=issues(template,complete=True,require_answers=False)
        if errors:raise HTTPException(422,'；'.join(errors))
        if template['status']!='published' and template.get('external_sheet'):
            from .compatible_templates import trials_current
            if not trials_current(template):raise HTTPException(422,'请对当前标定配置逐面试扫并核对识读结果')
        try:assets=asset_ids(template)
        except (ValueError,KeyError,TypeError) as error:raise HTTPException(422,str(error))
        for asset_id in assets:require(db,asset_id,'assets')
        if template['status']!='published':
            versions=find(db,'templates',group_id=group['id'])
            if group.get('template_id'):
                previous=require(db,group['template_id'],'templates')
                put(db,'templates',{**previous,'status':'superseded'},current['id'])
            template.update(status='published',revision=max((v.get('revision',0) for v in versions),default=0)+1)
            put(db,'templates',template,current['id'])
            group=require(db,template['group_id'],'groups')
            group['template_id']=identifier
            if group.get('statistics_group'):
                group.update(statistics_external_draft_id=None,statistics_draft=None)
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
    if template['status']=='draft':
        from .template_checks import issues
        from .templates import check_assets
        if not paper.manual_binding(template):raise HTTPException(409,'请在制卡页保存当前版式后导出')
        errors=issues(template,complete=True,require_answers=False)
        if errors:raise HTTPException(422,'；'.join(errors))
        check_assets(template)
    elif template['status'] not in ('published','superseded'):
        raise HTTPException(409,'当前版式无法导出')
    try:content=paper.pdf(template)
    except ValueError as error:raise HTTPException(422,str(error))
    return Response(content,media_type='application/pdf',headers={'Content-Disposition':'attachment; filename=answer-sheet.pdf','Cache-Control':'private, no-store'})


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
        group=require(db,batch['group_id'],'groups')
        if group.get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
        if group.get('template_id')!=batch['template_id']:raise HTTPException(409,'本批次题卡已更换，请使用当前正式题卡新建批次')
        if batch['status'] in ('frozen','paired'): raise HTTPException(409,'批次已冻结或已确认')
        template=require(db,batch['template_id'],'templates')
        try:image,value=paper.decode(data,template)
        except ValueError as error:raise HTTPException(422,str(error))
        if side=='back' and template['sides']==1: raise HTTPException(422,'单面题卡不需要背面')
        if any(p['batch_id']==identifier and p['side']==side and p['sequence']==sequence and not p.get('excluded') for p in objects(db,'pages')): raise HTTPException(409,'该顺序已采集，请处理补扫')
        from .lifecycle import writable
        writable(db,'scan-batches',batch)
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
            from .jobs import create_job
            job=create_job(db,'process-page',{'page_id':capture_id})
        storage=database.ROOT/'pages';storage.mkdir(parents=True,exist_ok=True)
        path=storage/(capture_id+'.image');temporary=path.with_suffix('.tmp')
        try:
            temporary.write_bytes(data)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    if status==200:
        from .jobs import dispatch
        dispatch(job['id'])
        with connect() as db:page=require(db,capture_id,'pages')
    return JSONResponse(status_code=status,content={**page,'quality_review_required':bool(quality and quality['issues'])} if status==200 else {**page,'detail':'扫描中断：二维码不符，批次已冻结'})


@app.get('/api/v1/pages/{identifier}/image')
def page_image(identifier:str,current=Depends(admin)):
    with connect() as db: page=require(db,identifier,'pages')
    from .storage import materialize
    from .scan_files import normalized_relative
    try:path=materialize(normalized_relative(page))
    except FileNotFoundError:path=materialize('pages/'+identifier+'.image')
    return FileResponse(path)


@app.post('/api/v1/scan-batches/{identifier}/pair')
def pair(identifier:str,body:dict|None=Body(default=None),current=Depends(scan_admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        batch=scan_batch(db,identifier,current)
        if batch['status']=='frozen': raise HTTPException(409,'批次已冻结，请处理异常')
        if batch['status']=='paired': return batch
        if require(db,batch['group_id'],'groups').get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
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
        if not statistics_sheet.uses_candidate_number(template):
            from .statistics_projects import confirm
            page_sets=[[front]+([backs[i]] if template['sides']==2 else []) for i,front in enumerate(fronts)]
            local=[{'candidate_number':None,'pages':[p['id'] for p in pages]} for pages in page_sets]
            if body and 'local_pairs' in body and body['local_pairs']!=local:
                raise HTTPException(409,'本地配页清单与服务器页面记录不一致，请核查后重新确认')
            confirm(db,batch,template,page_sets,current['id'])
            return put(db,'scan-batches',{**batch,'status':'paired'},current['id'])
        numbers=[p['candidate_number'] for p in fronts]
        if any(not number or '?' in number for number in numbers) or len(set(numbers))!=len(numbers): raise HTTPException(409,'考号缺失或重复，请处理后配对')
        if body and 'local_pairs' in body:
            local=[{'candidate_number':front['candidate_number'],'pages':[front['id']]+([backs[i]['id']] if template['sides']==2 else [])} for i,front in enumerate(fronts)]
            if body['local_pairs']!=local:raise HTTPException(409,'本地配页清单与服务器页面记录不一致，请核查后重新确认')
        group=require(db,batch['group_id'],'groups')
        from .candidate_numbers import by_number,check_scanned_numbers
        from .school import group_students
        roster_students=group_students(db,group) or []
        is_open_roster=group.get('roster_mode')=='open' or not roster_students
        if is_open_roster:
            check_scanned_numbers(db,numbers)
            students=by_number(objects(db,'students'))
        elif group.get('grade_id') or group.get('roster_mode')=='selected':
            check_scanned_numbers(db,numbers)
            students=by_number(roster_students)
        else:
            students=by_number([*objects(db,'students'),*roster_students])
        if any(number not in students for number in numbers): raise HTTPException(409,'考号不在学生名单中')
        if any(students[number] is None for number in numbers):raise HTTPException(409,'准考证号对应多个学生，请先核对学生资料和应考名单')
        scanned_student_objs=[]
        for index,front in enumerate(fronts):
            student=students[front['candidate_number']]
            scanned_student_objs.append(student)
            from .student_history import snapshot
            student=snapshot(db,student)
            existing=find(db,'submissions',student_id=student['id'])
            if any(s['group_id']==group['id'] for s in existing):raise HTTPException(409,'已有该学生答卷，请明确执行补扫替换')
            if template.get('statistics_mode'):
                sibling_ids={item['id'] for item in find(db,'groups',subject_id=group['subject_id'])}
                if any(s['group_id'] in sibling_ids and s.get('pages') for s in existing):
                    raise HTTPException(409,'同一学生在本科目已有答卷，请核查题卡或执行补扫替换')
            absent=statistics_sheet.uses_absence_mark(template) and front.get('absent_mark')
            submission=put(db,'submissions',{'group_id':batch['group_id'],'template_id':template['id'],'student_id':student['id'],'student_snapshot':student,'room_tags':batch.get('room_tags',[]),'grade_id':batch.get('grade_id'),'candidate_number':front['candidate_number'],'pages':[front['id']]+([backs[index]['id']] if template['sides']==2 else []),'status':'absent' if absent else 'ready','attendance_source':'scan_mark' if absent else 'scan'},current['id'])
            from .answer_slices import sync
            submission=sync(db,submission,template,current['id'])
            from .anomalies import check_submission
            check_submission(db,submission,current['id'])
        if is_open_roster and scanned_student_objs:
            existing_map={s['id']:s for s in roster_students}
            for stu in scanned_student_objs:
                existing_map.setdefault(stu['id'],stu)
            merged_ids=list(existing_map.keys())
            old_roster=get(db,group.get('roster_id'),'rosters') or {}
            roster_body={'group_id':group['id'],'source':old_roster.get('source','scan'),'class_ids':[],'students':list(existing_map.values()),'student_ids':merged_ids,'supplemental_ids':old_roster.get('supplemental_ids',[])}
            if group.get('roster_id'):roster_body['id']=group['roster_id']
            saved_roster=put(db,'rosters',roster_body,current['id'])
            put(db,'groups',{**group,'roster_mode':'open','roster_id':saved_roster['id'],'expected_students':len(merged_ids)},current['id'])
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
from .result_reports import router as result_reports_router
app.include_router(result_reports_router)
from .paper_lesson import router as paper_lesson_router
app.include_router(paper_lesson_router)
from .roster import router as roster_router
app.include_router(roster_router)
from .release import router as release_router
app.include_router(release_router)
from .storage_jobs import router as storage_jobs_router
app.include_router(storage_jobs_router)
from .storage_connections import router as storage_connections_router
app.include_router(storage_connections_router)
from .system_storage import router as system_storage_router
app.include_router(system_storage_router)
from .alignment import router as alignment_router
app.include_router(alignment_router)
from .scanner_auth import router as scanner_auth_router
app.include_router(scanner_auth_router)
from .templates import router as templates_router
app.include_router(templates_router)
from .compatible_templates import router as compatible_templates_router
app.include_router(compatible_templates_router)
from .statistics_projects import router as statistics_projects_router
app.include_router(statistics_projects_router)
from .teacher_templates import router as teacher_templates_router
app.include_router(teacher_templates_router)
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

from .school import router as school_router
app.include_router(school_router)
from .tags import router as tags_router
app.include_router(tags_router)
from .student_import import router as student_import_router
app.include_router(student_import_router)

from .scoring_changes import router as scoring_changes_router
app.include_router(scoring_changes_router)

from .workflow import router as workflow_router
app.include_router(workflow_router)

from .teaching import router as teaching_router
app.include_router(teaching_router)
from .electives import router as electives_router
app.include_router(electives_router)

from .record_deletion import router as record_deletion_router
app.include_router(record_deletion_router)

from .login_footer import router as login_footer_router
app.include_router(login_footer_router)
from .exam_catalog import router as exam_catalog_router
app.include_router(exam_catalog_router)
from .exam_status import router as exam_status_router
app.include_router(exam_status_router)
from .selection_import import router as selection_import_router
app.include_router(selection_import_router)
from .http_guard_api import router as http_guard_router
app.include_router(http_guard_router)
from .http_guard_analytics import router as http_analytics_router
app.include_router(http_analytics_router)

from .gradebook import router as gradebook_router
app.include_router(gradebook_router)
from .conversion_bindings import router as conversion_bindings_router
app.include_router(conversion_bindings_router)

from .file_management import router as file_management_router
app.include_router(file_management_router)

from .workspace_activity import router as workspace_activity_router
app.include_router(workspace_activity_router)

from .comparison import router as comparison_router
app.include_router(comparison_router)

from .ai_admin import router as ai_admin_router
app.include_router(ai_admin_router)


@app.get('/marking', include_in_schema=False)
@app.get('/marking/{rest:path}', include_in_schema=False)
def redirect_marking(rest: str = ''):
    target = f'/#/marking/{rest}' if rest else '/#/marking'
    return RedirectResponse(url=target, status_code=302)


@app.get('/teacher', include_in_schema=False)
def redirect_teacher():
    return RedirectResponse(url='/#/marking', status_code=302)


if web_files is not None:
    app.mount('/',web_files,name='web')
