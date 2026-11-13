import io
import hashlib
import time
from pathlib import Path
from uuid import uuid4
from fastapi import APIRouter,Depends,HTTPException,File,UploadFile
from fastapi.responses import FileResponse
from PIL import Image
from . import db as database
from .db import connect,objects,put,find
from .dependencies import admin,require
from .answer_slices import sync as sync_answer_slices

router=APIRouter(prefix='/api/v1')


@router.get('/submissions/{identifier}/objective')
def objective_answers(identifier:str,current=Depends(admin)):
    with connect() as db:
        submission=require(db,identifier,'submissions');template=require(db,submission['template_id'],'templates')
        pages=[require(db,p,'pages') for p in submission['pages']]
        output=[]
        for q in template['questions']:
            if q['type']=='subjective':continue
            original=sorted({a for p in pages for a in p.get('selections',{}).get(q['id'],[])})
            output.append({'id':q['id'],'number':q['number'],'options':q.get('options',4),'original':original,'selected':submission.get('objective_overrides',{}).get(q['id'],original)})
        return output


@router.put('/submissions/{identifier}/objective')
def correct_objective(identifier:str,body:dict,current=Depends(admin)):
    reason(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        submission=require(db,identifier,'submissions');group=require(db,submission['group_id'],'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核')
        if submission['status']=='absent':raise HTTPException(409,'缺考答卷不能修改选项')
        template=require(db,submission['template_id'],'templates')
        questions={q['id']:q for q in template['questions'] if q['type']!='subjective'}
        changes=body.get('selections')
        if not isinstance(changes,dict) or not changes:raise HTTPException(422,'请提供需更正的客观题选项')
        for qid,answers in changes.items():
            if qid not in questions or not isinstance(answers,list) or any(not isinstance(a,str) or a not in 'ABCDE'[:questions[qid].get('options',4)] or len(a)!=1 for a in answers):raise HTTPException(422,'题目或选项无效')
        submission.setdefault('objective_overrides',{}).update({k:sorted(set(v)) for k,v in changes.items()})
        submission['objective_correction_reason']=body['reason']
        from .anomalies import check_submission
        check_submission(db,submission,current['id'])
        return sync_answer_slices(db,put(db,'submissions',submission,current['id']),template,current['id'])


def reason(body):
    if not str(body.get('reason','')).strip(): raise HTTPException(422,'请填写操作原因')


def invalidate(db,submission,question_ids,actor):
    for question_id in question_ids:
        db.execute('DELETE FROM review_results WHERE submission_id=? AND question_id=?',(submission['id'],question_id))
        db.execute('DELETE FROM allocation_state WHERE question_id=?',(question_id,))
    for task in objects(db,'tasks'):
        if task['submission_id']==submission['id'] and task['question_id'] in question_ids and task['status'] not in ('invalidated','expired'):
            db.execute('DELETE FROM regrade_queue WHERE task_id=?',(task['id'],))
            task.update(status='invalidated',invalidated_at=time.time())
            put(db,'tasks',task,actor)


@router.get('/submissions')
def submissions(group_id:str,current=Depends(admin)):
    with connect() as db:
        require(db,group_id,'groups')
        return [s for s in objects(db,'submissions') if s['group_id']==group_id]


@router.put('/pages/{identifier}')
def correct_page(identifier:str,body:dict,current=Depends(admin)):
    reason(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        page=require(db,identifier,'pages'); batch=require(db,page['batch_id'],'scan-batches')
        if batch['status']=='paired': raise HTTPException(409,'已配对页面请使用答卷补扫替换')
        if 'excluded' in body: page['excluded']=bool(body['excluded'])
        if 'sequence' in body:
            number=body['sequence']
            if not isinstance(number,int) or number<1: raise HTTPException(422,'序号无效')
            if any(p['id']!=identifier and p['batch_id']==page['batch_id'] and p['side']==page['side'] and not p.get('excluded') and p['sequence']==number for p in objects(db,'pages')): raise HTTPException(409,'序号已被占用，请先排除待替换页')
            page['sequence']=number
        if 'candidate_number' in body:
            candidate=body['candidate_number']
            if not isinstance(candidate,str) or not candidate.isdigit(): raise HTTPException(422,'考号需为数字字符串')
            known={s['candidate_number'] for s in objects(db,'students')}
            group=require(db,batch['group_id'],'groups')
            if group.get('grade_id') or group.get('roster_mode')=='selected':
                from .school import group_students
                known={s['candidate_number'] for s in group_students(db,group)}
            elif group.get('roster_id'):known.update(s['candidate_number'] for s in require(db,group['roster_id'],'rosters')['students'])
            if candidate not in known: raise HTTPException(422,'考号不在学生名单中')
            page['candidate_number']=candidate
        if 'selections' in body:
            template=require(db,batch['template_id'],'templates')
            by_id={q['id']:q for q in template['questions'] if q['type']!='subjective'}
            selections=body['selections']
            if not isinstance(selections,dict): raise HTTPException(422,'选项数据无效')
            for qid,answers in selections.items():
                if qid not in by_id or not isinstance(answers,list) or not set(answers)<=set('ABCDE'[:by_id[qid].get('options',4)]): raise HTTPException(422,'选项超出题目范围')
            page['selections']={**page.get('selections',{}),**selections}
        if 'absent_mark' in body:
            if page['side']!='front' or type(body['absent_mark']) is not bool:raise HTTPException(422,'缺考标记只用于正面，值需为布尔值')
            page['absent_mark']=body['absent_mark'];page['absent_mark_corrected']=True
        page['correction_reason']=body['reason']
        from .anomalies import check_candidate
        check_candidate(db,page,current['id'])
        return put(db,'pages',page,current['id'])


@router.post('/scan-batches/{identifier}/resume')
def resume_batch(identifier:str,body:dict,current=Depends(admin)):
    reason(body)
    with connect() as db:
        batch=require(db,identifier,'scan-batches')
        if batch['status']=='paired': raise HTTPException(409,'已配对批次不能继续采集')
        if any(e.get('source')=='scanner' and e.get('status')=='open' for e in find(db,'exceptions',batch_id=identifier)):raise HTTPException(409,'请先核查扫描端报告的页面质量异常')
        if any(p['batch_id']==identifier and p['status']=='quarantined' and not p.get('excluded') for p in objects(db,'pages')): raise HTTPException(409,'请先排除混入的其他考卷页面')
        batch.update(status='front',resume_reason=body['reason'])
        return put(db,'scan-batches',batch,current['id'])


@router.post('/groups/{identifier}/reopen')
def reopen(identifier:str,body:dict,current=Depends(admin)):
    reason(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        group=require(db,identifier,'groups')
        subject=database.get(db,group.get('subject_id'),'subjects')
        project=database.get(db,(subject or {}).get('project_id'),'projects')
        if (project or {}).get('storage_operation',{}).get('until',0)>time.time():raise HTTPException(409,'项目正在处理扫描文件，请完成后再复核')
        group.pop('scan_close',None)
        group.update(frozen=False,reopen_reason=body['reason'],reopened_at=time.time())
        return put(db,'groups',group,current['id'])


@router.post('/submissions/{identifier}/replace-page')
def replace_page(identifier:str,body:dict,current=Depends(admin)):
    reason(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        submission=require(db,identifier,'submissions'); group=require(db,submission['group_id'],'groups')
        if group.get('frozen'): raise HTTPException(409,'成绩已冻结，请先发起复核')
        try: index=int(body['page'])-1
        except (KeyError,ValueError,TypeError): raise HTTPException(422,'页码无效')
        if not 0<=index<len(submission['pages']): raise HTTPException(422,'页码超出范围')
        page=require(db,body.get('page_id'),'pages'); batch=require(db,page['batch_id'],'scan-batches')
        if batch['template_id']!=submission['template_id'] or page['status']!='recognized' or page.get('excluded') or page['side']!=('front' if index==0 else 'back'): raise HTTPException(409,'替换页与答卷版式或面不一致')
        if index==0 and page.get('candidate_number')!=submission['candidate_number']: raise HTTPException(409,'替换页考号不符')
        if any(page['id'] in s['pages'] for s in objects(db,'submissions')): raise HTTPException(409,'替换页面已被其他答卷使用')
        template=require(db,submission['template_id'],'templates')
        affected={q['id'] for q in template['questions'] if any(int(r['page'])==index+1 for r in q['regions'])}
        invalidate(db,submission,affected,current['id'])
        submission.setdefault('page_history',[]).append({'page':index+1,'old_page_id':submission['pages'][index],'new_page_id':page['id'],'reason':body['reason'],'at':time.time()})
        submission['pages'][index]=page['id']; submission['status']='ready'
        from .room_tags import from_pages
        submission['room_tags']=from_pages(db,submission['pages'])
        page['linked_submission_id']=identifier;put(db,'pages',page,current['id'])
        from .anomalies import check_submission
        check_submission(db,submission,current['id'])
        return sync_answer_slices(db,put(db,'submissions',submission,current['id']),template,current['id'])


@router.post('/groups/{identifier}/absent')
def mark_absent(identifier:str,body:dict,current=Depends(admin)):
    reason(body)
    with connect() as db:
        group=require(db,identifier,'groups')
        if group.get('frozen'): raise HTTPException(409,'成绩已冻结')
        student=require(db,body.get('student_id'),'students')
        from .school import group_students
        members=group_students(db,group)
        if (group.get('grade_id') or group.get('roster_mode')=='selected') and not any(s['id']==student['id'] for s in members):raise HTTPException(422,'学生不在本题卡应考名单中')
        if not group.get('grade_id') and members is not None:student=next((s for s in members if s['id']==student['id']),student)
        from .student_history import snapshot
        student=snapshot(db,student)
        template=require(db,group.get('template_id'),'templates')
        if any(s['group_id']==identifier and s['student_id']==student['id'] for s in objects(db,'submissions')): raise HTTPException(409,'该考生已有答卷记录')
        raise HTTPException(409,'未扫描学生保留未扫描状态，请扫描已填涂缺考标记的题卡')


@router.post('/submissions/{identifier}/attach-pages')
def attach_pages(identifier:str,body:dict,current=Depends(admin)):
    reason(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        submission=require(db,identifier,'submissions');group=require(db,submission['group_id'],'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核')
        if submission['status']!='absent':raise HTTPException(409,'整卷补齐用于更正缺考记录；已有实考请使用补扫替换')
        template=require(db,submission['template_id'],'templates');ids=body.get('page_ids')
        if not isinstance(ids,list) or any(not isinstance(i,str) for i in ids) or len(ids)!=template['sides'] or len(set(ids))!=len(ids):raise HTTPException(422,'请按正面、背面顺序选齐整卷')
        used={p for s in objects(db,'submissions') if s['id']!=identifier for p in s['pages']}
        for index,pid in enumerate(ids):
            page=require(db,pid,'pages');batch=require(db,page['batch_id'],'scan-batches')
            if pid in used or batch['template_id']!=template['id'] or page['status']!='recognized' or page.get('excluded') or page['side']!=('front' if index==0 else 'back'):raise HTTPException(409,'补齐页面的题卡、面、状态或归属不符')
            if index==0 and page.get('candidate_number')!=submission['candidate_number']:raise HTTPException(409,'补齐页面考号不符')
            page['linked_submission_id']=identifier;put(db,'pages',page,current['id'])
        invalidate(db,submission,{q['id'] for q in template['questions']},current['id'])
        submission.setdefault('page_history',[]).append({'old_pages':submission['pages'],'new_pages':ids,'reason':body['reason'],'at':time.time()})
        from .room_tags import from_pages
        submission.update(room_tags=from_pages(db,ids),pages=ids,status='ready',attendance_source='manual',attendance_reason=body['reason'])
        from .anomalies import check_submission
        check_submission(db,submission,current['id'])
        return sync_answer_slices(db,put(db,'submissions',submission,current['id']),template,current['id'])


@router.put('/submissions/{identifier}/attendance')
def correct_attendance(identifier:str,body:dict,current=Depends(admin)):
    reason(body)
    if type(body.get('absent')) is not bool:raise HTTPException(422,'请明确选择缺考或实考')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        submission=require(db,identifier,'submissions');group=require(db,submission['group_id'],'groups')
        if group.get('frozen'):raise HTTPException(409,'成绩已冻结，请先发起复核')
        template=require(db,submission['template_id'],'templates')
        status='absent' if body['absent'] else 'ready'
        if body['absent'] and not submission.get('pages'):raise HTTPException(409,'请先扫描题卡后核对缺考标记')
        if not body['absent']:
            if len(submission['pages'])!=template['sides'] or any(require(db,p,'pages')['status']!='recognized' for p in submission['pages']):raise HTTPException(409,'恢复实考需先补齐可识读的完整答卷')
        if submission['status']==status:return submission
        invalidate(db,submission,{q['id'] for q in template['questions']},current['id'])
        submission.update(status=status,attendance_source='manual',attendance_reason=body['reason'])
        from .anomalies import check_submission
        check_submission(db,submission,current['id'])
        return put(db,'submissions',submission,current['id'])


@router.post('/assets')
def upload_asset(file:UploadFile=File(),current=Depends(admin)):
    data=file.file.read(30*1024*1024+1)
    if len(data)>30*1024*1024: raise HTTPException(413,'图片超过30MB')
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.width*source.height>40_000_000: raise ValueError('图片超过4000万像素')
            normalized=source.convert('RGB'); normalized.load()
    except Exception as error: raise HTTPException(422,'无法读取图片：'+str(error))
    identifier=str(uuid4()); directory=database.ROOT/'assets'; directory.mkdir(parents=True,exist_ok=True)
    normalized.save(directory/(identifier+'.png'))
    with (directory/(identifier+'.png')).open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    with connect() as db: result=put(db,'assets',{'id':identifier,'width':normalized.width,'height':normalized.height,'sha256':digest,'image_url':f'/api/v1/assets/{identifier}'},current['id'])
    from .jobs import queue
    queue('mirror',{'relative':'assets/'+identifier+'.png'})
    return result


@router.get('/assets/{identifier}')
def asset(identifier:str,current=Depends(admin)):
    with connect() as db: require(db,identifier,'assets')
    from .storage import materialize
    return FileResponse(materialize('assets/'+identifier+'.png'))


@router.put('/submissions/{identifier}/regions/{question_id}')
def override_regions(identifier:str,question_id:str,body:dict,current=Depends(admin)):
    reason(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        submission=require(db,identifier,'submissions'); group=require(db,submission['group_id'],'groups')
        if group.get('frozen'): raise HTTPException(409,'成绩已冻结，请先复核')
        template=require(db,submission['template_id'],'templates')
        question=next((q for q in template['questions'] if q['id']==question_id),None)
        if not question or question['type']!='subjective': raise HTTPException(422,'请选择主观题')
        if body.get('asset_id'):
            require(db,body['asset_id'],'assets')
            override={'asset_id':body['asset_id']}
        else:
            from .paper import dimensions
            regions=body.get('regions',[])
            if not regions: raise HTTPException(422,'至少框选一个区域')
            try:
                width,height=dimensions(template)
                for r in regions:
                    if not 1<=int(r['page'])<=len(submission['pages']) or min(r['x'],r['y'])<0 or min(r['width'],r['height'])<=0 or r['x']+r['width']>width or r['y']+r['height']>height: raise ValueError('框选区域超出答卷')
            except (ValueError,KeyError,TypeError) as error: raise HTTPException(422,str(error))
            override={'regions':regions}
        submission.setdefault('region_overrides',{})[question_id]=override
        invalidate(db,submission,{question_id},current['id'])
        return sync_answer_slices(db,put(db,'submissions',submission,current['id']),template,current['id'])


@router.get('/submissions/{identifier}/answer-slices')
def answer_slices(identifier:str,history:bool=False,current=Depends(admin)):
    with connect() as db:
        require(db,identifier,'submissions')
        return [r for r in find(db,'answer-slices',submission_id=identifier) if history or r['status']=='current']
