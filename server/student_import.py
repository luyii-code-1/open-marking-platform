"""Bulk import global student identities from school spreadsheets."""
import csv
import io
import json
import re
import zipfile
from collections import defaultdict
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from openpyxl import load_workbook
from .db import connect, objects, put
from .dependencies import admin

router = APIRouter(prefix='/api/v1/student-import')
LIMIT = 20000


def cell_text(cell):
    value = cell.value
    if value is None:
        return ''
    if cell.data_type == 'f':
        return '=' + str(value).lstrip('=')
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value == int(value):
        digits = str(int(value))
        if re.fullmatch(r'0{1,32}', cell.number_format or ''):
            return digits.zfill(len(cell.number_format))
        return digits
    return str(value).strip()


def read_file(file):
    data = file.file.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(413, '文件超过 8 MB')
    tables = {}
    total = 0

    def collect(title, rows):
        nonlocal total
        headers = None
        records = []
        for line, row in enumerate(rows, 1):
            if line > LIMIT + 100 or len(row) > 128:
                raise HTTPException(422, '表格超出支持范围')
            if not any(row):
                continue
            if headers is None:
                headers = row
                continue
            total += 1
            if total > LIMIT:
                raise HTTPException(422, '每批最多导入两万行')
            records.append((line, row))
        if headers and records:
            tables[title] = headers, records

    try:
        if file.filename.lower().endswith('.csv'):
            try:
                source = data.decode('utf-8-sig')
            except UnicodeDecodeError:
                source = data.decode('gb18030')
            collect('CSV', ([v.strip() for v in row] for row in csv.reader(io.StringIO(source))))
        elif file.filename.lower().endswith('.xlsx'):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if sum(item.file_size for item in archive.infolist()) > 40 * 1024 * 1024:
                    raise HTTPException(413, '工作簿展开后超过 40 MB')
            book = load_workbook(io.BytesIO(data), read_only=True, keep_links=False)
            try:
                for sheet in book:
                    if sheet.sheet_state == 'visible':
                        if (sheet.max_column or 0) > 128:
                            raise HTTPException(422, '工作表最多支持 128 列')
                        collect(sheet.title, ([cell_text(c) for c in row] for row in sheet.rows))
            finally:
                book.close()
        else:
            raise HTTPException(422, '请选择 Excel (.xlsx) 或 CSV 文件')
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(422, '文件无法解析，请检查表格格式') from error
    if not tables:
        raise HTTPException(422, '未找到含表头和学生记录的工作表')
    return tables


@router.post('/inspect')
def inspect(file: UploadFile = File(), current=Depends(admin)):
    return {'sheets': [{'name': name, 'columns': [v for v in headers if v], 'rows': len(rows)}
                       for name, (headers, rows) in read_file(file).items()]}


def plan(db, tables, settings, commit, actor):
    grades = {g['name']: g for g in objects(db, 'grades') if not g.get('archived')}
    fixed_grade = next((g for g in grades.values() if g['id'] == settings.get('grade_id')), None)
    existing = {s['candidate_number']: s for s in objects(db, 'students')}
    classes = defaultdict(list)
    def class_key(name):
        number = re.fullmatch(r'0*(\d+)(?:班)?', name)
        return str(int(number[1])) + '班' if number else name
    for cls in objects(db, 'classes'):
        classes[(cls.get('grade_id'), class_key(cls['name']))].append(cls)
    policy = settings.get('conflicts', 'block')
    selected = settings.get('sheets')
    mapping = settings.get('mapping', {})
    if policy not in ('block', 'skip', 'update') or not isinstance(selected, list) or not selected or any(n not in tables for n in selected) or not isinstance(mapping, dict):
        raise HTTPException(422, '请检查工作表和导入选项')
    report = dict(new=0, updated=0, skipped=0, duplicates=0, classes=0, errors=[], conflicts=[], sample=[])
    seen, actions, new_classes = {}, [], {}
    for sheet in dict.fromkeys(selected):
        headers, rows = tables[sheet]
        fields = ['name', 'candidate_number']
        if not settings.get('class_name'):
            fields.append('class_name')
        if not fixed_grade:
            fields.append('grade')
        if any(not mapping.get(f) or headers.count(mapping[f]) != 1 for f in fields) or len({mapping[f] for f in fields}) != len(fields):
            report['errors'].append(f'{sheet}：请为各字段选择唯一对应列')
            continue
        indices = {f: headers.index(mapping[f]) for f in fields}
        for line, row in rows:
            values = {f: row[i] if i < len(row) else '' for f, i in indices.items()}
            name, candidate = values['name'], values['candidate_number']
            cls_name = settings.get('class_name') or values.get('class_name')
            grade = fixed_grade or grades.get(values.get('grade'))
            source = f'{sheet} 第 {line} 行'
            if not grade or not name or not cls_name or not re.fullmatch('[0-9]+', candidate) or name.startswith('=') or cls_name.startswith('='):
                report['errors'].append(source + '：请检查姓名、班级、已有年级和数字准考证号')
                continue
            key = grade['id'], class_key(cls_name)
            identity = name, key
            if candidate in seen:
                if seen[candidate] != identity:
                    report['errors'].append(source + '：文件内同一准考证号对应不同学生资料')
                else:
                    report['duplicates'] += 1
                continue
            seen[candidate] = identity
            matches = classes[key]
            if len(matches) > 1:
                report['errors'].append(source + '：同年级有多个同名班级')
                continue
            cls = matches[0] if matches else None
            old = existing.get(candidate)
            sample = dict(name=name, candidate_number=candidate, grade=grade['name'], class_name=cls['name'] if cls else key[1])
            if len(report['sample']) < 10:
                report['sample'].append(sample)
            if old:
                if cls and old['class_id'] == cls['id'] and old['name'] == name:
                    report['skipped'] += 1
                    continue
                report['conflicts'].append(source + '：' + candidate + ' 已有不同姓名或班级')
                if policy != 'update':
                    report['skipped'] += 1
                    continue
            if not cls:
                new_classes[key] = grade
            report['updated' if old else 'new'] += 1
            actions.append((old, key, name, candidate))
    report['classes'] = len(new_classes)
    report['can_import'] = not report['errors'] and not (policy == 'block' and report['conflicts'])
    if commit:
        if not report['can_import']:
            raise HTTPException(409, '名单存在错误或冲突，请重新预览')
        for key, grade in new_classes.items():
            classes[key] = [put(db, 'classes', {'name':key[1], 'grade_id':grade['id'], 'grade':grade['name'], 'teacher_ids':[]}, actor)]
        for old, key, name, candidate in actions:
            put(db, 'students', {**(old or {}), 'name':name, 'candidate_number':candidate, 'class_id':classes[key][0]['id']}, actor)
    return report


@router.post('/{action}')
def import_file(action: str, file: UploadFile = File(), options: str = Form(), current=Depends(admin)):
    if action not in ('preview','commit'):
        raise HTTPException(404)
    try:
        settings=json.loads(options)
        if not isinstance(settings,dict):
            raise ValueError()
    except ValueError:
        raise HTTPException(422,'导入选项无效')
    tables = read_file(file)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE' if action == 'commit' else 'BEGIN')
        return plan(db, tables, settings, action == 'commit', current['id'])
