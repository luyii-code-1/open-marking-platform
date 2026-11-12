import hashlib
import json
import time
from uuid import UUID,uuid4
import cv2
import numpy as np
from fastapi import APIRouter,Depends,HTTPException
from fastapi.responses import Response
from . import paper
from .db import connect,put,find
from .dependencies import admin,require
from .storage import local_path,materialize

router=APIRouter(prefix='/api/v1')


def load(identifier,rotation):
    if type(rotation) is not int or not 0<=rotation<=3:raise HTTPException(422,'旋转方向无效')
    with connect() as db:
        page=require(db,identifier,'pages');batch=require(db,page['batch_id'],'scan-batches');template=require(db,batch['template_id'],'templates')
    try:image,value=paper.decode(materialize('pages/'+identifier+'.image').read_bytes())
    except (ValueError,FileNotFoundError) as error:raise HTTPException(409,str(error))
    if rotation:image=np.ascontiguousarray(np.rot90(image,-rotation))
    return page,batch,template,image,value


def repeated(db,operation,identifier,fingerprint):
    row=db.execute('SELECT kind,body,deleted FROM objects WHERE id=?',(operation,)).fetchone()
    if not row:return False
    previous=json.loads(row['body'])
    if row['deleted'] or row['kind']!='page-alignments' or previous.get('page_id')!=identifier or previous.get('fingerprint')!=fingerprint:raise HTTPException(409,'操作UUID已用于其他内容')
    return True


@router.get('/pages/{identifier}/alignment')
def alignment_info(identifier:str,rotation:int=0,current=Depends(admin)):
    page,_,template,image,value=load(identifier,rotation)
    return {'id':identifier,'rotation':rotation,'width':image.shape[1],'height':image.shape[0],'paper':template['paper'],'side':page['side'],'status':page['status'],'qr_readable':bool(value),'qr_matches':value==paper.code(template,page['side']),'qr_conflict':value.startswith('OMP1:') and value!=paper.code(template,page['side']),'image_url':f'/api/v1/pages/{identifier}/alignment-source?rotation={rotation}'}


@router.get('/pages/{identifier}/alignment-source')
def alignment_source(identifier:str,rotation:int=0,current=Depends(admin)):
    _,_,_,image,_=load(identifier,rotation)
    return Response(cv2.imencode('.png',image)[1].tobytes(),media_type='image/png',headers={'Cache-Control':'private, no-store'})


@router.post('/pages/{identifier}/align')
def align_page(identifier:str,body:dict,current=Depends(admin)):
    if not str(body.get('reason','')).strip():raise HTTPException(422,'请填写人工定位原因')
    if not isinstance(body.get('corners'),list) or len(body['corners'])!=4:raise HTTPException(422,'请选择四个定位点')
    try:UUID(body.get('request_id',''))
    except (ValueError,TypeError,AttributeError):raise HTTPException(422,'需要有效的操作UUID')
    fingerprint=hashlib.sha256(json.dumps({k:body.get(k) for k in ('corners','rotation','reason','confirm_template')},sort_keys=True).encode()).hexdigest()
    with connect() as db:
        if repeated(db,body['request_id'],identifier,fingerprint):return require(db,identifier,'pages')
    page,batch,template,image,value=load(identifier,body.get('rotation',0))
    if value.startswith('OMP1:') and value!=paper.code(template,page['side']):raise HTTPException(409,'原图二维码属于其他考卷或面，请排除混卷后处理')
    if value!=paper.code(template,page['side']) and body.get('confirm_template') is not True:raise HTTPException(422,'缺少可匹配的题卡二维码，需人工确认所选考卷和正反面')
    try:normalized,candidate,selections=paper.recognize(image,template,page['side'],body['corners'])
    except (ValueError,KeyError,TypeError) as error:raise HTTPException(422,str(error))
    content=cv2.imencode('.png',normalized)[1].tobytes();path=local_path('pages/'+identifier+'.png')
    temporary=path.with_name(identifier+'.'+str(uuid4())+'.tmp.png');temporary.parent.mkdir(parents=True,exist_ok=True);temporary.write_bytes(content)
    old_asset=None;old_content=None;replaced=False
    try:
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if repeated(db,body['request_id'],identifier,fingerprint):return require(db,identifier,'pages')
            page=require(db,identifier,'pages');batch=require(db,page['batch_id'],'scan-batches');group=require(db,batch['group_id'],'groups')
            from .lifecycle import writable
            writable(db,'pages',page)
            if group.get('frozen') or batch['status']=='paired':raise HTTPException(409,'已配对或发布的页面请使用补扫替换，发布后需先复核')
            if page['status']=='received':raise HTTPException(425,'页面正在识别，请稍后再调整')
            if path.exists():
                old_content=path.read_bytes();asset_id=str(uuid4());asset_path=local_path('assets/'+asset_id+'.png');asset_path.parent.mkdir(parents=True,exist_ok=True);asset_path.write_bytes(old_content)
                old_asset=put(db,'assets',{'id':asset_id,'width':normalized.shape[1],'height':normalized.shape[0],'sha256':hashlib.sha256(old_content).hexdigest(),'purpose':'alignment_history','image_url':f'/api/v1/assets/{asset_id}'},current['id'])
            temporary.replace(path);replaced=True
            put(db,'page-alignments',{'id':body['request_id'],'page_id':identifier,'fingerprint':fingerprint,'corners':body['corners'],'rotation':body.get('rotation',0),'reason':body['reason'],'previous_asset_id':old_asset['id'] if old_asset else None,'previous_recognition':{k:page.get(k) for k in ('candidate_number','selections','absent_mark','status')},'created_at':time.time()},current['id'])
            page.update(status='recognized',candidate_number=candidate,selections=selections,absent_mark=paper.absent_mark(normalized,page['side'],template),normalized_sha256=hashlib.sha256(content).hexdigest(),alignment_request_id=body['request_id'],alignment_reason=body['reason'])
            if old_asset:page.setdefault('alignment_history',[]).append(old_asset['id'])
            result=put(db,'pages',page,current['id'])
            for issue in find(db,'exceptions',page_id=identifier):
                if issue['status']=='open' and issue['kind'] in ('recognition','wrong_paper'):
                    issue.update(status='resolved',resolution='人工确认考卷并完成四点定位和重新识读',resolved_at=time.time());put(db,'exceptions',issue,current['id'])
            from .anomalies import check_candidate
            check_candidate(db,page,current['id'])
    except Exception:
        if replaced:
            if old_content is None:path.unlink(missing_ok=True)
            else:temporary.write_bytes(old_content);temporary.replace(path)
        raise
    finally:temporary.unlink(missing_ok=True)
    from .jobs import queue
    queue('mirror',{'relative':'pages/'+identifier+'.png'})
    if old_asset:queue('mirror',{'relative':'assets/'+old_asset['id']+'.png'})
    return result
