from copy import deepcopy
from fastapi import APIRouter,Depends,HTTPException,File,Form,UploadFile
from .db import connect,objects,put
from .dependencies import admin,require
from .review import results_for
from .conversion import validate_conversion,apply,import_table

router=APIRouter(prefix='/api/v1')


def validate_existing(db,group,config,current):
    try:apply(results_for(db,group['id'],current,convert_scores=False),config)
    except ValueError as error:raise HTTPException(422,f"{group['name']}：{error}")


@router.post('/score-conversions/import-preview')
def preview_table(file:UploadFile=File(),name:str=Form('外部对照表'),precision:int=Form(2),current=Depends(admin)):
    if not 1<=len(name.strip())<=100:raise HTTPException(422,'请填写100字以内方案名称')
    try:config=import_table(file.file.read(2*1024*1024+1),name.strip(),precision)
    except ValueError as error:raise HTTPException(422,str(error))
    rows=[{'raw':raw,'converted':target} for raw,target in config['table'].items()]
    rows.sort(key=lambda r:float(r['raw']))
    return {'config':config,'row_count':len(rows),'sample':rows[:20]}


@router.put('/score-conversions/{identifier}')
def edit_conversion(identifier:str,body:dict,current=Depends(admin)):
    reason=body.get('reason','')
    if not isinstance(reason,str) or not reason.strip():raise HTTPException(422,'请填写修改原因')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        old=require(db,identifier,'score-conversions')
        if body.get('base_revision')!=old.get('revision',1):raise HTTPException(409,'方案已变化，请重新载入再编辑')
        groups=[g for g in objects(db,'groups') if g.get('conversion_id')==identifier]
        if any(g.get('frozen') for g in groups):raise HTTPException(409,'方案用于已发布成绩，请另存副本并在复核后绑定')
        value={k:deepcopy(v) for k,v in body.items() if k in ('name','mode','table','segments','precision','boundary')}
        if not isinstance(value.get('name'),str) or not 1<=len(value['name'].strip())<=100:raise HTTPException(422,'请填写100字以内方案名称')
        try:validate_conversion(value)
        except ValueError as error:raise HTTPException(422,str(error))
        for group in groups:validate_existing(db,group,value,current)
        value.update(id=identifier,revision=old.get('revision',1)+1,change_reason=reason.strip())
        saved=put(db,'score-conversions',value,current['id'])
        for group in groups:
            group['conversion_revision']=saved['revision'];put(db,'groups',group,current['id'])
        return saved
