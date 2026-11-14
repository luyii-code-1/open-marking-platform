"""Read roster files and resolve candidate numbers to current global identities."""
import csv
import io
import re
import zipfile
from itertools import islice
from fastapi import HTTPException
from .db import objects
from .school import student_view

HEADERS={'准考证号':'candidate_number','考号':'candidate_number','candidate_number':'candidate_number','姓名':'name','name':'name'}
MAX_ROWS=20000


def table_rows(content,filename):
    suffix=filename.lower().rsplit('.',1)[-1]
    try:
        if suffix=='csv':
            try:text=content.decode('utf-8-sig')
            except UnicodeDecodeError:text=content.decode('gb18030')
            raw=list(islice(csv.reader(io.StringIO(text)),MAX_ROWS+2))
        elif suffix=='xlsx':
            from openpyxl import load_workbook
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                if sum(v.file_size for v in archive.infolist())>40*1024*1024:raise HTTPException(413,'表格展开后过大，请仅保留名单数据')
            book=load_workbook(io.BytesIO(content),read_only=True,data_only=False,keep_links=False)
            try:
                sheet=book['应考名单'] if '应考名单' in book.sheetnames else book.worksheets[0]
                sheet.reset_dimensions()
                raw=[]
                for index,cells in enumerate(sheet.iter_rows(max_col=32),1):
                    if index>MAX_ROWS+1:raise HTTPException(422,f'名单最多支持{MAX_ROWS}行')
                    row=[]
                    for cell in cells:
                        value=cell.value
                        if cell.data_type=='f':raise HTTPException(422,f'第{cell.row}行含公式，请粘贴为值后导入')
                        if isinstance(value,(int,float)) and not isinstance(value,bool):
                            if int(value)!=value:raise HTTPException(422,f'第{cell.row}行含非整数，请检查准考证号')
                            digits=str(int(value));fmt=cell.number_format or ''
                            value=digits.zfill(len(fmt)) if re.fullmatch('0{1,32}',fmt) else digits
                        row.append('' if value is None else str(value))
                    raw.append(row)
            finally:book.close()
        else:raise HTTPException(422,'请上传.xlsx或.csv文件；旧版.xls请另存为.xlsx')
    except HTTPException:raise
    except Exception as error:
        raise HTTPException(422,'无法读取名单文件，请检查文件格式或重新下载模板') from error
    if len(raw)>MAX_ROWS+1:raise HTTPException(422,f'名单最多支持{MAX_ROWS}行')
    while raw and not any(str(v).strip() for v in raw[-1]):raw.pop()
    rows=[(i+1,[str(v).strip() for v in row]) for i,row in enumerate(raw) if any(str(v).strip() for v in row)]
    return rows


def read_rows(content,filename):
    rows=table_rows(content,filename)
    if len(rows)<2:raise HTTPException(422,'请在表头下填写至少一名学生')
    _,head=rows.pop(0);mapped=[HEADERS.get(h) for h in head]
    if mapped.count('candidate_number')!=1 or mapped.count('name')>1:raise HTTPException(422,'表头需包含一列“准考证号”，可选一列“姓名”')
    number=mapped.index('candidate_number');name=mapped.index('name') if 'name' in mapped else None
    return [{'row':i,'candidate_number':row[number] if number<len(row) else '', 'name':row[name] if name is not None and name<len(row) else ''} for i,row in rows]


def match_rows(db,group,rows):
    students={s['candidate_number']:student_view(db,s) for s in objects(db,'students')}
    errors=[];warnings=[];selected={};duplicates=0
    for row in rows:
        candidate=row['candidate_number'];student=students.get(candidate)
        if not re.fullmatch(r'[0-9]+',candidate):
            errors.append({**row,'reason':'准考证号应为数字文本，请保留前导零'});continue
        if not student:
            errors.append({**row,'reason':'全局学生中未找到此准考证号，请先维护学生资料'});continue
        if student['id'] in selected:duplicates+=1
        selected[student['id']]=student
        reasons=[]
        if student.get('grade_id')!=group['grade_id']:reasons.append('学生当前年级与题卡年级不同')
        if row['name'] and row['name']!=student['name']:reasons.append('表格姓名与全局姓名不同，将使用全局姓名')
        if reasons:warnings.append({**row,'actual_name':student['name'],'grade':student.get('grade'),'reason':'；'.join(reasons)})
    return {'total_rows':len(rows),'duplicates':duplicates,'matched_count':len(selected),'students':list(selected.values()),'errors':errors,'warnings':warnings}
