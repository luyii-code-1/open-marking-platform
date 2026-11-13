"""Shared draft/print/publish checks for answer-sheet definitions."""
from decimal import InvalidOperation
import math
from . import paper
from .scoring import cents


def issues(template,complete=False):
    errors=[]
    if template.get('paper') not in ('A3','A4'):errors.append('纸型应为A3或A4')
    if type(template.get('sides')) is not int or template['sides'] not in (1,2):errors.append('请选择单面或双面')
    if not isinstance(template.get('name'),str) or not template['name'].strip():errors.append('请填写题卡标题')
    if template.get('notice_template','none') not in ('none','standard-v1'):errors.append('内置须知模板无效')
    questions=template.get('questions',[])
    if not isinstance(questions,list) or any(not isinstance(q,dict) for q in questions):return errors+['题目应为对象列表']
    if complete and not questions:errors.append('至少创建一道题')
    numbers=set()
    for index,q in enumerate(questions,1):
        label=f"第{q.get('number',index)}题："
        number=q.get('number')
        if type(number) is not int or number<1:errors.append(label+'题号应为正整数')
        elif number in numbers:errors.append(label+'题号重复')
        else:numbers.add(number)
        if q.get('type') not in ('single','multiple','subjective'):errors.append(label+'题型无效')
        regions=q.get('regions',[])
        if not isinstance(regions,list) or any(not isinstance(r,dict) for r in regions):errors.append(label+'答题区应为区域列表')
        elif complete and not regions:errors.append(label+'请设置答题区域')
        try:
            points=cents(q.get('points',0))
            if points<0 or (complete and points==0):raise ValueError()
        except (ValueError,TypeError,InvalidOperation,OverflowError):errors.append(label+'分值应为有限正数');points=None
        if q.get('type')=='subjective':
            if q.get('review_mode','single') not in ('single','double'):errors.append(label+'评阅方式无效')
            if q.get('review_mode')=='double':
                try:
                    threshold=cents(q.get('threshold',0))
                    if threshold<0 or (points is not None and threshold>points):raise ValueError()
                except (ValueError,TypeError,InvalidOperation,OverflowError):errors.append(label+'允许差值应在0至满分之间')
            if q.get('style','line') not in ('line','grid','rich','none'):errors.append(label+'答题区样式无效')
            if q.get('style','line')=='line' and 'lines' in q and (type(q['lines']) is not int or not 1<=q['lines']<=100):errors.append(label+'横线行数应为1至100')
            if q.get('style')=='grid':
                cell=q.get('cell_size',8)
                if type(cell) not in (int,float) or not math.isfinite(cell) or not 4<=cell<=20:errors.append(label+'作文格大小应为4至20毫米')
            if 'step' in q:
                try:
                    if cents(q['step'])<=0:raise ValueError()
                except (ValueError,TypeError,InvalidOperation,OverflowError):errors.append(label+'评分步长应为有限正数')
        if 'content_html' in q and not isinstance(q['content_html'],str):errors.append(label+'富文本内容应为文字')
        if q.get('image_asset_id'):
            value=q.get('image_height',25)
            if type(value) not in (int,float) or not math.isfinite(value) or value<=0:errors.append(label+'插图高度应为有限正数')
        if q.get('type')!='subjective':
            answers=q.get('answer',[]);count=q.get('options',4)
            if type(count) is not int or count not in (3,4,5):errors.append(label+'选项数量应为3、4或5')
            elif not isinstance(answers,list) or any(not isinstance(a,str) or a not in 'ABCDE'[:count] or len(a)!=1 for a in answers):errors.append(label+'标准答案含无效选项')
            elif len(set(answers))!=len(answers) or (q.get('type')=='single' and len(answers)>1):errors.append(label+'标准答案重复或单选题设置了多个答案')
            elif complete and not answers:errors.append(label+'请设置标准答案')
            rule=q.get('rule') if q.get('rule') is not None else {'mode':'exact'}
            if not isinstance(rule,dict) or rule.get('mode','exact') not in ('exact','partial','per_option'):errors.append(label+'给分规则无效')
            else:
                if rule.get('wrong_action','deduct') not in ('deduct','zero'):errors.append(label+'错选处理应为扣分或整题归零')
                allowed={'mode','partial_points','correct_points','wrong_penalty','wrong_action'}
                if set(rule)-allowed:errors.append(label+'含不支持的规则字段')
                for key in {'partial':('partial_points',),'per_option':('correct_points','wrong_penalty')}.get(rule.get('mode'),()):
                    try:
                        value=cents(rule.get(key,0 if key=='partial_points' else 1))
                        if value<0 or (key=='correct_points' and value==0):raise ValueError()
                    except (ValueError,TypeError,InvalidOperation,OverflowError):errors.append(label+key+'应为有效的非负分值')
    if not errors:
        try:paper.validate(template)
        except (ValueError,TypeError,KeyError,OverflowError) as error:errors.append(str(error))
    return errors


def asset_ids(template):
    backgrounds=template.get('background_assets',{})
    if not isinstance(backgrounds,dict):raise ValueError('题卡底图配置无效')
    if any(key not in [str(p) for p in range(1,template['sides']+1)] for key in backgrounds):raise ValueError('底图页码超出题卡范围')
    values=list(backgrounds.values())
    if template.get('background_asset_id'):values.append(template['background_asset_id'])
    values.extend(q['image_asset_id'] for q in template.get('questions',[]) if q.get('image_asset_id'))
    if any(not isinstance(v,str) for v in values):raise ValueError('图片编号无效')
    return values
