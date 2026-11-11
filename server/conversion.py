import csv
import io
import math
from collections import Counter
from decimal import Decimal,DecimalException,ROUND_HALF_UP


def number(value):
    try:
        if isinstance(value,bool):raise ValueError()
        result=Decimal(str(value))
        if not result.is_finite() or not math.isfinite(float(result)):raise ValueError()
        return result
    except (DecimalException,ValueError,TypeError,OverflowError):raise ValueError('赋分配置必须为有限数字')


def key(value):return format(value.normalize(),'f') if value else '0'


def validate_conversion(config):
    mode=config.get('mode','segments')
    if type(config.get('precision',2)) is not int or not 0<=config.get('precision',2)<=2:raise ValueError('赋分保留位数应为0、1或2')
    if config.get('boundary','lower') not in ('lower','upper'):raise ValueError('分段边界归属无效')
    if mode=='table':
        table=config.get('table',{})
        if not isinstance(table,dict) or not table:raise ValueError('请填写赋分对照表')
        rows=sorted((number(raw),number(target)) for raw,target in table.items())
        seen=set();previous=None
        for raw,target in rows:
            if raw in seen:raise ValueError('赋分表原始分数重复：'+str(raw))
            if raw<0 or target<40:raise ValueError('原始分数应非负，赋分从40分起')
            if previous is not None and target<previous:raise ValueError('赋分表出现高原始分对应更低赋分：'+str(raw))
            seen.add(raw);previous=target
    elif mode in ('segments','percentile'):
        segments=config.get('segments',[])
        if not isinstance(segments,list) or not segments or any(not isinstance(s,dict) for s in segments):raise ValueError('请填写赋分分段')
        try:rows=sorted(tuple(number(s[k]) for k in ('min','max','target_min','target_max')) for s in segments)
        except KeyError:raise ValueError('分段应包含上下界及对应赋分')
        previous=None;previous_target=None
        for low,high,start,end in rows:
            if low<0 or high<=low or end<start or start<40:raise ValueError('赋分区间应递增，且赋分从40分起')
            if previous is not None and low<previous:raise ValueError('赋分区间重叠')
            if previous_target is not None and start<previous_target:raise ValueError('分段赋分出现倒挂')
            if mode=='percentile' and not 0<=low<high<=100:raise ValueError('百分位需在0至100之间')
            previous=high;previous_target=end
    else:raise ValueError('赋分方式无效')
    return config


def calculator(config):
    validate_conversion(config)
    table={number(k):number(v) for k,v in config['table'].items()} if config.get('mode')=='table' else None
    ordered=[] if table is not None else sorted((tuple(number(s[k]) for k in ('min','max','target_min','target_max')) for s in config.get('segments',[])),reverse=config.get('boundary')=='upper')
    def calculate(raw,percentile=None):
      try:
        if config.get('mode')=='table':
            result=table.get(number(raw))
            if result is None:raise ValueError('对照表未包含原始分数：'+str(raw))
        else:
            if config.get('mode')=='percentile' and percentile is None:raise ValueError('百分位赋分需要统计范围')
            value=number(percentile if config.get('mode')=='percentile' else raw);result=None
            for low,high,start,end in ordered:
                if low<=value<=high:result=start+(value-low)/(high-low)*(end-start);break
            if result is None:raise ValueError('分数不在赋分区间内：'+str(value))
        result=float(result.quantize(Decimal(1).scaleb(-config.get('precision',2)),rounding=ROUND_HALF_UP))
        if not math.isfinite(result):raise ValueError('赋分结果超出数值范围')
        return result
      except DecimalException:raise ValueError('赋分计算超出精度范围')
    return calculate


def convert(raw,config,percentile=None):return calculator(config)(raw,percentile)


def apply(rows,config):
    calculate=calculator(config)
    counts=Counter(number(r['total']) for r in rows if r['total'] is not None and r['status']!='absent')
    total=sum(counts.values());percentiles={};less=0
    for raw,count in sorted(counts.items()):percentiles[raw]=100*(Decimal(less)+Decimal(count)/2)/total;less+=count
    for row in rows:
        if row['total'] is None:continue
        row['converted_score']=0 if row['status']=='absent' else calculate(row['total'],percentiles[number(row['total'])])
    return rows


def active_config(group,config):
    snapshot=group.get('conversion_snapshot')
    return snapshot if group.get('frozen') and snapshot and snapshot.get('id')==group.get('conversion_id') else config


def import_table(data,name,precision=2):
    if len(data)>2*1024*1024:raise ValueError('对照表超过2MB')
    if data.startswith(b'PK'):raise ValueError('请将Excel表格另存为CSV，或粘贴两列文本')
    try:text=data.decode('utf-8-sig')
    except UnicodeDecodeError:
        try:text=data.decode('gb18030')
        except UnicodeDecodeError:raise ValueError('请使用UTF-8或GB18030编码的CSV')
    reader=csv.reader(io.StringIO(text),delimiter='\t' if '\t' in text.split('\n',1)[0] else ',',strict=True)
    try:
        headers=[h.strip().lower() for h in next(reader)]
        raw=[i for i,h in enumerate(headers) if h in ('raw','raw_score','原始分','裸分')]
        converted=[i for i,h in enumerate(headers) if h in ('converted','converted_score','赋分','转换分')]
        if len(raw)!=1 or len(converted)!=1:raise ValueError('表头应包含唯一的“原始分”和“赋分”两列')
        table={}
        for row in reader:
            if not any(cell.strip() for cell in row):continue
            if len(row)!=len(headers):raise ValueError(f'第{reader.line_num}行列数不一致')
            try:a,b=number(row[raw[0]].strip()),number(row[converted[0]].strip())
            except ValueError:raise ValueError(f'第{reader.line_num}行不是有效数字')
            try:
                if a!=a.quantize(Decimal('.01')) or a<0 or b<40:raise ValueError()
            except (DecimalException,ValueError):raise ValueError(f'第{reader.line_num}行：原始分应非负且最多两位小数，赋分从40分起')
            canonical=key(a)
            if canonical in table:raise ValueError(f'第{reader.line_num}行原始分重复：{canonical}')
            table[canonical]=key(b)
    except StopIteration:raise ValueError('对照表为空')
    except csv.Error:raise ValueError('CSV引号或分隔格式无效')
    config={'name':name,'mode':'table','table':table,'precision':precision,'boundary':'lower'}
    validate_conversion(config)
    return config
