"""Spreadsheet templates and record matching for management selectors."""
import csv
import io
import re
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from openpyxl import Workbook
from .db import connect, objects
from .dependencies import admin
from .roster_import import table_rows

router=APIRouter(prefix='/api/v1')
FORMATS={'users':['账号','姓名'],'students':['准考证号','姓名'],'classes':['年级','班级'],'subject-tags':['科目'],'grades':['年级']}


def spreadsheet(columns,format):
    if format=='csv':
        output=io.StringIO();csv.writer(output).writerow(columns)
        return Response(('\ufeff'+output.getvalue()).encode('utf-8'),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="import-template.csv"','Cache-Control':'private, no-store'})
    if format!='xlsx':raise HTTPException(422,'模板格式应为CSV或XLSX')
    book=Workbook();sheet=book.active;sheet.title='导入模板';sheet.append(columns)
    for cells in sheet:
        for cell in cells:cell.number_format='@'
    for cells in sheet.iter_rows(min_row=2,max_row=1001,max_col=len(columns)):
        for cell in cells:cell.number_format='@'
    for index in range(1,len(columns)+1):
        from openpyxl.utils import get_column_letter
        sheet.column_dimensions[get_column_letter(index)].width=22
    output=io.BytesIO();book.save(output);book.close()
    return Response(output.getvalue(),media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',headers={'Content-Disposition':'attachment; filename="import-template.xlsx"','Cache-Control':'private, no-store'})


@router.get('/table-import/template')
def table_template(columns:str,format:str='xlsx',current=Depends(admin)):
    fields=columns.split(',')
    if not 1<=len(fields)<=32 or any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,59}',f) for f in fields):raise HTTPException(422,'模板字段无效')
    return spreadsheet(fields,format)


def uploaded(file):
    data=file.file.read(8*1024*1024+1)
    if len(data)>8*1024*1024:raise HTTPException(413,'文件超过8 MB')
    rows=table_rows(data,file.filename or '')
    if len(rows)<2:raise HTTPException(422,'请在表头下填写至少一条记录')
    return rows


@router.post('/table-import/parse')
def parse_table(file:UploadFile=File(),current=Depends(admin)):
    rows=uploaded(file)
    headers=rows[0][1]
    while headers and not headers[-1]:headers.pop()
    if not headers or len(set(headers))!=len(headers) or any(not h for h in headers):raise HTTPException(422,'表头需填写完整且不能重复')
    if any(any(row[len(headers):]) for _,row in rows[1:]):raise HTTPException(422,'数据超出表头列，请补齐表头')
    return {'headers':headers,'rows':[row[:len(headers)] for _,row in rows[1:]]}


@router.get('/selection/{kind}/template')
def selection_template(kind:str,format:str='xlsx',current=Depends(admin)):
    if kind not in FORMATS:raise HTTPException(404,'不支持该类型的选择模板')
    return spreadsheet(FORMATS[kind],format)


@router.post('/selection/{kind}/match')
def match_records(kind:str,file:UploadFile=File(),current=Depends(admin)):
    if kind not in FORMATS:raise HTTPException(404,'不支持该类型的记录选择')
    rows=uploaded(file);headers=rows[0][1]
    aliases={'账号':'username','username':'username','姓名':'name','name':'name','准考证号':'candidate_number','考号':'candidate_number','candidate_number':'candidate_number','班级':'name','科目':'name','年级':'grade','id':'id','编号':'id'}
    if kind=='grades':aliases['年级']='name'
    mapped=[aliases.get(h) for h in headers]
    identifier='username' if kind=='users' else 'candidate_number' if kind=='students' else 'name'
    if mapped.count(identifier)!=1 and mapped.count('id')!=1:raise HTTPException(422,'请使用当前选择器的导入模板')
    fields=[f for f in mapped if f]
    if len(fields)!=len(set(fields)):raise HTTPException(422,'表头字段重复，请检查模板')
    with connect() as db:
        records=[dict(r) for r in db.execute('SELECT id,username,name,role FROM users')] if kind=='users' else objects(db,kind)
        grades={g['id']:g['name'] for g in objects(db,'grades')}
        chosen=[]
        for number,row in rows[1:]:
            values={field:row[index] if index<len(row) else '' for index,field in enumerate(mapped) if field}
            key='id' if values.get('id') else identifier
            if not values.get(key):raise HTTPException(422,f'第{number}行缺少编号或匹配字段')
            matches=[r for r in records if str(r.get(key,''))==values[key]]
            if kind=='classes' and values.get('grade'):
                matches=[r for r in matches if grades.get(r.get('grade_id'),r.get('grade'))==values['grade']]
            if len(matches)!=1:raise HTTPException(422,f'第{number}行未能唯一匹配记录，请检查编号、名称或年级')
            record=matches[0]
            if kind in ('users','students') and values.get('name') and values['name']!=record['name']:raise HTTPException(422,f'第{number}行姓名与现有记录不一致')
            if record['id'] not in chosen:chosen.append(record['id'])
        return {'ids':chosen,'matched':len(chosen)}
