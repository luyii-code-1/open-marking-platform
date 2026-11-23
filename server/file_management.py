"""Project file accounting and removal of generated archive packages."""
import time
from fastapi import APIRouter, Depends, HTTPException
from .db import connect, get, objects, find, put
from .dependencies import admin, require
from .storage import local_path
from .archive import package_path, checksum

router=APIRouter(prefix='/api/v1')


@router.get('/projects/{identifier}/files')
def files(identifier:str,current=Depends(admin)):
    with connect() as db:
        project=get(db,identifier,'projects')
        archives=find(db,'archives',project_id=identifier)
        if not project:
            deleted_row=db.execute("SELECT 1 FROM objects WHERE id=? AND kind='projects' AND deleted=1",(identifier,)).fetchone()
            if not deleted_row and not archives:
                raise HTTPException(404,'记录不存在')
            entries={}
            for archive in archives:
                path=package_path(archive['id'])
                if path.is_file():
                    entries['archive:'+archive['id']]={'id':'archive:'+archive['id'],'name':archive['id']+'.zip','kind':'归档包','local_bytes':path.stat().st_size,'remote_bytes':0}
            rows=list(entries.values())
            return {'items':rows,'local_bytes':sum(r['local_bytes'] for r in rows),'remote_bytes':0,'checked_at':time.time(),'unknown_remote_files':0,'project_deleted':True}
        subjects={s['id'] for s in find(db,'subjects',project_id=identifier)}
        groups={g['id'] for g in objects(db,'groups') if g.get('subject_id') in subjects}
        batches={b['id'] for b in objects(db,'scan-batches') if b.get('group_id') in groups}
        pages=[p for p in objects(db,'pages') if p.get('batch_id') in batches]
        refs=[r for r in find(db,'storage-assets',project_id=identifier) if r.get('status')=='stored']
        from .scan_files import page_suffixes
        entries={}
        for page in pages:
            for suffix in page_suffixes(page):
                key='pages/'+page['id']+suffix
                path=local_path(key)
                if path.is_file():entries[key]={'id':key,'name':key,'kind':'扫描文件','local_bytes':path.stat().st_size,'remote_bytes':0}
        unknown_remote=0
        sizes={r['relative']:r['size'] for r in objects(db,'archive-files') if r.get('project_id')==identifier and 'size' in r}
        for ref in refs:
            key=ref['relative']
            row=entries.setdefault(key,{'id':key,'name':key,'kind':'扫描文件','local_bytes':0,'remote_bytes':0})
            size=ref.get('size',sizes.get(key,row['local_bytes'] or None))
            if size is None:unknown_remote+=1
            row['remote_bytes']+=size or 0
        for archive in archives:
            path=package_path(archive['id'])
            if path.is_file():entries['archive:'+archive['id']]={'id':'archive:'+archive['id'],'name':archive['id']+'.zip','kind':'归档包','local_bytes':path.stat().st_size,'remote_bytes':0}
        # Template assets are shared; count each physical object once in this scope.
        asset_ids=set()
        for template in objects(db,'templates'):
            if template.get('group_id') not in groups:continue
            asset_ids.update(template.get('background_assets',{}).values())
            if template.get('background_asset_id'):asset_ids.add(template['background_asset_id'])
            asset_ids.update(q['image_asset_id'] for q in template.get('questions',[]) if q.get('image_asset_id'))
        for aid in asset_ids:
            directory=local_path('assets')
            for path in directory.glob(aid+'.*'):
                if path.is_file():
                    key='assets/'+path.name
                    entries[key]={'id':key,'name':key,'kind':'题卡资产（可能共享）','local_bytes':path.stat().st_size,'remote_bytes':0}
    rows=list(entries.values())
    return {'items':rows,'local_bytes':sum(r['local_bytes'] for r in rows),'remote_bytes':sum(r['remote_bytes'] for r in rows),'checked_at':time.time(),'unknown_remote_files':unknown_remote}


@router.post('/archives/{identifier}/delete-preview')
def delete_preview(identifier:str,current=Depends(admin)):
    with connect() as db:archive=require(db,identifier,'archives')
    path=package_path(identifier)
    return {'id':identifier,'size':path.stat().st_size if path.is_file() else 0,'sha256':checksum(path) if path.is_file() else None,'project_id':archive['project_id']}


@router.delete('/archives/{identifier}/package')
def delete_package(identifier:str,body:dict,current=Depends(admin)):
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        archive=require(db,identifier,'archives')
        if body.get('confirm') is not True:raise HTTPException(422,'请先核对归档包删除预览')
        if any(j.get('status') in ('pending','running') and j.get('project_id')==archive['project_id'] for j in objects(db,'jobs')):raise HTTPException(409,'项目文件任务执行中，稍后重试')
        # An active project may still use this package as the sole copy of a scan.
        from .db import get
        project=get(db,archive['project_id'],'projects')
        if project and not project.get('scans_purged'):
            for entry in find(db,'archive-files',archive_id=identifier):
                relative=entry.get('relative') or entry.get('path')
                if relative and relative.startswith('pages/') and get(db,relative.split('/')[1].split('.')[0],'pages') and not local_path(relative).is_file():
                    raise HTTPException(409,'此归档仍用于原卷回取，请先恢复扫描文件或明确清理原卷')
        path=package_path(identifier)
        digest=checksum(path) if path.is_file() else None
        if body.get('sha256')!=digest:raise HTTPException(409,'归档已变化，请重新预览')
        if path.is_file():path.unlink()
        archive.update(package_deleted_at=time.time(),status='deleted')
        put(db,'archives',archive,current['id'])
        db.execute('UPDATE objects SET deleted=1 WHERE id=?',(identifier,))
        for entry in find(db,'archive-files',archive_id=identifier):db.execute('UPDATE objects SET deleted=1 WHERE id=?',(entry['id'],))
    return {'deleted':True}
