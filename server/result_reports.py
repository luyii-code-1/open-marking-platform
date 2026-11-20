"""Teacher-facing score reports, with one authoritative calculation per report."""
import io
import math
import re
import zipfile
from collections import Counter
from dataclasses import dataclass
from statistics import pstdev
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from .db import connect, find, get, objects
from .dependencies import user, require
from .result_filters import ResultFilters, result_filter_query
from .merged_questions import label as question_label
from .export_tables import worksheet_name, XLSX_TYPE

router = APIRouter(prefix='/api/v1/analysis')
REPORT_NAMES = {'items':'小题分', 'averages':'小题平均分对比', 'questions':'试题分析', 'ranks':'名次段分析', 'bands':'分数段分析'}
STATUSES = {'completed':'已完成','pending':'待结分','absent':'缺考','unscanned':'未扫描'}


@router.get('/class-catalog')
def class_catalog(current=Depends(user)):
    from .school import group_students
    from .visibility import result_groups, permits
    with connect() as db:
        db.execute('BEGIN')
        admin=current['role'] in ('admin','manager')
        visible=None if admin else result_groups(db,current['id'])
        classes={c['id']:c for c in objects(db,'classes')};subjects={s['id']:s for s in objects(db,'subjects')}
        students={s['id']:s for s in objects(db,'students')};submissions=objects(db,'submissions');grades={g['id']:g['name'] for g in objects(db,'grades')}
        cards=[]
        for card in objects(db,'groups'):
            if not card.get('template_id') or (visible is not None and card['id'] not in visible):continue
            subject=subjects.get(card['subject_id'])
            if not subject:continue
            members=group_students(db,card)
            ids={s['class_id'] for s in members or []}
            for sub in submissions:
                if sub['group_id']!=card['id']:continue
                student=students.get(sub['student_id'],{}) if card.get('grade_id') else sub.get('student_snapshot') or students.get(sub['student_id'],{})
                if student.get('class_id'):ids.add(student['class_id'])
            ids={cid for cid in ids if cid in classes and (admin or permits(classes[cid],current['id'],subject['name'].strip()))}
            cards.append({'id':card['id'],'name':card['name'],'subject':subject['name'],'project_id':subject['project_id'],'grade':grades.get(card.get('grade_id'),''),'class_ids':sorted(ids),'conversion_enabled':bool(card.get('conversion_id')),'published':bool(card.get('frozen'))})
        projects=[]
        for project in reversed(objects(db,'projects')):
            selected=[c for c in cards if c['project_id']==project['id']]
            if not selected:continue
            ids=set().union(*(set(c['class_ids']) for c in selected))
            rows=[]
            for cid in ids:
                cls=classes[cid];grade=grades.get(cls.get('grade_id'),cls.get('grade',''))
                rows.append({'id':cid,'name':cls['name'],'grade':grade,'all_subjects':admin or cls.get('teaching',{}).get(current['id'],{}).get('homeroom') is True})
            projects.append({'id':project['id'],'name':project['name'],'cards':selected,'classes':sorted(rows,key=lambda c:(str(c['grade'] or ''),c['name']))})
        return {'projects':projects}


@dataclass
class ReportTable:
    name: str
    columns: list
    rows: list
    frozen_columns: int = 1


def leaf(key, title, width=12):
    return {'key':key, 'title':title, 'width':width}


def group(title, columns):
    return {'title':title,'children':columns}


def leaves(columns):
    return [child for column in columns for child in column.get('children',[column])]


def mean(values):
    from .analysis import rounded
    return rounded(sum(values)/len(values)) if values else None


def percent(count, total):
    from .analysis import rounded
    return rounded(100*count/total) if total else None


def rank_limits(value):
    try:
        parts=value.split(',')
        if not 1 <= len(parts) <= 20 or any(not re.fullmatch(r'\s*[0-9]+\s*',part) for part in parts):raise ValueError()
        result=sorted(set(int(part) for part in parts))
        if not result or result[0]<1 or result[-1]>1000000:raise ValueError()
        return result
    except (ValueError, AttributeError):raise HTTPException(422,'名次段应填写1至1000000之间的整数，最多20项，以逗号分隔')


def prepare(db, group_id, current, filters=None, room_tag_id=None, metric='raw', score_step=10, ranks='10,30,50,100,200'):
    from .analysis import analyze
    if not math.isfinite(score_step) or score_step<=0:raise HTTPException(422,'分数段间隔应大于0')
    limits=rank_limits(ranks)
    data=analyze(db,group_id,current,metric=metric,filters=filters,room_tag_id=room_tag_id)
    if math.ceil(data['full_score']/score_step)>200:raise HTTPException(422,'分数段最多200段，请增大分段间隔')
    card=require(db,group_id,'groups');template=require(db,card['template_id'],'templates')
    subject=require(db,card['subject_id'],'subjects');project=require(db,subject['project_id'],'projects')
    questions=sorted(template.get('questions',[]),key=lambda q:q['number'])
    subs={s['student_id']:s for s in find(db,'submissions',group_id=group_id)}
    page_cache={};students=[]
    for row in data['students']:
        sub=subs.get(row['student_id']);answers={}
        if sub and row['status'] not in ('absent','unscanned'):
            for q in questions:
                if q['type']=='subjective':continue
                if q['id'] in sub.get('objective_overrides',{}):selected=sub['objective_overrides'][q['id']]
                else:
                    selected=[]
                    for pid in sub.get('pages',[]):
                        if pid not in page_cache:page_cache[pid]=get(db,pid,'pages') or {}
                        selected.extend(page_cache[pid].get('selections',{}).get(q['id'],[]))
                answers[q['id']]=sorted(set(selected))
        students.append({**row,'answers':answers})
    return {**data,'students':students,'question_definitions':questions,'rank_limits':limits,'score_step':score_step,
            'title':' · '.join((project['name'],subject['name'],card['name']))}


def score(row, q):
    return row['scores'].get(question_label(q)) if row['status'] not in ('absent','unscanned') else None


def subtotal(row, questions):
    values=[score(row,q) for q in questions]
    return round(sum(values),2) if values and all(v is not None for v in values) else None


def qtitle(q):
    name={'single':'单选','multiple':'多选','subjective':'第'}[q['type']]+question_label(q)
    return f"{name}{'题' if q['type']=='subjective' else ''}（{q['points']:g}分{'，合计' if q.get('parts') else ''}）"


def cohorts(students):
    classes={}
    for row in students:classes.setdefault(row['class_id'],[]).append(row)
    groups=[(str(rows[0].get('grade') or '')+' '+rows[0]['class_name'], rows) for rows in sorted(classes.values(),key=lambda rows:(str(rows[0].get('grade') or ''),[int(t) if t.isdigit() else t for t in re.split(r'(\d+)',rows[0]['class_name'])]))]
    return groups+[('当前范围合计',students)]


def tables(data):
    from .analysis import rounded
    qs=data['question_definitions'];students=data['students'];objective=[q for q in qs if q['type']!='subjective'];subjective=[q for q in qs if q['type']=='subjective']
    identity=[leaf('candidate_number','准考证号',18),leaf('name','姓名',12),leaf('grade','年级',12),leaf('class_name','行政班级',14),leaf('state','状态',12)]
    totals=[leaf('total','全卷'),leaf('objective','客观题'),leaf('subjective','主观题')]
    if any('converted_score' in row for row in students):totals.append(leaf('converted','赋分'))
    item_columns=[*identity,group('成绩汇总',totals)]
    for q in qs:
        cols=[leaf(q['id'],'得分',24 if q['type']=='subjective' else 10)]
        if q['type']!='subjective':cols.append(leaf(q['id']+'-answer','作答（答案'+(''.join(q.get('answer',[])) or '待录入')+'）',17))
        item_columns.append(group(qtitle(q),cols))
    item_rows=[]
    for row in sorted(students,key=lambda r:(str(r.get('grade') or ''),r['class_name'],r['candidate_number'])):
        value={k:row.get(k) for k in ('candidate_number','name','grade','class_name')}
        value.update(state=STATUSES[row['status']],total=row['total'] if row['status']!='absent' else None,objective=subtotal(row,objective),subjective=subtotal(row,subjective),converted=row.get('converted_score') if row['status']!='absent' else None)
        for q in qs:
            value[q['id']]=score(row,q)
            if q['type']!='subjective':value[q['id']+'-answer']=(''.join(row['answers'][q['id']]) or '留空') if q['id'] in row['answers'] else None
        item_rows.append(value)
    result={'items':ReportTable(REPORT_NAMES['items'],item_columns,item_rows,5)}
    average_columns=[leaf('class','班级',22),leaf('records','应考人数'),leaf('completed','已结分'),leaf('absent','缺考'),leaf('unscanned','未扫描'),leaf('pending','待结分')]
    average_columns += [group(qtitle(q),[leaf(q['id'],'均分'),leaf(q['id']+'-rate','得分率（%）',15)]) for q in qs]
    averages=[]
    for name,rows in cohorts(students):
        value={'class':name,'records':len(rows),**{s:sum(r['status']==s for r in rows) for s in STATUSES}}
        for q in qs:
            values=[v for row in rows if (v:=score(row,q)) is not None];average=mean(values)
            value[q['id']]=average;value[q['id']+'-rate']=percent(sum(values),len(values)*q['points'])
        averages.append(value)
    result['averages']=ReportTable(REPORT_NAMES['averages'],average_columns,averages)
    options=list('ABCDE'[:max((q.get('options',4) for q in objective),default=4)])
    question_columns=[leaf('question','题号',24),leaf('answer','标准答案',14),leaf('points','满分'),leaf('analyzed','评分人数'),leaf('respondents','作答人数'),leaf('maximum','最大值'),leaf('minimum','最小值'),leaf('average','平均分'),leaf('deviation','标准差'),leaf('rate','得分率（%）',15),leaf('full_rate','满分率（%）',15),leaf('zero_rate','零分率（%）',15),leaf('difficulty','难度')]
    question_columns += [group(option,[leaf(option+'-count','人数'),leaf(option+'-rate','选率（%）',14)]) for option in [*options,'多选','留空']]
    analyzed=[]
    for q in qs:
        values=[v for row in students if (v:=score(row,q)) is not None]
        answers=[row['answers'][q['id']] for row in students if q['id'] in row['answers']]
        average=mean(values)
        value={'question':qtitle(q),'answer':''.join(q.get('answer',[])) or ('待录入' if q['type']!='subjective' else None),'points':q['points'],'analyzed':len(values),'respondents':len(answers) if q['type']!='subjective' else None,'maximum':max(values,default=None),'minimum':min(values,default=None),'average':average,'deviation':rounded(pstdev(values)) if values else None,'rate':percent(sum(values),len(values)*q['points']),'full_rate':percent(sum(v==q['points'] for v in values),len(values)),'zero_rate':percent(values.count(0),len(values)),'difficulty':rounded(sum(values)/(len(values)*q['points'])) if values and q['points'] else None}
        if q['type']!='subjective':
            for option in [*options,'多选','留空']:
                count=sum((len(a)>1 if option=='多选' else len(a)==0 if option=='留空' else option in a) for a in answers)
                value[option+'-count']=count;value[option+'-rate']=percent(count,len(answers))
        analyzed.append(value)
    result['questions']=ReportTable(REPORT_NAMES['questions'],question_columns,analyzed)
    cs=cohorts(students);key='converted_score' if data['metric']=='converted' else 'total'
    eligible=lambda rows:[r for r in rows if r['status']=='completed' and r.get(key) is not None]
    ranks=[]
    for limit in data['rank_limits']:
        value={'band':f'前{limit}名'}
        for index,(_,rows) in enumerate(cs):
            selected=[r[key] for r in eligible(rows) if r.get('scope_rank') is not None and r['scope_rank']<=limit]
            value[f'{index}-count']=len(selected);value[f'{index}-mean']=mean(selected)
        ranks.append(value)
    bands=[];step=data['score_step'];top=max(0,math.ceil(data['full_score']/step)-1)
    for segment in range(top,-1,-1):
        lower=round(segment*step,6);upper=round((segment+1)*step,6)
        value={'band':f'{lower:g}分及以上' if segment==top else f'[{lower:g}, {upper:g})'}
        for index,(_,rows) in enumerate(cs):
            values=[r[key] for r in eligible(rows)]
            count=sum(v>=lower and (segment==top or v<upper) for v in values);cumulative=sum(v>=lower for v in values)
            value.update({f'{index}-count':count,f'{index}-cumulative':cumulative,f'{index}-rate':percent(cumulative,len(values))})
        bands.append(value)
    for label,fn in [('人数',len),('最高分',lambda v:max(v,default=None)),('最低分',lambda v:min(v,default=None)),('平均分',mean),('标准差',lambda v:rounded(pstdev(v)) if v else None)]:
        value={'band':label}
        for index,(_,rows) in enumerate(cs):value[f'{index}-count']=fn([r[key] for r in eligible(rows)])
        ranks.append(dict(value));bands.append(dict(value))
    result['ranks']=ReportTable(REPORT_NAMES['ranks'],[leaf('band','名次段',20)]+[group(name,[leaf(f'{i}-count','人数'),leaf(f'{i}-mean','均分')]) for i,(name,_) in enumerate(cs)],ranks)
    result['bands']=ReportTable(REPORT_NAMES['bands'],[leaf('band','分数段',20)]+[group(name,[leaf(f'{i}-count','本段'),leaf(f'{i}-cumulative','累计'),leaf(f'{i}-rate','累计比例（%）',18)]) for i,(name,_) in enumerate(cs)],bands)
    return result


def xlsx(data, selected='workbook'):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
    from openpyxl.utils import get_column_letter
    reports=tables(data)
    if selected!='workbook' and selected not in reports:raise HTTPException(422,'导出报表类型无效')
    book=Workbook();book.remove(book.active);taken=set()
    for report in reports.values() if selected=='workbook' else [reports[selected]]:
        sheet=book.create_sheet(worksheet_name(report.name,taken));cols=leaves(report.columns);size=len(cols)
        sheet.sheet_view.showGridLines=False
        sheet.merge_cells(start_row=1,start_column=1,end_row=1,end_column=size)
        sheet.cell(1,1,report.name+' · '+data['title']).font=Font(name='微软雅黑',size=14,bold=True)
        sheet.cell(1,1).data_type='s';sheet.row_dimensions[1].height=28
        at=1
        for column in report.columns:
            children=column.get('children')
            if children:
                if len(children)>1:sheet.merge_cells(start_row=2,start_column=at,end_row=2,end_column=at+len(children)-1)
                sheet.cell(2,at,column['title']).data_type='s'
                for child in children:sheet.cell(3,at,child['title']).data_type='s';at+=1
            else:
                sheet.merge_cells(start_row=2,start_column=at,end_row=3,end_column=at)
                sheet.cell(2,at,column['title']).data_type='s';at+=1
        for row in sheet.iter_rows(min_row=2,max_row=3,max_col=size):
            for cell in row:
                cell.fill=PatternFill('solid',fgColor='E9EEF4');cell.font=Font(name='微软雅黑',size=10,bold=True,color='172B3A')
                cell.alignment=Alignment(horizontal='center',vertical='center',wrap_text=True)
                cell.border=Border(bottom=Side(style='thin',color='B8C5D1'))
        for i,column in enumerate(cols,1):sheet.column_dimensions[get_column_letter(i)].width=column['width']
        for r,record in enumerate(report.rows,4):
            for c,column in enumerate(cols,1):
                value=record.get(column['key']);cell=sheet.cell(r,c,ILLEGAL_CHARACTERS_RE.sub('',value) if isinstance(value,str) else value)
                if isinstance(value,str):cell.data_type='s';cell.number_format='@'
                cell.font=Font(name='微软雅黑',size=10)
                cell.alignment=Alignment(horizontal='right' if isinstance(value,(int,float)) else 'left',vertical='center')
                if isinstance(value,(int,float)):cell.number_format='0' if float(value).is_integer() else '0.00'
            sheet.row_dimensions[r].height=21
        sheet.row_dimensions[2].height=40;sheet.row_dimensions[3].height=28
        sheet.freeze_panes=f'{get_column_letter(report.frozen_columns+1)}4'
        sheet.auto_filter.ref=f'A3:{get_column_letter(size)}{max(3,sheet.max_row)}' if report.name=='小题分' else None
        sheet.print_title_rows='1:3';sheet.sheet_properties.pageSetUpPr.fitToPage=True
        sheet.page_setup.orientation='landscape';sheet.page_setup.paperSize=sheet.PAPERSIZE_A3 if size>20 else sheet.PAPERSIZE_A4
        sheet.page_setup.fitToWidth=0 if size>20 else 1;sheet.page_setup.fitToHeight=0
        sheet.print_title_cols=f'A:{get_column_letter(report.frozen_columns)}'
        sheet.sheet_properties.outlinePr.summaryRight=False
        if report.name in (REPORT_NAMES['averages'],REPORT_NAMES['questions']):
            note_row=sheet.max_row+2
            sheet.merge_cells(start_row=note_row,start_column=1,end_row=note_row,end_column=size)
            note=sheet.cell(note_row,1,'小题统计按该题已评分的实考答卷计算；作答选率按实考作答人数计算。名次段和分数段仅统计已结分实考答卷。')
            note.font=Font(name='微软雅黑',size=10,italic=True,color='526579');note.alignment=Alignment(vertical='center',wrap_text=True)
            sheet.row_dimensions[note_row].height=28
    output=io.BytesIO();book.save(output);return output.getvalue()


@router.get('/reports')
def report_data(group_id:str,current=Depends(user),filters:ResultFilters=Depends(result_filter_query),room_tag_id:str|None=None,metric:str='raw',score_step:float=10,ranks:str='10,30,50,100,200'):
    with connect() as db:
        db.execute('BEGIN');data=prepare(db,group_id,current,filters,room_tag_id,metric,score_step,ranks)
        return {'group_id':group_id,'title':data['title'],'metric':metric,'summary':data['summary'],'rank_scope':data['rank_scope'],
                'reports':{key:{'name':table.name,'columns':table.columns,'rows':table.rows} for key,table in tables(data).items()}}


@router.get('/reports/export')
def export_reports(group_id:str|None=None,project_id:str|None=None,report:str='workbook',current=Depends(user),filters:ResultFilters=Depends(result_filter_query),room_tag_id:str|None=None,metric:str='raw',score_step:float=10,ranks:str='10,30,50,100,200'):
    if bool(group_id)==bool(project_id):raise HTTPException(422,'请选择一个题卡或考试范围')
    if report!='workbook' and report not in REPORT_NAMES:raise HTTPException(422,'导出报表类型无效')
    with connect() as db:
        db.execute('BEGIN')
        if group_id:
            content=xlsx(prepare(db,group_id,current,filters,room_tag_id,metric,score_step,ranks),report)
            return Response(content,media_type=XLSX_TYPE,headers={'Content-Disposition':'attachment; filename="score-reports.xlsx"','Cache-Control':'private, no-store'})
        from .analysis import project_result_groups
        _,subjects,cards=project_result_groups(db,project_id,current)
        if filters.group_ids:cards=[c for c in cards if c['id'] in filters.group_ids]
        output=io.BytesIO();taken=set();count=0
        with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
            for card in cards:
                data=prepare(db,card['id'],current,filters,room_tag_id,metric,score_step,ranks)
                if not data['students']:continue
                title=' · '.join(v for v in (subjects[card['subject_id']]['name'],(get(db,card.get('grade_id'),'grades') or {}).get('name'),card['name']) if v)
                name=worksheet_name(title,taken)+'.xlsx';archive.writestr(name,xlsx(data,report));count+=1
        if not count:raise HTTPException(409,'当前范围没有可导出的题卡成绩')
        return Response(output.getvalue(),media_type='application/zip',headers={'Content-Disposition':'attachment; filename="project-score-reports.zip"','Cache-Control':'private, no-store'})
