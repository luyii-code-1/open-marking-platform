import re
from collections import defaultdict


def matrix_import(db, tables, commit, actor, choices=None):
    from .teaching import save, Relation
    from .db import objects
    from fastapi import HTTPException
    sheet = tables.get('任课任职表')
    if not sheet:
        return None
    _, records = sheet
    rows = dict(records)
    labels, sub = rows.get(3, []), rows.get(4, [])
    cols = [i for i in range(len(sub)-1) if sub[i:i+2] == ['姓名','班级'] and i < len(labels) and labels[i]]
    if not cols:
        raise HTTPException(422, '未找到第3、4行的学科、姓名和班级表头')
    from .teaching_accounts import resolve_accounts
    entries = []
    grade = ''
    for line, row in records:
        if line < 5: continue
        grade = row[0] or grade
        for i in cols:
            if i+1 < len(row) and row[i].strip() and row[i+1].strip():
                entries.append((f'{line}:{i}',row[i].strip(),f'{grade} {labels[i]} · {row[i+1]}'))
    resolved,pending,credentials,planned = resolve_accounts(db,entries,choices or {},commit,actor)
    classes = defaultdict(list)
    grades = {g['id']:g['name'] for g in objects(db,'grades')}
    for cls in objects(db,'classes'):
        grade = grades.get(cls.get('grade_id'),cls.get('grade',''))
        label = cls['name'].removeprefix(grade or '').strip()
        number = re.fullmatch(r'[（(]?(\d+)[）)]?班?',label)
        if number:
            classes[grade,int(number[1])].append(cls)
    grade = ''
    pairs, skipped = {}, []
    for line, row in records:
        if line < 5:
            continue
        if row[0]:
            grade = row[0]
        for i in cols:
            if i+1 >= len(row) or not row[i].strip() or not row[i+1].strip():
                continue
            teacher, raw = row[i].strip(), row[i+1].strip()
            subject = labels[i]
            if subject == '体育16节': subject = '体育'
            if subject == '音乐（心理高一）': subject = '心理' if grade=='高一' else '音乐'
            ref = f'第{line}行 {grade} {subject} {teacher}'
            uid = resolved.get(f'{line}:{i}')
            if uid is None: continue
            for token in re.split(r'[、，,]',raw):
                token = token.strip()
                if not token: continue
                span = re.fullmatch(r'(\d+)(?:\s*[-—–]\s*(\d+))?',token)
                if not span or len(token)>24:
                    skipped.append(ref + '：' + token)
                    continue
                start, end = int(span[1]), int(span[2] or span[1])
                if end < start or end-start > 200:
                    skipped.append(ref + '：班号范围无效')
                    continue
                for n in range(start,end+1):
                    matches = classes[grade,n]
                    if len(matches)!=1:
                        skipped.append(ref + f'：{n}班未唯一匹配')
                        continue
                    cls=matches[0]
                    role=cls.get('teaching',{}).get(uid,{})
                    item=pairs.setdefault((uid,cls['id']),Relation(teacher_id=uid,class_id=cls['id'],subjects=[],homeroom=role.get('homeroom')))
                    if subject not in item.subjects: item.subjects.append(subject)
    if commit:
        for item in pairs.values(): save(db,item,actor)
    return {'pending':pending,'created':credentials,'planned':planned,'relations':[r.model_dump() for r in pairs.values()], 'count':len(pairs),'errors':[] if pairs or planned or pending else ['没有可导入的行政班关系'],'skipped':skipped,'saved':bool(commit and (pairs or credentials))}
