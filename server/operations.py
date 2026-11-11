import csv
import hashlib
import io
import json
import sqlite3
import time
import zipfile
import secrets
from uuid import uuid4
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse,Response
from . import db as database
from .db import connect,get,objects,put,find
from .dependencies import admin,user,require,password_hash
from .review import results

router=APIRouter(prefix='/api/v1')


@router.get('/jobs')
def jobs(project_id:str|None=None,current=Depends(admin)):
    with connect() as db:return find(db,'jobs',project_id=project_id) if project_id else objects(db,'jobs')


@router.get('/jobs/{identifier}')
def job_details(identifier:str,current=Depends(admin)):
    with connect() as db:return require(db,identifier,'jobs')


@router.post('/jobs/{identifier}/retry')
def retry_job(identifier:str,current=Depends(admin)):
    with connect() as db:
        job=require(db,identifier,'jobs')
        if job['status']=='completed' or job['status']=='running' and job['lease_until']>time.time():raise HTTPException(409,'任务已完成或正在执行')
        job.update(status='pending',available_at=0,lease_until=0,attempts=0);put(db,'jobs',job,current['id'])
    from .jobs import dispatch
    dispatch(identifier,background=True)
    with connect() as db:return require(db,identifier,'jobs')


@router.put('/groups/{identifier}/conversion')
def bind_conversion(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        if group.get('frozen'): raise HTTPException(409,'成绩已冻结，请先发起复核')
        conversion_id=body.get('conversion_id')
        if conversion_id:
            config=require(db,conversion_id,'score-conversions')
            from .conversion_routes import validate_existing
            validate_existing(db,group,config,current)
            group['conversion_revision']=config.get('revision',1)
        else:group.pop('conversion_revision',None)
        group.pop('conversion_snapshot',None)
        group['conversion_id']=conversion_id
        return put(db,'groups',group,current['id'])


@router.put('/classes/{identifier}')
def edit_class(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        item=require(db,identifier,'classes')
        for key in ('name','grade','teacher_ids'):
            if key in body: item[key]=body[key]
        if not str(item.get('name','')).strip(): raise HTTPException(422,'班级名称不能为空')
        for teacher in item.get('teacher_ids',[]):
            if not db.execute('SELECT 1 FROM users WHERE id=?',(teacher,)).fetchone(): raise HTTPException(422,'教师不存在')
        return put(db,'classes',item,current['id'])


@router.put('/students/{identifier}')
def edit_student(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        item=require(db,identifier,'students')
        for key in ('name','candidate_number','class_id'):
            if key in body: item[key]=body[key]
        require(db,item['class_id'],'classes')
        if not item.get('name') or not item.get('candidate_number'): raise HTTPException(422,'姓名及考号不能为空')
        if any(s['id']!=identifier and s['candidate_number']==item['candidate_number'] for s in objects(db,'students')): raise HTTPException(409,'准考证号已存在')
        return put(db,'students',item,current['id'])


@router.post('/classes/promote')
def promote(body:dict,current=Depends(admin)):
    with connect() as db:
        selected=body.get('class_ids',[])
        classes=[require(db,key,'classes') for key in selected]
        if not classes: raise HTTPException(422,'请选择班级')
        try: grades=[int(c['grade'])+1 for c in classes]
        except (ValueError,TypeError,KeyError): raise HTTPException(422,'年级应为数字；文字年级请单独修改')
        for item,grade in zip(classes,grades): item['grade']=grade; put(db,'classes',item,current['id'])
        return {'updated':len(classes)}


@router.post('/users/{identifier}/reset-password')
def reset_password(identifier:str,body:dict,current=Depends(admin)):
    password=body.get('password','')
    if not isinstance(password,str) or not 10<=len(password)<=200: raise HTTPException(422,'密码需10至200个字符')
    with connect() as db:
        if not db.execute('SELECT 1 FROM users WHERE id=?',(identifier,)).fetchone(): raise HTTPException(404,'账号不存在')
        db.execute('UPDATE users SET password=? WHERE id=?',(password_hash(password),identifier))
        db.execute('DELETE FROM sessions WHERE user_id=?',(identifier,))
        put(db,'account-events',{'user_id':identifier,'action':'password_reset'},current['id'])
    return {'status':'reset'}


@router.put('/users/{identifier}')
def edit_user(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        row=db.execute('SELECT id,username,name,role FROM users WHERE id=?',(identifier,)).fetchone()
        if not row: raise HTTPException(404,'账号不存在')
        value=dict(row)
        for key in ('name','role'):
            if key in body: value[key]=body[key]
        if value['role'] not in ('admin','teacher') or not value['name']: raise HTTPException(422,'姓名或角色无效')
        if row['role']=='admin' and value['role']!='admin' and db.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0]<=1: raise HTTPException(409,'至少保留一名管理员')
        db.execute('UPDATE users SET name=?,role=? WHERE id=?',(value['name'],value['role'],identifier))
        put(db,'account-events',{'user_id':identifier,'action':'profile_update','name':value['name'],'role':value['role']},current['id'])
        return value


def csv_cell(value):
    text=str(value if value is not None else '')
    return "'"+text if text.lstrip().startswith(('=','+','-','@')) else text


@router.get('/results/export')
def export_results(group_id:str,current=Depends(user)):
    rows=results(group_id,current)
    numbers=sorted({n for row in rows for n in row['scores']},key=lambda n:(len(n),n))
    output=io.StringIO(newline=''); writer=csv.writer(output)
    writer.writerow(['准考证号','姓名','班级','状态','总分','赋分']+[f'第{n}题' for n in numbers])
    from .analysis import STATUS_NAMES
    for row in rows: writer.writerow([csv_cell(STATUS_NAMES.get(row.get(key),row.get(key)) if key=='status' else row.get(key)) for key in ('candidate_number','name','class_id','status','total','converted_score')]+[row['scores'].get(n) for n in numbers])
    return Response(('\ufeff'+output.getvalue()).encode('utf-8'),media_type='text/csv; charset=utf-8',headers={'Content-Disposition':'attachment; filename=results.csv'})


@router.post('/projects/{identifier}/archive')
def archive(identifier:str,current=Depends(admin)):
    from .archive import create
    return create(identifier,current['id'])


@router.post('/archives/{identifier}/restore')
def restore_archive_files(identifier:str,current=Depends(admin)):
    from .archive import restore
    try:return restore(identifier,current['id'])
    except (ValueError,FileNotFoundError,zipfile.BadZipFile) as error:raise HTTPException(409,str(error))


@router.get('/archives')
def archive_list(current=Depends(admin)):
    with connect() as db: return objects(db,'archives')


@router.get('/archives/{identifier}/download')
def download_archive(identifier:str,current=Depends(admin)):
    with connect() as db: require(db,identifier,'archives')
    return FileResponse(database.ROOT/'archives'/(identifier+'.zip'),media_type='application/zip',filename='omp-project-'+identifier+'.zip')


@router.post('/archives/{identifier}/download-link')
def archive_download_link(identifier:str,current=Depends(admin)):
    with connect() as db:
        require(db,identifier,'archives')
        token=secrets.token_urlsafe(32)
        put(db,'download-tickets',{'token_hash':hashlib.sha256(token.encode()).hexdigest(),'archive_id':identifier,'user_id':current['id'],'expires_at':time.time()+300},current['id'])
    return {'url':'/api/v1/archive-download/'+token,'expires_in':300}


@router.get('/archive-download/{token}')
def stream_archive(token:str):
    with connect() as db:
        ticket=next((t for t in objects(db,'download-tickets') if t['token_hash']==hashlib.sha256(token.encode()).hexdigest() and t['expires_at']>time.time()),None)
        if not ticket:raise HTTPException(403,'下载链接已失效，请重新获取')
        require(db,ticket['archive_id'],'archives')
        path=database.ROOT/'archives'/(ticket['archive_id']+'.zip')
    if not path.exists():raise HTTPException(404,'归档文件不存在')
    return FileResponse(path,media_type='application/zip',filename='omp-project-'+ticket['archive_id']+'.zip',headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'})


@router.post('/system/backup')
def backup(current=Depends(admin)):
    from .backups import create
    return create(current['id'])


@router.get('/system/backups')
def backup_list(current=Depends(admin)):
    with connect() as db:
        return [{**record,'available':(database.ROOT/'backups'/(record['id']+'.sqlite3')).is_file()} for record in objects(db,'database-backups')]


@router.get('/system/backups/{identifier}/download')
def download_backup(identifier:str,current=Depends(admin)):
    from .backups import checksum
    with connect() as db:record=require(db,identifier,'database-backups')
    path=database.ROOT/'backups'/(record['id']+'.sqlite3')
    if not path.is_file():raise HTTPException(404,'备份文件不存在')
    if checksum(path)!=record['sha256']:raise HTTPException(409,'备份校验不一致')
    return FileResponse(path,media_type='application/vnd.sqlite3',filename='omp-'+record['id']+'.sqlite3',headers={'Cache-Control':'private, no-store'})
