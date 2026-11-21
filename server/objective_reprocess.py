"""Re-read objective bubbles while preserving identities and manual scoring."""
import numpy as np
from fastapi import HTTPException
from .lifecycle import RESULTS_REVIEW_GUIDE
from .db import connect,find,get,put
from .dependencies import require
from .lifecycle import writable
from .jobs import guard


def perform(job,progress):
    from .paper import decode,recognize
    from .storage import materialize
    ownership=(job['id'],job['run_token'])
    group_id=job['payload']['group_id']
    with connect() as db:
        guard(db,ownership)
        person=db.execute('SELECT role FROM users WHERE id=?',(job['actor'],)).fetchone()
        if not person or person['role'] not in ('admin','manager'):raise HTTPException(403,'提交人的管理权限已失效')
        group=require(db,group_id,'groups');writable(db,'groups',group)
        if group.get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
        batches={b['id']:b for b in find(db,'scan-batches',group_id=group_id)}
        pages=[p for bid in batches for p in find(db,'pages',batch_id=bid) if not p.get('excluded') and p.get('status')=='recognized']
    updated=0;failed=[]
    for index,page in enumerate(pages):
        with connect() as db:
            guard(db,ownership)
            group=require(db,group_id,'groups');writable(db,'groups',group)
            if group.get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
            template=require(db,batches[page['batch_id']]['template_id'],'templates')
            alignment=get(db,page.get('alignment_request_id'),'page-alignments') or {}
        if not any(q['type']!='subjective' for q in template.get('questions',[])):continue
        try:
            from .scan_files import normalized_relative
            sheet_only=page.get('upload_format')=='jpeg-sheet-1'
            image,_=decode(materialize(normalized_relative(page) if sheet_only else 'pages/'+page['id']+'.image').read_bytes(),template)
            if not sheet_only and alignment.get('rotation'):image=np.ascontiguousarray(np.rot90(image,-alignment['rotation']))
            _,_,selections=recognize(image,template,page['side'],None if sheet_only else alignment.get('corners'))
        except (ValueError,FileNotFoundError) as error:
            failed.append({'page_id':page['id'],'reason':str(error)})
            progress(index+1,len(pages),'重新识别客观题填涂');continue
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');guard(db,ownership)
            current=require(db,page['id'],'pages');writable(db,'pages',current)
            if require(db,group_id,'groups').get('frozen'):raise HTTPException(409,RESULTS_REVIEW_GUIDE)
            if current.get('excluded') or current.get('normalized_sha256')!=page.get('normalized_sha256'):
                failed.append({'page_id':page['id'],'reason':'页面已更新，请重新运行'});continue
            current['selections']={**current.get('selections',{}),**selections}
            put(db,'pages',current,job['actor']);updated+=1
        progress(index+1,len(pages),'重新识别客观题填涂')
    return {'updated_pages':updated,'failed_pages':failed,'total_pages':len(pages)}
