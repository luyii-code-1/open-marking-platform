"""Shared result filters, applied only after the caller resolves visibility."""
from dataclasses import dataclass
from fastapi import HTTPException

STATUS_NAMES={'completed':'已完成','pending':'待结分','absent':'缺考','unscanned':'未扫描','duplicate_subject':'同科答卷重复'}


def selected(value):
    return frozenset(item.strip() for item in value.split(',') if item.strip())


@dataclass(frozen=True)
class ResultFilters:
    class_ids:frozenset[str]=frozenset()
    student_ids:frozenset[str]=frozenset()
    statuses:frozenset[str]=frozenset()
    q:str=''
    group_ids:frozenset[str]=frozenset()

    def matches(self,row):
        return (not self.class_ids or row.get('class_id') in self.class_ids) and (not self.student_ids or row.get('student_id') in self.student_ids) and (not self.statuses or row.get('status') in self.statuses) and (not self.q or self.q in str(row.get('name','')).casefold() or self.q in str(row.get('candidate_number','')).casefold())


def result_filter_query(class_ids:str='',student_ids:str='',statuses:str='',q:str='',group_ids:str=''):
    states=selected(statuses)
    if states-set(STATUS_NAMES):raise HTTPException(422,'成绩状态筛选无效')
    return ResultFilters(selected(class_ids),selected(student_ids),states,q.strip().casefold(),selected(group_ids))


def filter_rows(rows,filters=None,room_tag_id=None):
    from .room_tags import includes
    filters=filters or ResultFilters()
    return [row for row in rows if filters.matches(row) and includes(row,room_tag_id)]


def filter_options(rows):
    classes={};students={};states=set()
    for row in rows:
        cid=row.get('class_id')
        if cid:classes[cid]={'id':cid,'name':row.get('class_name',cid),'class_name':row.get('class_name',cid),'grade':row.get('grade'),'grade_name':row.get('grade'),'grade_id':row.get('grade_id'),'tags':row.get('class_tags',[])}
        sid=row.get('student_id')
        if sid:students[sid]={'id':sid,'name':row.get('name',sid),'class_id':cid,'candidate_number':row.get('candidate_number','')}
        if row.get('status') in STATUS_NAMES:states.add(row['status'])
    return {'classes':sorted(classes.values(),key=lambda row:(str(row.get('grade') or ''),row['name'])),
            'students':sorted(students.values(),key=lambda row:(classes.get(row['class_id'],{}).get('name',''),row['candidate_number'])),
            'statuses':[{'id':status,'name':name} for status,name in STATUS_NAMES.items() if status in states]}
