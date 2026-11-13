import shutil
import subprocess
import tempfile
import threading
from copy import deepcopy
from pathlib import Path
from uuid import uuid4
from fastapi import APIRouter,Depends,HTTPException
from fastapi.responses import Response
from . import paper
from .db import connect,get,find,objects,put
from .dependencies import admin,require
from .template_checks import issues,asset_ids
from .identifiers import prepare_questions

router=APIRouter(prefix='/api/v1')
_render_slots=threading.BoundedSemaphore(2)
DEFINITION_FIELDS=('name','subtitle','paper','sides','candidate_length','layout_version','sheet_columns','notice_template','print_style','forbidden_regions','background_assets','background_asset_id','questions')


def default_group(db,subject_id,actor):
    subject=require(db,subject_id,'subjects')
    existing=get(db,subject.get('default_group_id'),'groups')
    if existing and existing.get('subject_id')==subject_id:return existing
    matches=find(db,'groups',subject_id=subject_id)
    existing=next((g for g in matches if g.get('is_default') or g.get('name')=='Default'),None)
    group=existing or put(db,'groups',{'subject_id':subject_id,'name':'Default','is_default':True,'template_id':None},actor)
    subject['default_group_id']=group['id'];put(db,'subjects',subject,actor)
    return group


@router.post('/subjects/{identifier}/default-group')
def ensure_default_group(identifier:str,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        return default_group(db,identifier,current['id'])


@router.get('/template-library')
def library(current=Depends(admin)):
    with connect() as db:return objects(db,'template-library')


@router.post('/templates/{identifier}/save-to-library')
def save_to_library(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        source=require(db,identifier,'templates')
        name=body.get('name',source['name']);description=body.get('description','')
        if not isinstance(name,str) or not 1<=len(name.strip())<=100 or not isinstance(description,str) or len(description)>2000:raise HTTPException(422,'请填写100字以内名称与2000字以内说明')
        errors=issues(source)
        if errors:raise HTTPException(422,'；'.join(errors))
        try:assets=asset_ids(source)
        except (ValueError,KeyError,TypeError) as error:raise HTTPException(422,str(error))
        for asset in assets:require(db,asset,'assets')
        definition=deepcopy({k:source[k] for k in DEFINITION_FIELDS if k in source})
        for question in definition.get('questions',[]):question.pop('id',None)
        return put(db,'template-library',{'name':name.strip(),'description':description,'source_template_id':identifier,'definition':definition},current['id'])


@router.post('/template-library/{identifier}/instantiate')
def instantiate(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        entry=require(db,identifier,'template-library')
        group=require(db,body['group_id'],'groups') if body.get('group_id') else default_group(db,body.get('subject_id'),current['id'])
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核或选择新的题卡组')
        definition=deepcopy(entry['definition'])
        name=body.get('name',entry['name'])
        if not isinstance(name,str) or not 1<=len(name.strip())<=100:raise HTTPException(422,'请填写100字以内题卡标题')
        definition.update(name=name.strip(),group_id=group['id'],revision=0,status='draft',layout_version=3,library_id=identifier)
        definition.setdefault('notice_template','standard-v1')
        from .sheet_style import defaults
        defaults(definition)
        prepare_questions(definition)
        return put(db,'templates',definition,current['id'])


def check_assets(template):
    try:values=asset_ids(template)
    except (ValueError,KeyError,TypeError) as error:raise HTTPException(422,str(error))
    with connect() as db:
        for value in values:require(db,value,'assets')


@router.post('/templates/check')
def check_template(body:dict,current=Depends(admin)):
    errors=issues(body,complete=True)
    if not errors:
        try:check_assets(body)
        except HTTPException as error:errors.append(str(error.detail))
    return {'valid':not errors,'issues':errors}


@router.post('/templates/objective-preview')
def objective_preview(body:dict,current=Depends(admin)):
    from .scoring import objective_score
    if not isinstance(body.get('question'),dict):raise HTTPException(422,'题目配置应为对象')
    question={**body.get('question',{}),'regions':[]}
    errors=issues({'name':'规则试算','paper':'A4','sides':1,'questions':[question]})
    selected=body.get('selected',[])
    if question.get('type') not in ('single','multiple'):errors.append('请选择客观题')
    count=question.get('options',4);count=count if type(count) is int and count in (3,4,5) else 0
    if not isinstance(selected,list) or any(not isinstance(s,str) or s not in 'ABCDE'[:count] for s in selected) or len(set(selected))!=len(selected):errors.append('试算选项无效')
    if question.get('type')=='single' and len(selected)>1:errors.append('单选题只能选择一个选项')
    if not question.get('answer'):errors.append('请先填写标准答案')
    if errors:raise HTTPException(422,'；'.join(errors))
    return {'score':objective_score(selected,question['answer'],question['points'],question.get('rule'))/100,'maximum':question['points']}


@router.post('/templates/preview')
def preview_template(body:dict,page:int=1,current=Depends(admin)):
    errors=issues(body)
    if errors:raise HTTPException(422,'；'.join(errors))
    if not 1<=page<=body['sides']:raise HTTPException(422,'预览页码超出题卡范围')
    check_assets(body)
    template={**body,'id':body.get('id') or str(uuid4()),'revision':body.get('revision',0),'layout_version':body.get('layout_version',3)}
    renderer=shutil.which('pdftoppm')
    if not renderer:raise HTTPException(503,'PDF预览需要服务器安装Poppler的pdftoppm')
    if not _render_slots.acquire(blocking=False):raise HTTPException(503,'预览正在生成，请稍后更新',headers={'Retry-After':'1'})
    try:
        with tempfile.TemporaryDirectory(prefix='omp-preview-') as directory:
            root=Path(directory);source=root/'sheet.pdf'
            try:source.write_bytes(paper.pdf(template))
            except (ValueError,TypeError,KeyError,OverflowError) as error:raise HTTPException(422,str(error))
            try:
                rendered=subprocess.run([renderer,'-r','110','-f',str(page),'-l',str(page),'-singlefile','-png',str(source),str(root/'preview')],capture_output=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess,'CREATE_NO_WINDOW') else 0)
            except subprocess.TimeoutExpired:raise HTTPException(503,'PDF预览生成超时，请稍后更新')
            if rendered.returncode or not (root/'preview.png').exists():raise HTTPException(503,'PDF预览生成失败，请检查服务器的PDF渲染工具')
            return Response((root/'preview.png').read_bytes(),media_type='image/png',headers={'Cache-Control':'private, no-store'})
    finally:_render_slots.release()
