"""Classroom paper discussion using the published paper and its final scoring items."""
from collections import defaultdict
from fastapi import APIRouter, Depends, HTTPException
from .db import connect, find, get, objects
from .dependencies import require, user
from .merged_questions import label
from .result_reports import mean, percent
from .review import card_result_rows, objective_selections, result_class_scope
from .scoring import cents

router=APIRouter(prefix='/api/v1/analysis')


def grade_key(cls):
    return ('id',cls['grade_id']) if cls.get('grade_id') else ('legacy',cls.get('grade') or '')


def review_holds(db,submissions):
    """Only the affected questions are withheld when a finding identifies them."""
    by_id={s['id']:s for s in submissions}
    by_page={pid:s for s in submissions for pid in s.get('pages',[])}
    holds=defaultdict(set)
    labels={}
    for issue in find(db,'exceptions',status='open'):
        if issue.get('kind')=='excellent':continue
        sub=by_id.get(issue.get('submission_id')) or by_page.get(issue.get('page_id'))
        if not sub:continue
        evidence=issue.get('evidence') or {}
        numbers={str(n) for n in evidence.get('question_numbers',[])}
        for run in evidence.get('runs',[]):numbers.update(map(str,run.get('question_numbers',[])))
        task=get(db,issue['task_id'],'tasks') if issue.get('task_id') else {}
        qid=issue.get('question_id') or (task or {}).get('question_id')
        if qid:
            tid=sub['template_id']
            if tid not in labels:labels[tid]={q['id']:label(q) for q in require(db,tid,'templates')['questions']}
            numbers.add(labels[tid].get(qid,qid))
        holds[sub['student_id']].update(numbers or {'*'})
    return holds


def on_hold(q,holds):
    return '*' in holds or q['id'] in holds or label(q) in holds or any(str(p['number']) in holds for p in q.get('parts',[]))


def score_bands(values,points):
    maximum=cents(points)
    target=max(1,(maximum+4)//5)
    unit=10**(len(str(target))-1)
    width=next(step*unit for step in (1,2,3,5,10) if step*unit>=target)
    bounds=(list(range(0,maximum,width)) or [0])+[maximum]
    segments=len(bounds)-1
    bins=[{'lower':lo/100,'upper':hi/100,'inclusive':i==segments-1,'count':0}
          for i,(lo,hi) in enumerate(zip(bounds,bounds[1:]))]
    for value in values:
        score=cents(value)
        for i,upper in enumerate(bounds[1:]):
            if score<upper or i==segments-1:
                bins[i]['count']+=1
                break
    return bins


def grade_comparison(rows,questions,holds,classes):
    scores=defaultdict(lambda:defaultdict(list))
    grade_scores=defaultdict(list)
    for row in rows:
        cls_scores=scores[row['class_id']]
        if row['status'] in ('absent','unscanned'):continue
        blocked=holds.get(row['student_id'],set())
        values={q['id']:row['scores'].get(label(q)) for q in questions if not on_hold(q,blocked)}
        if row['status']=='completed' and not blocked:values['total']=row['total']
        for key,value in values.items():
            if value is not None:
                grade_scores[key].append(value)
                cls_scores[key].append(value)
    # The response contains only means for comparison classes, with no personal or count fields.
    return {'averages':{k:mean(v) for k,v in grade_scores.items()},
            'classes':[{'name':classes[cid]['name'],'averages':{k:mean(v) for k,v in metrics.items()}}
                       for cid,metrics in scores.items()]}


def class_questions(db,questions,rows,submissions,template,holds):
    versions={template['id']:{label(q):q for q in questions}}
    read={}
    for row in rows:
        sub=submissions.get(row['student_id'])
        if not sub or row['status'] in ('absent','unscanned'):continue
        tid=sub['template_id']
        if tid not in versions:
            versions[tid]={label(q):q for q in require(db,tid,'templates')['questions']}
        options=objective_selections(db,sub) if any(q['type']!='subjective' for q in versions[tid].values()) else {}
        read[row['student_id']]=(versions[tid],options)
    output=[]
    for q in questions:
        title=label(q);values=[];correct=0;graded=0;respondents=0
        buckets={c:[] for c in 'ABCDE'[:q.get('options',4)]}
        buckets['blank']=[]
        for row in rows:
            sid=row['student_id']
            if sid not in read:continue
            version,selections=read[sid]
            actual=version.get(title)
            if not actual or actual['type']!=q['type'] or on_hold(actual,holds.get(sid,set())):continue
            score=row['scores'].get(title)
            if score is not None:values.append(score)
            if q['type']=='subjective':continue
            selected=selections.get(actual['id'],set())
            respondents+=1
            for option in sorted(selected) or ['blank']:
                if option in buckets:buckets[option].append(row['name'])
            if actual.get('answer'):
                graded+=1
                correct+=selected==set(actual['answer'])
        item={'id':q['id'],'number':title,'type':q['type'],'points':q['points'],'average':mean(values)}
        if q['type']=='subjective':
            item.update(count=len(values),bands=score_bands(values,q['points']))
        else:
            item.update(answer=q.get('answer',[]),count=respondents,graded=graded,correct=correct,
                        correct_rate=percent(correct,graded),options=buckets)
        output.append(item)
    return output


@router.get('/paper-lesson')
def paper_lesson(group_id:str,class_id:str,current=Depends(user)):
    with connect() as db:
        db.execute('BEGIN')
        group=require(db,group_id,'groups')
        if not group.get('frozen'):raise HTTPException(403,'成绩发布后可讲评试卷')
        allowed=result_class_scope(db,group,current)
        if allowed is not None and class_id not in allowed:raise HTTPException(403,'无权讲评该班本科目')
        classes={c['id']:c for c in objects(db,'classes')}
        if class_id not in classes:raise HTTPException(404,'班级不存在')
        cls=classes[class_id];grade=grade_key(cls)
        subject=require(db,group['subject_id'],'subjects')['name'].strip()
        peers={cid:c for cid,c in classes.items() if grade_key(c)==grade}
        all_classes=allowed is None or bool(grade[1]) and any(
            cid in allowed and subject in c.get('teaching',{}).get(current['id'],{}).get('subjects',[])
            for cid,c in peers.items())
        ids=set(peers) if all_classes else allowed.intersection(peers)
        rows=[r for r in card_result_rows(db,group,convert_scores=False) if r['class_id'] in ids]
        own=[r for r in rows if r['class_id']==class_id]
        if not own:raise HTTPException(404,'该班无此题卡的成绩记录')
        template=require(db,group['template_id'],'templates')
        questions=sorted(template['questions'],key=lambda q:q['number'])
        submissions=find(db,'submissions',group_id=group_id)
        holds=review_holds(db,submissions)
        chart=grade_comparison(rows,questions,holds,classes)
        chart['grade_wide']=all_classes
        return {'group_id':group_id,'class_id':class_id,'full_score':sum(q['points'] for q in questions),
                'questions':class_questions(db,questions,own,{s['student_id']:s for s in submissions},template,holds),
                'comparison':chart}
