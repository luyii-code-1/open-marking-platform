"""Scoped result tables. Preview and download share columns, rows and a content digest."""
import hashlib
import json
from collections import Counter
from fastapi import APIRouter, Depends, HTTPException, Query
from .db import connect, get
from .dependencies import user, require
from .analysis import project_result_groups
from .review import results_for
from .result_filters import selected, STATUS_NAMES
from .export_tables import ExportTable, FileFormat, table_response

router = APIRouter(prefix='/api/v1')


def published_rows(db, group, current):
    # Resolve authorization before reading the stored publication.
    from .review import result_class_scope
    allowed = result_class_scope(db, group, current)
    snapshot = get(db, group.get('result_snapshot_id'), 'result-snapshots')
    rows = snapshot['rows'] if snapshot else results_for(db, group['id'], current)
    return [r for r in rows if allowed is None or r['class_id'] in allowed]


def build_table(db, current, project_id, subject_id='', grade_id='', group_id='',
                subject_ids='', grade_ids='', class_ids='', student_ids='', group_ids='',
                statuses='', q='', view='totals', metric='raw', **unused):
    if view not in ('totals', 'items') or metric not in ('raw', 'converted'):
        raise HTTPException(422, '成绩视图或口径无效')
    project, subjects, groups = project_result_groups(db, project_id, current)
    if subject_id and subject_id not in subjects:raise HTTPException(404, '科目不属于当前考试')
    if group_id:
        group = require(db, group_id, 'groups')
        if group.get('subject_id') not in subjects or subject_id and group['subject_id'] != subject_id:
            raise HTTPException(404, '题卡不属于当前范围')
    scope = [g for g in groups if (not subject_id or g['subject_id'] == subject_id)
             and (not grade_id or (g.get('grade_id') or 'unassigned') == grade_id)
             and (not group_id or g['id'] == group_id)]
    # Card management can inspect drafts; all aggregate views use publications.
    scope = [g for g in scope if group_id or g.get('frozen')]
    choices = {'subjects':[], 'grades':[], 'groups':[], 'classes':[], 'students':[]}
    for g in scope:
        s = subjects[g['subject_id']]
        choices['subjects'].append({'id':s['id'], 'name':s['name']})
        grade = get(db, g.get('grade_id'), 'grades')
        if grade:choices['grades'].append({'id':grade['id'], 'name':grade['name']})
        choices['groups'].append({'id':g['id'], 'name':s['name']+' · '+g['name']})
    filters = {k:selected(v) for k,v in [('subjects',subject_ids),('grades',grade_ids),('groups',group_ids),('classes',class_ids),('students',student_ids),('statuses',statuses)]}
    groups = [g for g in scope if (not filters['subjects'] or g['subject_id'] in filters['subjects'])
              and (not filters['grades'] or g.get('grade_id') in filters['grades'])
              and (not filters['groups'] or g['id'] in filters['groups'])]
    columns = [{'key':k, 'label':v} for k,v in [('candidate_number','准考证号'),('name','姓名'),('grade','年级'),('class_name','班级')]]
    students = {}; question_columns = {}; subject_columns = {}
    from .db import objects as db_objects
    class_objects = {c['id']:c for c in db_objects(db,'classes')}
    for g in groups:
        rows = published_rows(db, g, current) if g.get('frozen') else results_for(db, g['id'], current)
        subject = subjects[g['subject_id']]
        subject_columns[subject['id']] = subject['name']
        for row in rows:
            if row.get('class_id'):
                c_obj = class_objects.get(row['class_id'], {})
                choices['classes'].append({
                    'id':row['class_id'],
                    'name':str(row.get('grade') or '')+' · '+row['class_name'],
                    'grade_name':str(row.get('grade') or ''),
                    'class_name':row['class_name'],
                    'tags':c_obj.get('tags', []),
                })
            choices['students'].append({'id':row['student_id'],'name':row['name']+' · '+str(row.get('candidate_number',''))})
            student = students.setdefault(row['student_id'], {**{k:row.get(k) for k in ('student_id','candidate_number','name','grade','class_id','class_name')}, '_scores':{}, '_records':[]})
            student['_records'].append((subject['id'], row))
            student['_scores'].setdefault(subject['id'], []).append(row)
            for number, score in row['scores'].items():
                key = g['id']+':'+str(number)
                question_columns[key] = subject['name']+' / '+g['name']+' / 第'+str(number)+'题'
                student[key] = score
    if view == 'totals':
        columns += [{'key':sid, 'label':name} for sid,name in subject_columns.items()]
        columns += [{'key':'total','label':'总分'},{'key':'rank','label':'范围排名'}]
    else:columns += [{'key':key, 'label':label} for key,label in question_columns.items()]
    columns += [{'key':'status','label':'状态'},{'key':'note','label':'说明'}]
    output = []
    for student in students.values():
        scores = student.pop('_scores'); records = student.pop('_records'); states = {r['status'] for _,r in records}
        duplicate = [sid for sid,rows in scores.items() if len(rows)>1]
        student['status'] = 'duplicate_subject' if duplicate else 'unscanned' if 'unscanned' in states else 'pending' if 'pending' in states else 'absent' if states == {'absent'} else 'completed'
        student['note'] = '、'.join(subject_columns[sid] for sid in duplicate)+'存在多张题卡，按异常卷处理' if duplicate else ''
        values = []
        raw_values = []
        raw_map = {}
        for sid,rows in scores.items():
            row = rows[0]
            raw_value = None if len(rows)>1 else row['total']
            value = raw_value if metric == 'raw' else (None if len(rows)>1 else row.get('converted_score'))
            student[sid] = value
            values.append(value)
            raw_values.append(raw_value)
            if metric == 'converted' and view == 'totals':
                raw_map[sid] = raw_value
            if metric == 'converted' and row['total'] is not None and value is None:
                student['note'] += ('；' if student['note'] else '')+subject_columns[sid]+'未配置赋分'
        student['total'] = round(sum(values),2) if values and all(v is not None for v in values) and not duplicate else None
        if metric == 'converted' and view == 'totals':
            raw_total = round(sum(raw_values),2) if raw_values and all(v is not None for v in raw_values) and not duplicate else None
            student['_raw'] = {**raw_map, 'total': raw_total}
        student['rank'] = None
        output.append(student)
    counts = Counter(r['total'] for r in output if r['total'] is not None and r['status']=='completed')
    ranks = {}; rank = 1
    for score in sorted(counts, reverse=True):ranks[score] = rank; rank += counts[score]
    for row in output:
        if row['status']=='completed':row['rank'] = ranks.get(row['total'])
    # Rank against the full selected paper scope, before student/class search.
    output = [r for r in output if (not filters['classes'] or r['class_id'] in filters['classes'])
              and (not filters['students'] or r['student_id'] in filters['students'])
              and (not filters['statuses'] or r['status'] in filters['statuses'])
              and (not q.strip() or any(q.strip().casefold() in str(r.get(k,'')).casefold() for k in ('name','candidate_number')))]
    output.sort(key=lambda r:(r['rank'] is None,r['rank'] or 0,str(r.get('candidate_number') or ''),r['student_id']))
    for row in output:row['status'] = STATUS_NAMES.get(row['status'],row['status'])
    for key,values in choices.items():choices[key] = list({r['id']:r for r in values}.values())
    choices['statuses'] = [{'id':key,'name':name} for key,name in STATUS_NAMES.items()]
    return {'project_name':project['name'],'columns':columns,'rows':output,'options':choices}


@router.get('/gradebook')
def gradebook(project_id:str, subject_id:str='', grade_id:str='', group_id:str='', subject_ids:str='', grade_ids:str='',
              class_ids:str='', student_ids:str='', group_ids:str='', statuses:str='', q:str='', view:str='totals', metric:str='raw',
              columns:str='', page:int=Query(1,ge=1), page_size:int=Query(50,ge=1,le=200),
              format:FileFormat|None=None, preview_version:str='', current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN')
        data = build_table(db,current,project_id,subject_id,grade_id,group_id,subject_ids,grade_ids,class_ids,student_ids,group_ids,statuses,q,view,metric)
    chosen = selected(columns)
    if chosen-set(c['key'] for c in data['columns']):raise HTTPException(422,'导出列已变化，请重新预览')
    cols = [c for c in data['columns'] if not chosen or c['key'] in chosen]
    values = [{c['key']:r.get(c['key']) for c in cols} for r in data['rows']]
    version = hashlib.sha256(json.dumps([cols,values],ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    if format:
        if preview_version != version:raise HTTPException(409,'成绩或导出条件已变化，请重新预览')
        return table_response(ExportTable('小题分' if view=='items' else '概览成绩',[c['label'] for c in cols],([r.get(c['key']) for c in cols] for r in data['rows'])),'exam-results',format)
    start = (page-1)*page_size
    return {**data,'rows':data['rows'][start:start+page_size],'columns':cols,'total':len(data['rows']),'page':page,'page_size':page_size,'version':version}
