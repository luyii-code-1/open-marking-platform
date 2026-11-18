"""Match candidate numbers to one student while preserving explicit leading zeros."""
import json
from fastapi import HTTPException


def validate(db, number, student_id=None):
    if not isinstance(number,str) or not number.isascii() or not number.isdigit():
        raise HTTPException(422,'准考证号应为数字字符串')
    duplicate=db.execute("""SELECT 1 FROM objects WHERE kind='students' AND deleted=0
        AND CAST(json_extract(body,'$.candidate_number') AS TEXT)=? AND id IS NOT ? LIMIT 1""",(number,student_id)).fetchone()
    if duplicate:
        raise HTTPException(409,'准考证号已存在')


def by_number(students):
    """None denotes a number shared by different identities in a legacy dataset."""
    result={}
    for student in students:
        number=str(student['candidate_number'])
        if number in result and (result[number] is None or result[number]['id']!=student['id']):
            result[number]=None
        else:
            result[number]=student
    return result


def check_scanned_numbers(db,numbers):
    duplicate=db.execute("""SELECT 1 FROM objects WHERE kind='students' AND deleted=0
        AND CAST(json_extract(body,'$.candidate_number') AS TEXT) IN (SELECT value FROM json_each(?))
        GROUP BY CAST(json_extract(body,'$.candidate_number') AS TEXT) HAVING count(*)>1 LIMIT 1""",
        (json.dumps(numbers),)).fetchone()
    if duplicate:
        raise HTTPException(409,'准考证号对应多个学生，请先核对学生资料')
