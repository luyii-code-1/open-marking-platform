from .merged_questions import label as question_label
import csv
import io
import math
from decimal import Decimal, ROUND_HALF_UP
from statistics import median, pstdev

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from .db import connect, find, get, objects
from .dependencies import user, require
from .review import results_for

router=APIRouter(prefix='/api/v1')
STATUS_NAMES={'completed':'已完成','pending':'待结分','absent':'缺考','unscanned':'未扫描'}


def rounded(value):
    return float(Decimal(str(value)).quantize(Decimal('.01'),rounding=ROUND_HALF_UP)) if value is not None else None


def describe(values,maximum,pass_ratio,excellent_ratio):
    count=len(values)
    amounts=[Decimal(str(v)) for v in values];full=Decimal(str(maximum))
    passed=sum(v>=full*Decimal(str(pass_ratio)) for v in amounts);excellent=sum(v>=full*Decimal(str(excellent_ratio)) for v in amounts)
    return {'analyzed':count,'average':rounded(sum(amounts)/count) if count else None,'median':rounded(median(values)) if count else None,'minimum':min(values) if count else None,'maximum':max(values) if count else None,'standard_deviation':rounded(pstdev(values)) if count else None,'score_rate':rounded(100*sum(amounts)/(full*count)) if count and full>0 else None,'pass_count':passed,'pass_rate':rounded(100*Decimal(passed)/count) if count else None,'excellent_count':excellent,'excellent_rate':rounded(100*Decimal(excellent)/count) if count else None}


def analyze(db,group_id,current,metric='raw',include_absent=False,pass_ratio=.6,excellent_ratio=.85,room_tag_id=None):
    if metric not in ('raw','converted') or not math.isfinite(pass_ratio) or not math.isfinite(excellent_ratio) or not 0<=pass_ratio<=excellent_ratio<=1:raise HTTPException(422,'统计口径或比例无效')
    group=require(db,group_id,'groups')
    template=require(db,group.get('template_id'),'templates')
    from .room_tags import includes
    rows=[r for r in results_for(db,group_id,current) if includes(r,room_tag_id)]
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
    # Competition ranks: ties share their rank and the next rank has a gap.
    score_counts={}
    class_counts={}
    for row in eligible:
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
def group_analysis(group_id:str,metric:str='raw',include_absent:bool=False,pass_ratio:float=.6,excellent_ratio:float=.85,current=Depends(user),room_tag_id:str|None=None):
    with connect() as db:
        db.execute('BEGIN')
        return analyze(db,group_id,current,metric,include_absent,pass_ratio,excellent_ratio,room_tag_id)


def project_rows(db,identifier,current):
    project=require(db,identifier,'projects')
    subjects={s['id']:s for s in find(db,'subjects',project_id=identifier)}
    groups=[g for g in objects(db,'groups') if g.get('subject_id') in subjects and g.get('template_id')]
    if current['role'] not in ('admin','manager') and not any(current['id'] in c.get('teacher_ids',[]) for c in objects(db,'classes')):raise HTTPException(403,'未配置任教班级')
    if current['role'] not in ('admin','manager'):
        from .visibility import result_groups
        visible=result_groups(db,current['id'])
        groups=[g for g in groups if g['id'] in visible]
        if not groups:raise HTTPException(403,'本考试暂无任教班级已发布成绩')
    columns=[];students={}
    for group in groups:
        if current['role'] not in ('admin','manager') and not group.get('frozen'):continue
        rows=results_for(db,group['id'],current)
        if not rows and current['role'] not in ('admin','manager'):continue
        grade=(get(db,group.get('grade_id'),'grades') or {}).get('name','')
        columns.append({'id':group['id'],'subject_id':group['subject_id'],'subject':subjects[group['subject_id']]['name'],'grade':grade,'group':group['name'],'published':bool(group.get('frozen'))})
        for row in rows:
            student=students.setdefault(row['student_id'],{k:row[k] for k in ('student_id','candidate_number','name','class_id','class_name','grade')})
            student.setdefault('scores',{})[group['id']]={'raw':row['total'],'converted':row.get('converted_score'),'status':row['status'],'room_tags':row.get('room_tags',[]),'grade_id':row.get('group_grade_id')}
    for student in students.values():
        scores=student['scores'].values()
        known=[s for s in scores if s['raw'] is not None]
        student.update(completed_records=sum(s['status']=='completed' for s in scores),absent_records=sum(s['status']=='absent' for s in scores),pending_records=sum(s['status']=='pending' for s in scores),unscanned_records=sum(s['status']=='unscanned' for s in scores),recorded_raw_sum=rounded(sum(s['raw'] for s in known)) if known else None,recorded_effective_sum=rounded(sum((s['converted'] if s['converted'] is not None else s['raw']) for s in known)) if known else None)
    return {'project_id':identifier,'project_name':project['name'],'columns':columns,'students':sorted(students.values(),key=lambda s:(s['class_name'],s['candidate_number']))}


@router.get('/analysis/project')
def project_analysis(project_id:str,current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN')
        return project_rows(db,project_id,current)


def csv_response(headers,rows,filename):
    from .operations import csv_cell
    output=io.StringIO(newline='');writer=csv.writer(output);writer.writerow([csv_cell(v) for v in headers])
    for row in rows:writer.writerow([csv_cell(v) for v in row])
    return Response(('\ufeff'+output.getvalue()).encode('utf-8'),media_type='text/csv; charset=utf-8',headers={'Content-Disposition':f'attachment; filename={filename}.csv'})


@router.get('/analysis/group/export')
def export_group(group_id:str,view:str='classes',metric:str='raw',include_absent:bool=False,pass_ratio:float=.6,excellent_ratio:float=.85,current=Depends(user),room_tag_id:str|None=None):
    data=group_analysis(group_id,metric,include_absent,pass_ratio,excellent_ratio,current,room_tag_id)
    if view=='students':
        return csv_response(['考号','姓名','班级','状态','原始分','赋分','当前可见范围排名','班级排名','考场','年级'],[[STATUS_NAMES.get(r.get(k),r.get(k)) if k=='status' else r.get(k) for k in ('candidate_number','name','class_name','status','total','converted_score','scope_rank','class_rank')]+['、'.join(t.get('label',t['name']) for t in r.get('room_tags',[])),r.get('grade')] for r in data['students']],'student-analysis')
    if view=='distribution':
        return csv_response(['下界（含）','上界','上界包含','人数'],[[r['lower'],r['upper'],r['upper_inclusive'],r['count']] for r in data['distribution']],'score-distribution')
    if view not in ('classes','questions'):raise HTTPException(422,'导出类型无效')
    fields=('analyzed','average','median','minimum','maximum','standard_deviation','score_rate','pass_count','pass_rate','excellent_count','excellent_rate')
    return csv_response(['班级' if view=='classes' else '题号','统计口径','满分','缺考参与统计','及格比例','优秀比例','统计人数','平均分','中位数','最低分','最高分','标准差','得分率%','及格人数','及格率%','优秀人数','优秀率%'],[[r['name'] if view=='classes' else r['number'],'原始分' if view=='questions' or metric=='raw' else '赋分',r['points'] if view=='questions' else data['full_score'],include_absent,pass_ratio,excellent_ratio]+[r[k] for k in fields] for r in data[view]],view+'-analysis')


@router.get('/analysis/project/export')
def export_project(project_id:str,current=Depends(user)):
    data=project_analysis(project_id,current)
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
    return csv_response(headers+['学生年级'],rows,'project-results')
