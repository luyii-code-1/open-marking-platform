import hashlib
import json
from fastapi import APIRouter, Depends, HTTPException
from .db import connect
from .dependencies import user
from .analysis import overview_rows
from .result_filters import selected
from .export_tables import ExportTable,FileFormat,table_response

router=APIRouter(prefix='/api/v1')
FIELDS={'project':'考试','subject':'科目','grade':'年级','label':'范围','analyzed':'统计人数','average':'平均分','score_rate':'平均得分率%','pass_rate':'及格率%','excellent_rate':'优秀率%','full_score':'满分'}


@router.get('/comparison')
def comparison(scope_ids:str='',columns:str='',format:FileFormat|None=None,preview_version:str='',current=Depends(user)):
    ids=scope_ids.split(',') if scope_ids else []
    with connect() as db:
        db.execute('BEGIN')
        scopes=overview_rows(db,current)
    indexed={r['id']:r for r in scopes}
    if set(ids)-indexed.keys():raise HTTPException(403,'对比范围不存在或不可访问')
    fields=selected(columns) or set(FIELDS)
    if fields-set(FIELDS):raise HTTPException(422,'对比导出字段无效')
    cols=[{'key':key,'label':value} for key,value in FIELDS.items() if key in fields]
    rows=[indexed[key] for key in dict.fromkeys(ids)] if ids else []
    version=hashlib.sha256(json.dumps([cols,[{c['key']:r.get(c['key']) for c in cols} for r in rows]],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    if format:
        if version!=preview_version:raise HTTPException(409,'对比数据或条件已变化，请重新预览')
        return table_response(ExportTable('多次考试对比',[c['label'] for c in cols],([r.get(c['key']) for c in cols] for r in rows)),'exam-comparison',format)
    return {'columns':cols,'rows':rows,'version':version}
