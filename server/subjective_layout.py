"""Measure and place whole subjective prompts in printable millimetres."""
from copy import deepcopy
import math
from reportlab.lib.units import mm
from .omr import dimensions,panels,manual_binding
from .richtext import layout


def required_height(question,width,template):
    from .paper import text_layout_options
    if width<=6:raise ValueError('主观题区域过窄')
    text=layout(question.get('content_html',''),(width-6)*mm,10000*mm,**text_layout_options(template))/mm
    image=question.get('image_height',25) if question.get('image_asset_id') else 0
    if not isinstance(image,(int,float)) or not math.isfinite(image) or image<0:raise ValueError('插图高度无效')
    style=question.get('style','line')
    answer=0
    if style=='line':
        lines=question.get('lines',5)
        if type(lines) is not int or not 1<=lines<=100:raise ValueError('横线行数应为1至100')
        answer=(lines-1)*8
    elif style=='grid':answer=question.get('cell_size',8)
    return math.ceil((15+text+image+answer)*1000)/1000


def reflow(template):
    value=deepcopy(template)
    if value.get('status') in ('published','superseded'):raise ValueError('请先将已发布版式复制为草稿再调整题区')
    if value.get('paper') not in ('A3','A4') or value.get('sides') not in (1,2):raise ValueError('纸型或面数无效')
    width,_=dimensions(value);count=panels(value)
    if type(count) is not int or count not in ((2,3) if value['paper']=='A3' else (1,)):raise ValueError('分栏数量无效')
    panel_width=(width-24-(count-1)*8)/count
    slots=[{'page':page,'x':math.ceil((12+column*(panel_width+8)-1e-8)*1000)/1000,
            'top':100 if not manual_binding(value) or page==1 and column==0 else 35,
            'width':math.floor((panel_width+1e-8)*10)/10,'bottom':270}
           for page in range(1,value['sides']+1) for column in range(count)]
    def slot_for(region):
        column=max(0,min(count-1,int((region.get('anchor_x',region.get('x',12))-12+.01)/(panel_width+8))))
        return (int(region.get('anchor_page',region.get('page',1)))-1)*count+column
    obstacles=[r for q in value.get('questions',[]) if q['type']!='subjective' for r in q.get('regions',[])]+value.get('print_notes',[])+value.get('forbidden_regions',[])
    blocks=[]
    for question in value.get('questions',[]):
        if question.get('type')!='subjective':continue
        parts=question.get('parts') or [question]
        for part in parts:
            regions=[r for r in question.get('regions',[]) if not question.get('parts') or r.get('part_number')==part['number']]
            # Existing hand-drawn continuations retain their boundaries and stitch order.
            for region_index,first in enumerate(regions or [None]):
                minimum=first.get('min_height',first['height']) if first else 35
                if not isinstance(minimum,(int,float)) or not math.isfinite(minimum) or minimum<=0:raise ValueError('题区手动高度无效')
                blocks.append({'owner':question,'prompt':part,'first':first,'minimum':minimum,'source_order':(part['number'],region_index),
                               'slot':slot_for(first) if first else len(slots),'y':first.get('anchor_y',first['y']) if first else 0})
    blocks.sort(key=lambda block:(block['slot'],block['y'],block['prompt']['number']))
    for question in value.get('questions',[]):
        if question.get('type')=='subjective':question['regions']=[]
    cursor_slot=0;cursor_y=slots[0]['top'];placed=[];by_question={id(q):[] for q in value.get('questions',[]) if q.get('type')=='subjective'}
    for block in blocks:
        preferred=min(block['slot'],len(slots)-1) if block['first'] else cursor_slot
        start=max(cursor_slot,preferred)
        height=required_height(block['prompt'],slots[0]['width'],value)
        height=max(height,block['minimum'])
        found=None
        for index in range(start,len(slots)):
            slot=slots[index]
            y=max(slot['top'],cursor_y if index==cursor_slot else slot['top'],block['y'] if index==preferred and block['first'] else slot['top'])
            for obstacle in sorted([r for r in obstacles if r['page']==slot['page'] and r['x']<slot['x']+slot['width'] and r['x']+r['width']>slot['x']],key=lambda r:r['y']):
                if obstacle['y']<y+height and obstacle['y']+obstacle['height']>y:y=obstacle['y']+obstacle['height']+2
            if y+height<=slot['bottom']+.0001:
                found=(index,slot,y);break
        if found is None:raise ValueError(f"第{block['prompt']['number']}题没有足够的完整栏空间，请减少内容或行数、缩小手动高度，或增加面数/分栏")
        index,slot,y=found;first=block['first'] or {}
        region={'page':slot['page'],'x':slot['x'],'y':round(y,3),'width':slot['width'],'height':round(height,3),'min_height':block['minimum'],
                'anchor_page':first.get('anchor_page',first.get('page',slot['page'])),
                'anchor_x':first.get('anchor_x',first.get('x',slot['x'])),'anchor_y':first.get('anchor_y',first.get('y',y))}
        if block['owner'].get('parts'):region['part_number']=block['prompt']['number']
        by_question[id(block['owner'])].append((block['source_order'],region));placed.append({'number':block['prompt']['number'],**region})
        cursor_slot=index;cursor_y=y+height+2
    for question in value.get('questions',[]):
        if question.get('type')=='subjective':question['regions']=[area for _,area in sorted(by_question[id(question)],key=lambda item:item[0])]
    from .template_checks import issues
    errors=issues(value,require_answers=False)
    if errors:raise ValueError('；'.join(errors))
    return value,placed
