"""Class totals from complete, unambiguous visible expected subject records."""
from collections import Counter
from .result_filters import ResultFilters


def class_totals(data,include_absent=False):
    columns={column['id']:column for column in data['columns']}
    students=[];warnings=[]
    for original in data['students']:
        student=dict(original);scores=student['scores']
        subjects=Counter(columns[gid]['subject_id'] for gid in scores if gid in columns)
        duplicate=[sid for sid,count in subjects.items() if count>1]
        states={score['status'] for score in scores.values()}
        if duplicate:
            names=sorted({column['subject'] for column in columns.values() if column['subject_id'] in duplicate})
            reason='、'.join(names)+'存在多份题卡记录，请选择参与汇总的题卡'
            status='duplicate_subject';warnings.append({'student_id':student['student_id'],'class_id':student['class_id'],'reason':reason})
        elif 'unscanned' in states:status='unscanned';reason='存在未扫描科目'
        elif 'pending' in states:status='pending';reason='存在待结分科目'
        elif states=={'absent'}:status='absent';reason=''
        else:status='completed';reason=''
        raw=[];effective=[];complete=bool(scores) and not duplicate and states<={'completed','absent'}
        for gid,score in scores.items():
            column=columns[gid]
            if score['status']=='absent':raw.append(0);effective.append(0);continue
            value=score.get('raw')
            adopted=score.get('converted') if column['conversion_enabled'] else value
            if value is None or adopted is None:complete=False
            else:raw.append(value);effective.append(adopted)
        if not complete and status=='completed':status='pending';reason='赋分或原始分尚未完整结算'
        student.update(status=status,total=round(sum(effective),2) if complete else None,raw_total=round(sum(raw),2) if complete else None,class_rank=None,ranking_reason=reason,expected_records=len(scores))
        students.append(student)
    for cid in {student['class_id'] for student in students}:
        eligible=[s for s in students if s['class_id']==cid and s['total'] is not None and (include_absent or s['status']!='absent')]
        counts=Counter(s['total'] for s in eligible);rank=1;ranks={}
        for score in sorted(counts,reverse=True):ranks[score]=rank;rank+=counts[score]
        for student in eligible:student['class_rank']=ranks[student['total']]
    return {**data,'students':students,'warnings':warnings,'rank_scope':'visible_expected_records','include_absent':include_absent}


def filter_project(data,filters=None,room_tag_id=None):
    from .room_tags import includes
    filters=filters or ResultFilters()
    rows=[student for student in data['students'] if filters.matches(student) and (not room_tag_id or any(includes(score,room_tag_id) for score in student['scores'].values()))]
    ids={row['student_id'] for row in rows}
    return {**data,'students':rows,'warnings':[warning for warning in data.get('warnings',[]) if warning['student_id'] in ids]}


def class_sets(students):
    classes={}
    for row in students:classes.setdefault(row['class_id'],[]).append(row)
    if not classes:return [('成绩排名',[])]
    return [(str(rows[0].get('grade') or '')+' · '+rows[0]['class_name'],sorted(rows,key=lambda row:(row.get('class_rank') is None,row.get('class_rank') or 0,row['candidate_number']))) for rows in sorted(classes.values(),key=lambda rows:(str(rows[0].get('grade') or ''),rows[0]['class_name']))]


def subject_tables(data,subject,conversion_enabled):
    from .export_tables import RankingTable
    from .result_filters import STATUS_NAMES
    headers=['姓名','考号','班级','原始分']+(['赋分'] if conversion_enabled else [])+['可见范围名次','班内名次','状态']
    score_end=5 if conversion_enabled else 4
    groups=[('考生信息',1,3),(subject,4,score_end),('排名',score_end+1,score_end+2),('作答状态',score_end+3,score_end+3)]
    subtitle=('按原始分' if data['metric']=='raw' else '按赋分')+'排名；排名基准为筛选前当前可见范围；同分并列、后续跳号；'+('缺考按0分参与排名' if data['include_absent'] else '缺考不参与排名')
    for name,students in class_sets(data['students']):
        rows=[[row['name'],str(row['candidate_number']),row['class_name'],row.get('total')]+([row.get('converted_score')] if conversion_enabled else [])+[row.get('scope_rank'),row.get('class_rank'),STATUS_NAMES[row['status']]] for row in students]
        yield RankingTable(subject+'成绩排名 · '+name,subtitle,headers,rows,groups,(1,*range(4,score_end+3)),tuple(range(4,score_end+3)))


def project_tables(data):
    from .export_tables import RankingTable
    from .result_filters import STATUS_NAMES
    headers=['姓名','考号','班级'];groups=[('考生信息',1,3)]
    for column in data['columns']:
        label=' · '.join(value for value in (column['subject'],column['grade'],column['group']) if value)
        start=len(headers)+1;headers.append(label+' 原始分')
        if column['conversion_enabled']:headers.append(label+' 赋分')
        groups.append((label,start,len(headers)))
    totals_start=len(headers)+1
    headers+=['原始分总分','采用分总分','班内名次','状态','说明']
    groups+=[('总分与排名',totals_start,totals_start+2),('作答状态',totals_start+3,totals_start+4)]
    subtitle='按当前可见实际应考科目汇总；已配置赋分的科目采用赋分，其余采用原始分；全部结分后计算总分；同分并列、后续跳号'
    for name,students in class_sets(data['students']):
        rows=[]
        for student in students:
            row=[student['name'],str(student['candidate_number']),student['class_name']]
            for column in data['columns']:
                score=student['scores'].get(column['id'],{})
                row.append(score.get('raw'))
                if column['conversion_enabled']:row.append(score.get('converted'))
            rows.append(row+[student['raw_total'],student['total'],student['class_rank'],STATUS_NAMES[student['status']],student.get('ranking_reason','')])
        yield RankingTable(data['project_name']+'班级总表 · '+name,subtitle,headers,rows,groups,(1,totals_start,totals_start+1,totals_start+2),(totals_start,totals_start+1,totals_start+2))
