from .merged_questions import label as question_label
import math
import re
from decimal import Decimal, ROUND_HALF_UP
from statistics import median, pstdev
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, get, objects
from .dependencies import user, require
from .export_tables import ExportTable, FileFormat, table_response, workbook_response,ranking_response
from .review import results_for
from .room_tags import includes
from .result_filters import ResultFilters,result_filter_query,filter_rows,filter_options

router=APIRouter(prefix='/api/v1')
STATUS_NAMES={'completed':'已完成','pending':'待结分','absent':'缺考','unscanned':'未扫描'}


def rounded(value):
    return float(Decimal(str(value)).quantize(Decimal('.01'),rounding=ROUND_HALF_UP)) if value is not None else None


def describe(values,maximum,pass_ratio,excellent_ratio):
    count=len(values)
    amounts=[Decimal(str(v)) for v in values];full=Decimal(str(maximum))
    passed=sum(v>=full*Decimal(str(pass_ratio)) for v in amounts);excellent=sum(v>=full*Decimal(str(excellent_ratio)) for v in amounts)
    return {'analyzed':count,'average':rounded(sum(amounts)/count) if count else None,'median':rounded(median(values)) if count else None,'minimum':min(values) if count else None,'maximum':max(values) if count else None,'standard_deviation':rounded(pstdev(values)) if count else None,'score_rate':rounded(100*sum(amounts)/(full*count)) if count and full>0 else None,'pass_count':passed,'pass_rate':rounded(100*Decimal(passed)/count) if count else None,'excellent_count':excellent,'excellent_rate':rounded(100*Decimal(excellent)/count) if count else None}


def analyze(db,group_id,current,metric='raw',include_absent=False,pass_ratio=.6,excellent_ratio=.85,room_tag_id=None,filters=None):
    if metric not in ('raw','converted') or not math.isfinite(pass_ratio) or not math.isfinite(excellent_ratio) or not 0<=pass_ratio<=excellent_ratio<=1:raise HTTPException(422,'统计口径或比例无效')
    group=require(db,group_id,'groups')
    template=require(db,group.get('template_id'),'templates')
    scope_rows=results_for(db,group_id,current)
    rows=filter_rows(scope_rows,filters,room_tag_id)
    if filters and filters.group_ids and group_id not in filters.group_ids:rows=[]
    maximum=sum(q['points'] for q in template['questions'])
    if metric=='converted':
        if not group.get('conversion_id'):raise HTTPException(422,'本题卡组尚未配置赋分')
        from .conversion import active_config
        conversion=active_config(group,require(db,group['conversion_id'],'score-conversions'))
        maximum=max(float(v) for v in conversion['table'].values()) if conversion.get('mode')=='table' else max(float(s[k]) for s in conversion['segments'] for k in ('target_min','target_max'))
    key='total' if metric=='raw' else 'converted_score'
    def summarize(cohort):
        values=[r[key] for r in cohort if r.get(key) is not None and (include_absent or r['status']!='absent')]
        return {'records':len(cohort),'completed':sum(r['status']=='completed' for r in cohort),'absent':sum(r['status']=='absent' for r in cohort),'pending':sum(r['status']=='pending' for r in cohort),'unscanned':sum(r['status']=='unscanned' for r in cohort),**describe(values,maximum,pass_ratio,excellent_ratio)}
    by_class=[]
    for cid in sorted({r['class_id'] for r in rows}):
        cohort=[r for r in rows if r['class_id']==cid]
        by_class.append({'id':cid,'name':cohort[0]['class_name'],'grade':cohort[0]['grade'],**summarize(cohort)})
    questions=[]
    for q in template['questions']:
        values=[r['scores'][question_label(q)] for r in rows if r['scores'].get(question_label(q)) is not None and (include_absent or r['status']!='absent')]
        questions.append({'id':q['id'],'number':question_label(q) if q.get('parts') else q['number'],'type':q['type'],'points':q['points'],**describe(values,q['points'],pass_ratio,excellent_ratio)})
    eligible=[r for r in rows if r.get(key) is not None and (include_absent or r['status']!='absent')]
    rank_eligible=[r for r in scope_rows if r.get(key) is not None and (include_absent or r['status']!='absent')]
    # Competition ranks: ties share their rank and the next rank has a gap.
    score_counts={}
    class_counts={}
    for row in rank_eligible:
        value=row[key];score_counts[value]=score_counts.get(value,0)+1
        counts=class_counts.setdefault(row['class_id'],{});counts[value]=counts.get(value,0)+1
    def rank_map(counts):
        rank=1;mapping={}
        for score in sorted(counts,reverse=True):mapping[score]=rank;rank+=counts[score]
        return mapping
    overall_ranks=rank_map(score_counts);class_ranks={cid:rank_map(counts) for cid,counts in class_counts.items()}
    ranked=[]
    for row in rows:
        value=row.get(key);valid=value is not None and (include_absent or row['status']!='absent')
        ranked.append({**row,'scope_rank':overall_ranks[value] if valid else None,'class_rank':class_ranks[row['class_id']][value] if valid else None})
    values=[r[key] for r in eligible]
    from .scoring import cents
    low=min(0,min((cents(v) for v in values),default=0));high=max(cents(maximum),max((cents(v) for v in values),default=0));width=max(1,(high-low+9)//10)
    buckets=max(1,(high-low+width-1)//width)
    distribution=[{'lower':(low+i*width)/100,'upper':min(high,low+(i+1)*width)/100,'upper_inclusive':i==buckets-1,'count':0} for i in range(buckets)]
    for value in values:distribution[min(buckets-1,max(0,(cents(value)-low)//width))]['count']+=1
    return {'room_tag_id':room_tag_id,'group_id':group_id,'group_name':group['name'],'roster_configured':bool(group.get('roster_id') or group.get('grade_id')),'metric':metric,'full_score':maximum,'include_absent':include_absent,'pass_ratio':pass_ratio,'excellent_ratio':excellent_ratio,'rank_scope':'group' if current['role'] in ('admin','manager') else 'assigned_classes','summary':summarize(rows),'classes':by_class,'questions':questions,'distribution':distribution,'students':ranked}


@router.get('/analysis/group')
def group_analysis(group_id:str,metric:str='raw',include_absent:bool=False,pass_ratio:float=.6,excellent_ratio:float=.85,current=Depends(user),room_tag_id:str|None=None,filters:ResultFilters=Depends(result_filter_query)):
    with connect() as db:
        db.execute('BEGIN')
        return analyze(db,group_id,current,metric,include_absent,pass_ratio,excellent_ratio,room_tag_id,filters)


def project_result_groups(db,identifier,current):
    project=require(db,identifier,'projects')
    if project.get('category')=='statistics':
        raise HTTPException(404,'请在统计项目中查看选项汇总')
    subjects={s['id']:s for s in find(db,'subjects',project_id=identifier)}
    groups=[g for g in objects(db,'groups') if g.get('subject_id') in subjects and g.get('template_id')]
    if current['role'] not in ('admin','manager') and not any(current['id'] in c.get('teacher_ids',[]) for c in objects(db,'classes')):raise HTTPException(403,'未配置任教班级')
    if current['role'] not in ('admin','manager'):
        from .visibility import result_groups
        visible=result_groups(db,current['id'])
        groups=[g for g in groups if g['id'] in visible]
        if not groups:raise HTTPException(403,'本考试暂无任教班级已发布成绩')
    return project, subjects, groups


def project_rows(db,identifier,current,group_ids=None):
    project,subjects,groups=project_result_groups(db,identifier,current)
    if group_ids:groups=[g for g in groups if g['id'] in group_ids]
    columns=[];students={}
    for group in groups:
        rows=results_for(db,group['id'],current)
        if not rows and current['role'] not in ('admin','manager'):continue
        grade=(get(db,group.get('grade_id'),'grades') or {}).get('name','')
        columns.append({'id':group['id'],'subject_id':group['subject_id'],'subject':subjects[group['subject_id']]['name'],'grade':grade,'group':group['name'],'conversion_enabled':bool(group.get('conversion_id')),'published':bool(group.get('frozen'))})
        for row in rows:
            student=students.setdefault(row['student_id'],{k:row[k] for k in ('student_id','candidate_number','name','class_id','class_name','grade')})
            student.setdefault('scores',{})[group['id']]={'raw':row['total'],'converted':row.get('converted_score'),'status':row['status'],'room_tags':row.get('room_tags',[]),'grade_id':row.get('group_grade_id')}
    for student in students.values():
        scores=student['scores'].values()
        known=[s for s in scores if s['raw'] is not None]
        student.update(completed_records=sum(s['status']=='completed' for s in scores),absent_records=sum(s['status']=='absent' for s in scores),pending_records=sum(s['status']=='pending' for s in scores),unscanned_records=sum(s['status']=='unscanned' for s in scores),recorded_raw_sum=rounded(sum(s['raw'] for s in known)) if known else None,recorded_effective_sum=rounded(sum((s['converted'] if s['converted'] is not None else s['raw']) for s in known)) if known else None)
    return {'project_id':identifier,'project_name':project['name'],'columns':columns,'students':sorted(students.values(),key=lambda s:(s['class_name'],s['candidate_number']))}


@router.get('/analysis/project')
def project_analysis(project_id:str,current=Depends(user),room_tag_id:str|None=None,filters:ResultFilters=Depends(result_filter_query)):
    with connect() as db:
        db.execute('BEGIN')
        from .class_ranking import class_totals,filter_project
        return filter_project(class_totals(project_rows(db,project_id,current,filters.group_ids)),filters,room_tag_id)


@router.get('/analysis/project/class-summary')
def project_class_summary(project_id:str,current=Depends(user),room_tag_id:str|None=None,include_absent:bool=False,filters:ResultFilters=Depends(result_filter_query)):
    with connect() as db:
        db.execute('BEGIN')
        from .class_ranking import class_totals,filter_project
        return filter_project(class_totals(project_rows(db,project_id,current,filters.group_ids),include_absent),filters,room_tag_id)


@router.get('/analysis/filter-options')
def result_filter_options(group_id:str|None=None,project_id:str|None=None,current=Depends(user)):
    if bool(group_id)==bool(project_id):raise HTTPException(422,'请选择一个题卡或考试范围')
    with connect() as db:
        db.execute('BEGIN')
        if group_id:
            rows=results_for(db,group_id,current)
            group=require(db,group_id,'groups');subject=get(db,group.get('subject_id'),'subjects') or {}
            groups=[{'id':group['id'],'subject':subject.get('name',''),'name':group['name']}]
        else:
            from .class_ranking import class_totals
            data=class_totals(project_rows(db,project_id,current));rows=data['students']
            groups=[{**column,'name':' · '.join(v for v in (column['subject'],column['grade'],column['group']) if v)} for column in data['columns']]
        return {**filter_options(rows),'groups':groups}


def overview_rows(db,current,project_id=None,group_id=None,detail_id=None):
    """Comparable paper, subject, grade and class cohorts within the visible scope."""
    projects={p['id']:p for p in objects(db,'projects')}
    subjects={s['id']:s for s in objects(db,'subjects')}
    grades={g['id']:g for g in objects(db,'grades')}
    groups=[g for g in objects(db,'groups') if g.get('template_id') and g.get('frozen') and g.get('subject_id') in subjects and projects.get(subjects[g['subject_id']].get('project_id'),{}).get('category')!='statistics']
    if group_id:
        groups=[g for g in groups if g['id']==group_id]
    if project_id:
        require(db,project_id,'projects')
        groups=[g for g in groups if subjects[g['subject_id']]['project_id']==project_id]
    if current['role'] not in ('admin','manager'):
        from .visibility import result_groups
        visible=result_groups(db,current['id'])
        groups=[g for g in groups if g['id'] in visible]
    if detail_id:
        kind,_,scope=detail_id.partition(':')
        if kind=='card':
            groups=[g for g in groups if g['id']==scope]
        elif kind in ('subject','grade','class'):
            subject_id=scope.partition(':')[0]
            groups=[g for g in groups if g['subject_id']==subject_id]
        else:
            return []
    cohorts={}
    for group in groups:
        subject=subjects[group['subject_id']];project=projects.get(subject['project_id'])
        if not project:continue
        template=require(db,group['template_id'],'templates')
        maximum=sum(q['points'] for q in template.get('questions',[]))
        base={'project_id':project['id'],'project':project['name'],'subject':subject['name'],'subject_id':subject.get('subject_tag_id') or subject['name']}
        from .gradebook import published_rows
        rows=published_rows(db,group,current)
        for kind,cohort_key,label,subset,extra in [
            ('card',group['id'],group['name'],rows,{'grade':grades.get(group.get('grade_id'),{}).get('name',''),'grade_id':group.get('grade_id')}),
            ('subject',subject['id'],subject['name'],rows,{}),
            *[('grade',subject['id']+':'+str(grade),str(grade or '未设置年级'),[r for r in rows if r.get('grade')==grade],{'grade':grade,'grade_id':next((r.get('grade_id') or group.get('grade_id') for r in rows if r.get('grade')==grade),None)}) for grade in {r.get('grade') for r in rows}],
            *[('class',subject['id']+':'+cid,next(r['class_name'] for r in rows if r['class_id']==cid),[r for r in rows if r['class_id']==cid],{'class_id':cid,'class_name':next(r['class_name'] for r in rows if r['class_id']==cid),'grade':next(r.get('grade') for r in rows if r['class_id']==cid)}) for cid in {r['class_id'] for r in rows}],
        ]:
            key=kind+':'+cohort_key
            if detail_id and detail_id!=key:continue
            target=cohorts.setdefault(key,{'id':key,'kind':kind,'label':label,**base,**extra,'group_ids':set(),'values':[],'full_scores':set()})
            target['group_ids'].add(group['id'])
            target['full_scores'].add(maximum)
            record={'full_score':maximum}
            if detail_id:record.update(group_id=group['id'],card=group['name'])
            target['values'].extend({**r,**record} for r in subset)
    output=[]
    for cohort in cohorts.values():
        rows=cohort.pop('values')
        counts={}
        for row in rows:counts[row['student_id']]=counts.get(row['student_id'],0)+1
        rows=list({r['student_id']:{**r,'status':'duplicate_subject','total':None} if counts[r['student_id']]>1 else r for r in rows}.values())
        completed=[r for r in rows if r['status']=='completed' and r.get('total') is not None]
        full_scores=cohort.pop('full_scores');maximum=next(iter(full_scores)) if len(full_scores)==1 else None
        values=[r['total'] for r in completed]
        stats=describe(values,maximum or 0,.6,.85)
        rates=[100*r['total']/r['full_score'] for r in completed if r['full_score']>0]
        stats['score_rate']=rounded(sum(rates)/len(rates)) if rates else None
        stats['pass_rate']=rounded(100*sum(r['total']>=r['full_score']*.6 for r in completed)/len(completed)) if completed else None
        stats['excellent_rate']=rounded(100*sum(r['total']>=r['full_score']*.85 for r in completed)/len(completed)) if completed else None
        if detail_id:
            fields=('group_id','card','student_id','name','candidate_number','class_name','grade','total','status','full_score')
            cohort['students']=[{k:r.get(k) for k in fields} for r in rows]
        output.append({**cohort,'group_ids':sorted(cohort['group_ids']),'full_score':maximum,'records':len(rows),
                       **{status:sum(r['status']==status for r in rows) for status in ('completed','absent','pending','unscanned')},**stats})
    return sorted(output,key=lambda r:(r['project'],r['subject'],r['kind'],str(r.get('grade') or ''),r['label']))


@router.get('/analysis/overview')
def overview(project_id:str|None=None,group_id:str|None=None,current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN')
        return {'scopes':overview_rows(db,current,project_id,group_id)}


@router.get('/analysis/overview/detail')
def overview_detail(scope_id:str,project_id:str,group_id:str|None=None,current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN')
        rows=overview_rows(db,current,project_id,group_id,detail_id=scope_id)
        if not rows:raise HTTPException(404,'此统计范围不存在或不可查看')
        return rows[0]


@router.get('/analysis/overview/export')
def export_overview(scope_ids:str='',project_id:str|None=None,group_id:str|None=None,format:FileFormat='csv',current=Depends(user)):
    requested=set(scope_ids.split(',')) if scope_ids else None
    with connect() as db:
        db.execute('BEGIN')
        rows=overview_rows(db,current,project_id,group_id)
    if requested is not None:
        if requested-set(row['id'] for row in rows):raise HTTPException(403,'对比范围不存在或不可访问')
        rows=[row for row in rows if row['id'] in requested]
    fields=('project','subject','kind','grade','label','records','completed','pending','absent','unscanned','analyzed','average','full_score','score_rate','pass_rate','excellent_rate')
    names={'card':'题卡','subject':'科目','grade':'年级','class':'班级'}
    values=([names.get(row.get(key),row.get(key)) if key=='kind' else row.get(key) for key in fields] for row in rows)
    return table_response(ExportTable('成绩概览与对比',['考试','科目','范围类型','年级','范围','应考份次','已结分','待结分','缺考','未扫描','统计份数','平均分','满分','平均得分率%','及格率%','优秀率%'],values),'result-comparison',format)


def question_score_table(db, group, students, title):
    template = get(db, group.get('template_id'), 'templates') or {}
    labels = {question_label(q) for q in template.get('questions', [])}
    for row in students:
        labels.update(row['scores'])
    # Older submissions can refer to a previous template with different printed numbers.
    labels = sorted(labels, key=lambda label: tuple(map(int, re.findall(r'\d+', label))))
    headings = ['准考证号', '姓名', '班级', '状态', '总分', '赋分']
    for label in labels:
        combined = '～' in label or '、' in label
        headings.append(f'第{label}题' + ('（合计）' if combined else ''))
    headings.extend(['年级', '考场'])

    def student_rows():
        for row in students:
            yield [
                str(row['candidate_number']), row['name'], row['class_name'], STATUS_NAMES[row['status']],
                row['total'], row.get('converted_score'), *(row['scores'].get(label) for label in labels),
                row.get('grade'), '、'.join(tag.get('label') or tag['name'] for tag in row.get('room_tags', [])),
            ]

    return ExportTable(title, headings, student_rows(), 'C2')


@router.get('/results/export')
def export_results(group_id: str, room_tag_id: str | None = None, current=Depends(user), format: FileFormat = 'csv',filters:ResultFilters=Depends(result_filter_query)):
    with connect() as db:
        db.execute('BEGIN')
        group = require(db, group_id, 'groups')
        students = filter_rows(results_for(db, group_id, current),filters,room_tag_id)
        table = question_score_table(db, group, students, '小题分')
    return table_response(table, 'results', format)


@router.get('/analysis/group/export')
def export_group(group_id:str,view:str='classes',metric:str='raw',include_absent:bool=False,pass_ratio:float=.6,excellent_ratio:float=.85,current=Depends(user),room_tag_id:str|None=None,format:FileFormat='csv',filters:ResultFilters=Depends(result_filter_query)):
    with connect() as db:
        db.execute('BEGIN')
        data=analyze(db,group_id,current,metric,include_absent,pass_ratio,excellent_ratio,room_tag_id,filters)
        group=require(db,group_id,'groups')
        subject=get(db,group.get('subject_id'),'subjects') or {}
    if view=='ranking':
        from .class_ranking import subject_tables
        return ranking_response(subject_tables(data,subject.get('name',data['group_name']),bool(group.get('conversion_id'))),'class-subject-ranking',format)
    if view=='students':
        headers=['考号','姓名','班级','状态','原始分','赋分','当前可见范围排名','班级排名','考场','年级']
        rows=([STATUS_NAMES.get(r.get(k),r.get(k)) if k=='status' else r.get(k) for k in ('candidate_number','name','class_name','status','total','converted_score','scope_rank','class_rank')]+['、'.join(t.get('label',t['name']) for t in r.get('room_tags',[])),r.get('grade')] for r in data['students'])
        return table_response(ExportTable('考生成绩与排名',headers,rows,'C2'),'student-analysis',format)
    if view=='distribution':
        rows=([r['lower'],r['upper'],r['upper_inclusive'],r['count']] for r in data['distribution'])
        return table_response(ExportTable('分数分布',['下界（含）','上界','上界包含','人数'],rows),'score-distribution',format)
    if view not in ('classes','questions'):raise HTTPException(422,'导出类型无效')
    fields=('analyzed','average','median','minimum','maximum','standard_deviation','score_rate','pass_count','pass_rate','excellent_count','excellent_rate')
    headers=['班级' if view=='classes' else '题号','统计口径','满分','缺考参与统计','及格比例','优秀比例','统计人数','平均分','中位数','最低分','最高分','标准差','得分率%','及格人数','及格率%','优秀人数','优秀率%']
    rows=([r['name'] if view=='classes' else r['number'],'原始分' if view=='questions' or metric=='raw' else '赋分',r['points'] if view=='questions' else data['full_score'],include_absent,pass_ratio,excellent_ratio]+[r[k] for k in fields] for r in data[view])
    return table_response(ExportTable('班级统计' if view=='classes' else '单题分析',headers,rows),view+'-analysis',format)


@router.get('/analysis/project/export')
def export_project(project_id:str,current=Depends(user),view:Literal['summary','items','class-summary']='summary',format:FileFormat|None=None,room_tag_id:str|None=None,include_absent:bool=False,filters:ResultFilters=Depends(result_filter_query)):
    if view=='class-summary':
        from .class_ranking import project_tables
        data=project_class_summary(project_id,current,room_tag_id,include_absent,filters)
        return ranking_response(project_tables(data),'class-summary',format or 'xlsx')
    if view == 'items':
        if format == 'csv':
            raise HTTPException(422, '多题卡小题分请使用 Excel 工作簿')
        selected_students={row['student_id'] for row in project_analysis(project_id,current,room_tag_id,filters)['students']}
        with connect() as db:
            db.execute('BEGIN')
            _, subjects, groups = project_result_groups(db, project_id, current)
            if filters.group_ids:groups=[group for group in groups if group['id'] in filters.group_ids]
            grades = {g['id']: g['name'] for g in objects(db, 'grades')}
            def sheets():
                for group in groups:
                    students = [row for row in results_for(db, group['id'], current) if row['student_id'] in selected_students]
                    if not students and current['role'] not in ('admin', 'manager'):
                        continue
                    subject = subjects[group['subject_id']]['name']
                    grade = grades.get(group.get('grade_id'), '')
                    card = subject + '题卡' if group.get('is_default') or group['name'] == 'Default' else group['name']
                    title = '·'.join(part for part in (subject, grade, card) if part)
                    yield question_score_table(db, group, students, title)
            return workbook_response(sheets(), 'project-question-scores')
    data=project_analysis(project_id,current,room_tag_id,filters)
    columns=data['columns']
    headers=['考号','姓名','班级','已完成记录','缺考记录','待结分记录','未扫描记录','已记录原始分合计','已记录采用分合计']
    for col in columns:headers.extend('/'.join(v for v in (col['subject'],col['grade'],col['group']) if v)+f' {name}' for name in ('原始分','赋分','状态','考场'))
    rows=[]
    for student in data['students']:
        row=[student[k] for k in ('candidate_number','name','class_name','completed_records','absent_records','pending_records','unscanned_records','recorded_raw_sum','recorded_effective_sum')]
        for col in columns:
            score=student['scores'].get(col['id'],{})
            row.extend(STATUS_NAMES.get(score.get(k),score.get(k)) if k=='status' else score.get(k) for k in ('raw','converted','status'))
            row.append('、'.join(t.get('label',t['name']) for t in score.get('room_tags',[])))
        rows.append(row+[student.get('grade')])
    return table_response(ExportTable('跨科成绩汇总',headers+['学生年级'],rows,'C2'),'project-results',format or 'csv')


def detail_question(db,group_id,question_id):
    group=require(db,group_id,'groups')
    template=require(db,group.get('template_id'),'templates')
    q=next((q for q in template['questions'] if q['id']==question_id),None)
    if q is None:raise HTTPException(404,'题目不存在')
    return q


@router.get('/analysis/groups/{group_id}/questions/{question_id}')
def answer_details(group_id:str,question_id:str,room_tag_id:str|None=None,include_absent:bool=False,current=Depends(user),filters:ResultFilters=Depends(result_filter_query)):
    from .room_tags import includes
    with connect() as db:
        db.execute('BEGIN')
        rows=filter_rows(results_for(db,group_id,current,convert_scores=False),filters,room_tag_id)
        q=detail_question(db,group_id,question_id)
        subs={s['student_id']:s for s in find(db,'submissions',group_id=group_id)}
        label=question_label(q)
        objective=q['type']!='subjective'
        counts={k:0 for k in 'ABCDEFG'[:q.get('options',4)]} if objective else {}
        rows_out=[];respondents=0;blank=0
        versions={}
        for r in rows:
            if not includes(r,room_tag_id) or (r['status']=='absent' and not include_absent):continue
            sub=subs.get(r['student_id'])
            item={k:r[k] for k in ('student_id','candidate_number','name','class_name','status')}
            item['score']=r['scores'].get(label)
            if sub and r['status']!='absent':
                tid=sub['template_id']
                if tid not in versions:
                    versions[tid]={question_label(v):v for v in require(db,tid,'templates')['questions']}
                actual=versions[tid].get(label)
                if actual and actual['type']==q['type']:
                    if objective:
                        qid=actual['id'];selected=sub.get('objective_overrides',{}).get(qid)
                        if selected is None:
                            selected={a for pid in sub['pages'] for a in require(db,pid,'pages').get('selections',{}).get(qid,[])}
                        item.update(selected=sorted(set(selected)),answer=actual.get('answer',[]))
                        respondents+=1
                        if not selected:blank+=1
                        for a in set(selected):counts[a]=counts.get(a,0)+1
                    else:item['image_url']=f"/api/v1/analysis/groups/{group_id}/answers/{sub['id']}/{actual['id']}/image"
            rows_out.append(item)
        return {'rows':rows_out,'counts':counts,'respondents':respondents,'blank':blank,'answer':q.get('answer',[])}


def detail_image_context(group_id,submission_id,question_id,current):
    with connect() as db:
        db.execute('BEGIN')
        sub=require(db,submission_id,'submissions')
        from .lifecycle import writable
        writable(db,'submissions',sub)
        if sub['group_id']!=group_id or not any(r['student_id']==sub['student_id'] for r in results_for(db,group_id,current,convert_scores=False)):
            raise HTTPException(403,'无权查看该答卷')
        q=next((v for v in require(db,sub['template_id'],'templates')['questions'] if v['id']==question_id and v['type']=='subjective'),None)
        if not q:raise HTTPException(404,'主观题不存在')
        answer=get(db,sub.get('answer_slice_ids',{}).get(question_id),'answer-slices')
        template=require(db,sub['template_id'],'templates')
    return sub,template,q,answer


@router.get('/analysis/groups/{group_id}/answers/{submission_id}/{question_id}/image')
def detail_image(group_id:str,submission_id:str,question_id:str,current=Depends(user)):
    from .review import render_answer_image
    sub,template,q,answer=detail_image_context(group_id,submission_id,question_id,current)
    return render_answer_image(sub,template,q,answer)


@router.get('/analysis/groups/{group_id}/answers/{submission_id}/{question_id}/image-manifest')
def detail_image_manifest(group_id:str,submission_id:str,question_id:str,current=Depends(user)):
    from .review_images import answer_sources,manifest_for
    from fastapi.responses import JSONResponse
    sub,template,q,answer=detail_image_context(group_id,submission_id,question_id,current)
    with connect() as db:mode,rows=answer_sources(db,sub,template,q,answer)
    base=f'/analysis/groups/{group_id}/answers/{submission_id}/{question_id}'
    return JSONResponse(manifest_for(mode,rows,base),headers={'Cache-Control':'private, no-store'})


@router.get('/analysis/groups/{group_id}/answers/{submission_id}/{question_id}/image-source/{index}')
def detail_image_source(group_id:str,submission_id:str,question_id:str,index:int,version:str='',current=Depends(user)):
    from .review_images import answer_sources,proxy_for
    sub,template,q,answer=detail_image_context(group_id,submission_id,question_id,current)
    with connect() as db:_,rows=answer_sources(db,sub,template,q,answer)
    return proxy_for(rows,index,version)
