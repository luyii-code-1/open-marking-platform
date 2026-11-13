"""Authorized full-page delivery and client display regions for review tasks."""
from fastapi import HTTPException
from fastapi.responses import FileResponse
from .db import connect,get,find
from .dependencies import require
from .storage import expected_hash,for_reference,materialize


def sources(identifier,current):
    from .review import own_task,question_for
    from .omr import dimensions
    with connect() as db:
        task=own_task(db,identifier,current)
        submission=require(db,task['submission_id'],'submissions')
        template,question=question_for(db,task['template_id'],task['question_id'])
        answer=get(db,task.get('answer_slice_id'),'answer-slices')
        override=submission.get('region_overrides',{}).get(question['id'],{})
        asset=answer.get('asset_id') if answer else override.get('asset_id')
        group=require(db,template['group_id'],'groups');subject=require(db,group['subject_id'],'subjects')
        project=require(db,subject['project_id'],'projects')
        mode=project.get('review_image_delivery','direct')
        rows=[]
        if asset:rows=[{'relative':'assets/'+asset+'.png','rect':None}]
        else:
            regions=answer['sources'] if answer else [{'region':r} for r in override.get('regions',question['regions'])]
            width,height=dimensions(template)
            for source in regions:
                region=source['region'];index=int(region['page'])-1
                if not 0<=index<len(submission['pages']):raise HTTPException(409,'答卷缺页')
                page_id=source.get('page_id',submission['pages'][index]);page=require(db,page_id,'pages')
                expected=source.get('normalized_sha256')
                if expected and page.get('normalized_sha256')!=expected:raise HTTPException(409,'答卷图片已更新，请重新领取任务')
                x,y,w,h=(region[k]*4 for k in ('x','y','width','height'))
                rows.append({'relative':'pages/'+page_id+'.png','rect':[int(x),int(y),int(x+w)-int(x),int(y+h)-int(y)],'width':width*4,'height':height*4})
        if not rows:raise HTTPException(409,'题目没有答题区')
        for row in rows:row['sha256']=expected_hash(db,row['relative'])
        return mode,rows


def manifest(identifier,current):
    mode,rows=sources(identifier,current);pages=[];regions=[];indexes={}
    for row in rows:
        key=(row['relative'],row['sha256'])
        if key not in indexes:
            index=len(pages);indexes[key]=index
            from urllib.parse import urlencode
            item={k:row[k] for k in ('width','height','sha256') if k in row}
            item['proxy_url']=f'/tasks/{identifier}/image-source/{index}?'+urlencode({'version':row['sha256'] or ''})
            item['key']=row['relative']+':'+(row['sha256'] or '')
            if mode=='direct' and row['sha256']:
                with connect() as db:references=[r for r in find(db,'storage-assets',relative=row['relative']) if r.get('status')=='stored' and r.get('sha256')==row['sha256']]
                for reference in references:
                    try:
                        url=for_reference(reference).signed_url(reference['key'],expires=120)
                        if url:item.update(direct_url=url,expires_in=120);break
                    except Exception:continue
            pages.append(item)
        regions.append({'page':indexes[key],'rect':row['rect']})
    return {'delivery':mode,'pages':pages,'regions':regions}


def proxy(identifier,index,version,current):
    _,rows=sources(identifier,current)
    unique=list({(r['relative'],r['sha256']):r for r in rows}.values())
    if index<0 or index>=len(unique):raise HTTPException(404,'题图不存在')
    row=unique[index]
    if version!=(row['sha256'] or ''):raise HTTPException(409,'答卷图片已更新，请重新加载')
    try:path=materialize(row['relative'])
    except FileNotFoundError:raise HTTPException(409,'校正图尚未就绪')
    return FileResponse(path,media_type='image/png',headers={'Cache-Control':'private, no-store'})
