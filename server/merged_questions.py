"""A single scoring item may print several individually numbered prompts."""
from .scoring import cents

PRINT_FIELDS=('number','points','style','lines','cell_size','content_html','image_asset_id','image_height')


def label(question):
    parts=question.get('parts')
    if not parts:return str(question['number'])
    numbers=[p['number'] for p in parts]
    if numbers==list(range(numbers[0],numbers[0]+len(numbers))):return f'{numbers[0]}～{numbers[-1]}'
    return '、'.join(map(str,numbers))


def print_questions(template):
    for q in template.get('questions',[]):
        if 'parts' not in q:
            yield q
            continue
        parts=q['parts']
        if q.get('type')!='subjective' or not isinstance(parts,list) or len(parts)<2:
            raise ValueError('合并题目至少包含两道主观题')
        if any(not isinstance(p,dict) or type(p.get('number')) is not int or p['number']<1 for p in parts):
            raise ValueError('合并题目的子题号无效')
        numbers=[p['number'] for p in parts]
        if numbers!=sorted(set(numbers)) or numbers[0]!=q.get('number'):
            raise ValueError('合并题目的题号应唯一并按顺序排列')
        regions=q.get('regions',[])
        if any(not isinstance(r,dict) or r.get('part_number') not in numbers for r in regions):
            raise ValueError('答题区缺少所属子题号')
        if any(cents(p.get('points',0))<=0 for p in parts):
            raise ValueError('合并题目的各子题分值应为正数')
        if sum(cents(p['points']) for p in parts)!=cents(q.get('points',0)):
            raise ValueError('合并题目的满分应等于各题满分之和')
        for p in parts:
            item={k:v for k,v in q.items() if k not in PRINT_FIELDS and k!='parts'}
            item.update({k:p[k] for k in PRINT_FIELDS if k in p})
            item['regions']=[r for r in regions if r['part_number']==p['number']]
            yield item
