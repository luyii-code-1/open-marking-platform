import io
import math
import numpy as np
from reportlab.lib.units import mm
from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF
from reportlab.pdfbase import pdfmetrics
from .paper_fonts import FONT
from reportlab.lib.utils import ImageReader
from . import db as database
from .richtext import PaperCanvas,layout as rich_layout
from . import sheet_notices, sheet_style

from .omr import ABSENT_X, ABSENT_Y, dimensions, code, bubbles, decode, align, manual_align, absent_mark, recognize, manual_binding, panels, absent_position






def text_layout_options(template):
    size = template.get('font_size', 9)
    leading = template.get('leading', 13)
    if not all(type(v) in (int, float) for v in (size, leading)) or not (6 <= size <= 36 and size <= leading <= 72):
        raise ValueError('字号须为 6 至 36 磅，行距须介于字号与 72 磅之间')
    return dict(font_size=size, leading=leading)


def validate(template):
    text_options = text_layout_options(template)
    w,h=dimensions(template)
    compact=any(q.get('choice_style') in ('bracket','compact') for q in template.get('questions',[]))
    columns=panels(template)
    if type(columns) is not int or columns not in ((2,3) if template['paper']=='A3' and manual_binding(template) else (1,)):raise ValueError('A3请选择每面2栏或3栏，A4使用单栏模板')
    panel_width=(w-24-(columns-1)*8)/columns
    if manual_binding(template) and 18+(template.get('candidate_length',8)-1)*6+2>12+panel_width:raise ValueError('准考证号超出首栏，请减少位数或选择较宽的模板')
    maximum=11 if sheet_style.enabled(template) else 20
    if type(template.get('candidate_length',8)) is not int or not 1<=template.get('candidate_length',8)<=maximum: raise ValueError(f'准考证号长度应为1至{maximum}位')
    if sheet_notices.enabled(template):
        _,notice_width=sheet_notices.geometry(template)
        if notice_width<54:raise ValueError('当前考号位数与须知区域冲突，请选择较宽的分栏、减少考号位数或关闭内置须知')
        sheet_notices.fitted_notices(notice_width)
    occupied=[]
    for question in template.get('questions',[]):
        for region in question.get('regions',[]):
            if not all(isinstance(region[k],(int,float)) and math.isfinite(region[k]) for k in ('x','y','width','height')): raise ValueError('答题区坐标无效')
            if not 1<=int(region['page'])<=template['sides']:
                raise ValueError('答题区页码超出题卡范围')
            if min(region['x'],region['y'])<0 or min(region['width'],region['height'])<=0 or region['x']+region['width']>w-8 or region['y']+region['height']>(270 if sheet_style.enabled(template) else h-8):
                raise ValueError('答题区超出纸张有效范围')
            reserved=100 if not manual_binding(template) or (region['page']==1 and region['x']<12+panel_width) else 35
            if region['y']<reserved:raise ValueError(f'本栏答题区需从{reserved}毫米开始，保留标题及考号区域')
            if manual_binding(template):
                panel=min(columns-1,max(0,int((region['x']-12+.01)/(panel_width+8))))
                left=12+panel*(panel_width+8)
                if region['x']<left-.01 or region['x']+region['width']>left+panel_width+.01:raise ValueError('答题区域不能跨越题卡分栏')
                if template.get('uniform_subjective') and question['type']=='subjective':
                    expected=math.floor((panel_width+1e-8)*10)/10
                    if abs(region['x']-left)>.011 or abs(region['width']-expected)>.011:
                        raise ValueError('主观题作答区应与本栏等宽，请重新载入草稿并保存')
            bracket=question.get('choice_style')=='bracket'
            tight=question.get('choice_style')=='compact'
            if question.get('choice_style') not in (None,'bracket','compact'):raise ValueError('选择题填涂样式无效')
            minimum_width=12+(question.get('options',4)-1)*5 if tight else 20+(question.get('options',4)-1)*9.5 if bracket else 12+question.get('options',4)*6
            if question['type']!='subjective' and (region['width']<minimum_width or region['height']<(4.6 if tight else 6 if bracket else 14)): raise ValueError('客观题区域不足以容纳选项')
            if compact and not manual_binding(template) and region['x']<110 and region['x']+region['width']>12 and region['y']<h-26 and region['y']+region['height']>h-38:raise ValueError('答题区与页脚灰度校准区域重叠')
            for previous in occupied:
                if previous['page']==region['page'] and region['x']<previous['x']+previous['width'] and previous['x']<region['x']+region['width'] and region['y']<previous['y']+previous['height'] and previous['y']<region['y']+region['height']: raise ValueError('答题区域重叠')
            occupied.append(region)
            if question.get('content_html') and not question.get('parts'):
                image_height=min(region['height']-12,question.get('image_height',25)) if question.get('image_asset_id') else 0
                rich_layout(question['content_html'],(region['width']-6)*mm,(region['height']-12-image_height)*mm,**text_options)
        if question['type']!='subjective':
            count=int(question.get('options',4))
            if count not in (3,4,5) or not set(question.get('answer',[]))<=set('ABCDE'[:count]):
                raise ValueError('选项或标准答案无效')
    areas=template.get('forbidden_regions',[])
    if not isinstance(areas,list) or len(areas)>100:raise ValueError('禁答区应为不超过100项的区域列表')
    for area in areas:
        if not isinstance(area,dict) or not all(type(area.get(k)) in (int,float) and math.isfinite(area[k]) for k in ('x','y','width','height')):raise ValueError('禁答区坐标无效')
        if type(area.get('page')) is not int or not 1<=area['page']<=template['sides']:raise ValueError('禁答区页码超出题卡范围')
        if area['width']<10 or area['height']<8 or area['x']<12 or area['x']+area['width']>w-12 or area['y']+area['height']>270:raise ValueError('禁答区超出有效范围或尺寸过小')
        panel=max(0,min(columns-1,int((area['x']-12+.01)/(panel_width+8))))
        left=12+panel*(panel_width+8);top=100 if area['page']==1 and panel==0 else 35
        if area['y']<top or area['x']<left-.01 or area['x']+area['width']>left+panel_width+.01:raise ValueError('禁答区不能覆盖页首或跨越题卡分栏')
        for other in occupied:
            if other['page']==area['page'] and area['x']<other['x']+other['width'] and other['x']<area['x']+area['width'] and area['y']<other['y']+other['height'] and other['y']<area['y']+area['height']:raise ValueError('禁答区与已有区域重叠')
        occupied.append(area)
    notes=template.get('print_notes',[])
    if not isinstance(notes,list) or len(notes)>500:
        raise ValueError('版面文字最多可添加500项')
    protected=[r for q in template.get('questions',[]) if q['type']!='subjective' for r in q.get('regions',[])]+areas
    ids=set()
    for note in notes:
        if not isinstance(note,dict) or not isinstance(note.get('id'),str) or not note['id'] or note['id'] in ids:
            raise ValueError('版面文字编号无效')
        ids.add(note['id'])
        if not isinstance(note.get('html'),str) or type(note.get('page')) is not int or not 1<=note['page']<=template['sides']:
            raise ValueError('版面文字或页码无效')
        if not all(type(note.get(k)) in (int,float) and math.isfinite(note[k]) for k in ('x','y','width','height')):
            raise ValueError('版面文字坐标无效')
        x,y,width,height=(note[k] for k in ('x','y','width','height'))
        panel=max(0,min(columns-1,int((x-12+.01)/(panel_width+8))))
        left=12+panel*(panel_width+8)
        top=100 if not manual_binding(template) or (note['page']==1 and panel==0) else 35
        if x<left-.01 or x+width>left+panel_width+.01 or y<top or y+height>270 or min(width,height)<=0:
            raise ValueError('版面文字超出本栏可用范围')
        if any(r['page']==note['page'] and x<r['x']+r['width'] and r['x']<x+width and y<r['y']+r['height'] and r['y']<y+height for r in protected):
            raise ValueError('版面文字与选择题或禁答区重叠')
        rich_layout(note['html'],width*mm,height*mm,**text_options)



def forbidden_regions(template,page):
    if sheet_style.enabled(template):return [r for r in template.get('forbidden_regions',[]) if r['page']==page]
    if not manual_binding(template):return []
    width,_=dimensions(template);count=panels(template);pw=(width-24-(count-1)*8)/count
    occupied=[r for q in template.get('questions',[]) for r in q.get('regions',[]) if r['page']==page]
    result=[]
    for panel in range(count):
        left=12+panel*(pw+8);right=left+pw;top=100 if page==1 and panel==0 else 35;bottom=255
        obstacles=[(max(left,r['x']-2),max(top,r['y']-5),min(right,r['x']+r['width']+2),min(bottom,r['y']+r['height']+2)) for r in occupied if r['x']<right and r['x']+r['width']>left]
        edges=sorted({top,bottom}|{v for x,y,ex,ey in obstacles for v in (y,ey) if top<=v<=bottom})
        active={}
        for y,ey in zip(edges,edges[1:]):
            spans=[(left,right)]
            for x,oy,ex,oey in obstacles:
                if oy>=ey or oey<=y:continue
                spans=[part for a,b in spans for part in ((a,min(b,x)),(max(a,ex),b)) if part[1]>part[0]]
            current={}
            for a,b in spans:
                key=(round(a,3),round(b,3))
                if key in active:
                    rect=active.pop(key);rect['height']=ey-rect['y']
                else:rect={'page':page,'x':a,'y':y,'width':b-a,'height':ey-y}
                current[key]=rect
            result.extend(active.values());active=current
        result.extend(active.values())
    return [r for r in result if r['width']>=30 and r['height']>=12]


def pdf(template):
    from .merged_questions import print_questions
    template={**template,'questions':list(print_questions(template))}
    validate(template)
    text_options = text_layout_options(template)
    output=io.BytesIO()
    w,h=dimensions(template)
    c=PaperCanvas(output,pagesize=(w*mm,h*mm))
    for page in range(1,template['sides']+1):
        side='front' if page==1 else 'back'
        background_id=template.get('background_assets',{}).get(str(page)) or (template.get('background_asset_id') if page==1 else None)
        if background_id:
            from .storage import materialize
            try:background=materialize('assets/'+background_id+'.png')
            except FileNotFoundError:raise ValueError('题卡底图不存在')
            if not background.exists():raise ValueError('题卡底图不存在')
            c.drawImage(str(background),0,0,width=w*mm,height=h*mm)
            c.setFillColorRGB(1,1,1);c.rect(0,(h-100)*mm,w*mm,100*mm,fill=1,stroke=0);c.setFillColorRGB(0,0,0)
        title_width=(w-24-(panels(template)-1)*8)/panels(template) if manual_binding(template) else w-65
        title_size=min(16,16*(title_width-6)/max(1,pdfmetrics.stringWidth(template['name'],FONT,16)/mm))
        if page==1 or not manual_binding(template):
            c.setFont(FONT,title_size)
            if manual_binding(template):c.drawCentredString((12+title_width/2)*mm,(h-20)*mm,template['name'])
            else:c.drawString(15*mm,(h-20)*mm,template['name'])
            if template.get('subtitle'):
                c.setFont(FONT,10)
                if manual_binding(template):c.drawCentredString((12+title_width/2)*mm,(h-25)*mm,template['subtitle'])
                else:c.drawString(15*mm,(h-25)*mm,template['subtitle'])
        c.setFont(FONT,9)
        if not manual_binding(template):c.drawString(15*mm,(h-29)*mm,f"第{page}面 · 按实际大小打印，保留定位标记")
        if not manual_binding(template):
            widget=qr.QrCodeWidget(code(template,side)); x0,y0,x1,y1=widget.getBounds()
            drawing=Drawing(26*mm,26*mm,transform=[26*mm/(x1-x0),0,0,26*mm/(y1-y0),0,0]); drawing.add(widget)
            renderPDF.draw(drawing,c,(w-42)*mm,(h-36)*mm)
        if manual_binding(template):
            count=panels(template);pw=(w-24-(count-1)*8)/count
            for panel in range(count):
                left=12+panel*(pw+8)
                if panel and not template.get('column_frame'):
                    c.setDash(1,3);c.setStrokeGray(.65);c.line((left-4)*mm,15*mm,(left-4)*mm,(h-15)*mm);c.setDash();c.setStrokeGray(0)
        for x,y in ((7,7),(w-7,7),(7,h-7),(w-7,h-7)):
            c.rect((x-2)*mm,(h-y-2)*mm,4*mm,4*mm,fill=1,stroke=0)
        if page==1:
            standard_notices=sheet_notices.enabled(template)
            c.setFont(FONT,8 if standard_notices else 9)
            baseline=(h-(33 if standard_notices else 39))*mm
            if template.get('column_frame'):
                field_width=min(40,(title_width-6)/3)*mm
                for index,label in enumerate(('姓名','班级','考场')):
                    x=15*mm+index*field_width
                    c.drawString(x,baseline,label)
                    c.line(x+7*mm,baseline-1,x+field_width-2*mm,baseline-1)
            else:c.drawString(15*mm,baseline,'姓名：____________  班级：____________  考场：____________')
            if template.get('layout_version',1)>=2:
                if sheet_style.enabled(template):
                    header=sheet_style.header_geometry(template)
                    c.saveState();c.setLineWidth(.18*mm)
                    c.rect(header['left']*mm,(h-header['bottom'])*mm,(header['right']-header['left'])*mm,(header['bottom']-header['top'])*mm)
                    c.setFont(FONT,8);c.drawCentredString((header['left']+header['right'])*mm/2,(h-41)*mm,'准考证号')
                    c.restoreState()
                else:c.drawString(15*mm,(h-46)*mm,'准考证号：')
                ax,ay=absent_position(template)
                if not standard_notices:
                    c.drawString((ax-23)*mm,(h-46)*mm,'缺考标记：')
                    c.rect((ax-2)*mm,(h-ay-1.5)*mm,4*mm,3*mm)
                    c.setFont(FONT,7);c.drawString((ax-24)*mm,(h-51)*mm,'由监考教师填涂')
            else:c.drawString(15*mm,(h-46)*mm,'准考证号：                       缺考标记：□（由监考教师填写）')
            for column in range(int(template.get('candidate_length',8))):
                x=18+column*6
                c.rect((x-2)*mm,(h-54)*mm,4*mm,(4 if sheet_style.enabled(template) else 5)*mm)
                for digit in range(10):
                    y=57+digit*3.5
                    c.rect((x-1.6)*mm,(h-y-1.2)*mm,3.2*mm,2.4*mm)
                    c.setFont('Helvetica',5); c.drawCentredString(x*mm,(h-y-.6)*mm,str(digit))
            if standard_notices:sheet_notices.draw(c,template)
        for question in template.get('questions',[]):
            for region in question['regions']:
                if int(region['page'])!=page: continue
                x,y,rw,rh=(region[k] for k in ('x','y','width','height'))
                c.setFont(FONT,9)
                if question['type']!='subjective':
                    c.setFillColorRGB(1,1,1);c.rect(x*mm,(h-y-rh)*mm,rw*mm,rh*mm,fill=1,stroke=0);c.setFillColorRGB(0,0,0)
                tight=question.get('choice_style')=='compact'
                bracket=question['type']!='subjective' and question.get('choice_style') in ('bracket','compact')
                if not bracket:c.rect(x*mm,(h-y-rh)*mm,rw*mm,rh*mm)
                if bracket:c.setFont('Helvetica',2.8*mm)
                c.drawString((x+1)*mm,(h-y-(3.2 if tight else 3.8 if bracket else 5))*mm,str(question['number']))
                if question['type']!='subjective':
                    for label,bx,by in bubbles(question,region):
                        if bracket:
                            c.setLineWidth(.17*mm)
                            for direction in (-1,1):
                                edge=bx+direction*(2 if tight else 4);inner=edge-direction*.5
                                path=c.beginPath();path.moveTo(inner*mm,(h-by+1.15)*mm);path.lineTo(edge*mm,(h-by+1.15)*mm);path.lineTo(edge*mm,(h-by-1.15)*mm);path.lineTo(inner*mm,(h-by-1.15)*mm);c.drawPath(path)
                            c.setFont('Helvetica',1.95*mm);c.drawCentredString(bx*mm,(h-by-.6)*mm,label);c.setLineWidth(1)
                        else:
                            c.rect((bx-2)*mm,(h-by-1.5)*mm,4*mm,3*mm)
                            c.setFont('Helvetica',6); c.drawCentredString(bx*mm,(h-by-.8)*mm,label)
                else:
                    c.setStrokeColorRGB(.7,.7,.7)
                    style=question.get('style','none' if background_id else 'line')
                    if question.get('content_html'):
                        text_height=rich_layout(question['content_html'],(rw-6)*mm,(rh-12)*mm,**text_options)/mm
                    else:text_height=0
                    body_top=y+12+text_height
                    body_bottom=y+rh-3-(min(rh-12,question.get('image_height',25)) if question.get('image_asset_id') else 0)
                    if style=='line' and body_top<=body_bottom:
                        lines=int(question.get('lines',max(1,int((rh-14)/8))))
                        if not 1<=lines<=100:raise ValueError('横线行数应为1至100')
                        for ly in np.linspace(body_top,body_bottom,lines):c.line((x+3)*mm,(h-ly)*mm,(x+rw-3)*mm,(h-ly)*mm)
                    elif style=='grid':
                        cell=float(question.get('cell_size',8))
                        if not 4<=cell<=20:raise ValueError('作文格大小应为4至20毫米')
                        grid_top=y+10+text_height
                        cols=int((rw-6)/cell);rows=int((body_bottom-grid_top+1)/cell) if template.get('column_frame') or text_height or question.get('image_asset_id') else int((rh-12)/cell)
                        for row in range(rows):
                            for col in range(cols):c.rect((x+3+col*cell)*mm,(h-grid_top-(row+1)*cell)*mm,cell*mm,cell*mm)
                    c.setStrokeColorRGB(0,0,0)
                    image_height=min(rh-12,question.get('image_height',25)) if question.get('image_asset_id') else 0
                    if question.get('content_html'):rich_layout(question['content_html'],(rw-6)*mm,(rh-12-image_height)*mm,c,(x+3)*mm,(h-y-9)*mm,**text_options)
                    if question.get('image_asset_id'):
                        from .storage import materialize
                        try:asset=materialize('assets/'+question['image_asset_id']+'.png')
                        except FileNotFoundError:raise ValueError('题卡插图不存在')
                        c.drawImage(str(asset),(x+3)*mm,(h-y-rh+3)*mm,width=(rw-6)*mm,height=min(rh-12,question.get('image_height',25))*mm,preserveAspectRatio=True,anchor='c',mask='auto')
        if template.get('column_frame'):
            sheet_style.draw_choice_frames(c,template,page,h,panels(template),w)
        if sheet_style.enabled(template):
            c.saveState();c.setStrokeGray(.45);c.setLineWidth(.25*mm)
            count=panels(template);pw=(w-24-(count-1)*8)/count
            if template.get('column_frame'):
                c.setStrokeColorRGB(.73,.36,.32)
                for panel in range(count):
                    left=12+panel*(pw+8)
                    top=97 if page==1 and panel==0 else 31
                    c.roundRect((left-1.5)*mm,17*mm,(pw+3)*mm,(h-top-17)*mm,2.5*mm)
            else:
                for q in template.get('questions',[]):
                    if q['type']!='subjective':continue
                    for r in q['regions']:
                        if r['page']==page:c.roundRect((r['x']-1)*mm,(h-r['y']-r['height']-1)*mm,(r['width']+2)*mm,(r['height']+2)*mm,2*mm)
            size=min(9,(pw-4)*mm/pdfmetrics.stringWidth(sheet_style.FOOTER,FONT,1))
            c.setFillGray(.25);c.setFont(FONT,size)
            for panel in range(count):c.drawCentredString((12+panel*(pw+8)+pw/2)*mm,19*mm,sheet_style.FOOTER)
            c.restoreState()
        for note in template.get('print_notes',[]):
            if note['page']==page:
                rich_layout(note['html'],note['width']*mm,note['height']*mm,c,note['x']*mm,(h-note['y'])*mm,**text_options)
        for area in forbidden_regions(template,page):
            x,y,rw,rh=(area[k] for k in ('x','y','width','height'))
            c.saveState();c.setStrokeGray(.7);c.setLineWidth(.15*mm);c.setDash(2,2)
            c.rect(x*mm,(h-y-rh)*mm,rw*mm,rh*mm)
            c.setDash();c.setStrokeGray(.88)
            c.line(x*mm,(h-y)*mm,(x+rw)*mm,(h-y-rh)*mm);c.line(x*mm,(h-y-rh)*mm,(x+rw)*mm,(h-y)*mm)
            label='该区域禁止答题';font_size=min(11,(rw-4)*mm/8);label_width=pdfmetrics.stringWidth(label,FONT,font_size)
            c.setFillGray(1);c.rect((x+rw/2)*mm-label_width/2-3,(h-y-rh/2)*mm-4,label_width+6,font_size+4,fill=1,stroke=0)
            c.setFillGray(.35);c.setFont(FONT,font_size);c.drawCentredString((x+rw/2)*mm,(h-y-rh/2)*mm,label);c.restoreState()
        if manual_binding(template) or any(q.get('choice_style') in ('bracket','compact') for q in template.get('questions',[])):
            if manual_binding(template):
                for index,gray in enumerate((255,192,128,64,0)):
                    c.setFillGray(gray/255);c.rect((w-44+index*5)*mm,(h-7.5)*mm,4*mm,1.5*mm,fill=1,stroke=0)
                c.setFillGray(0)
            else:
                c.setFillGray(1);c.rect(12*mm,26*mm,98*mm,12*mm,fill=1,stroke=0);c.setFillGray(0)
                c.setFont(FONT,8);c.drawString(12*mm,30*mm,'灰度校准 · 请勿填涂')
                for index,gray in enumerate((255,192,128,64,0)):
                    c.setFillGray(gray/255);c.rect((62+index*8)*mm,29*mm,6*mm,5*mm,fill=1,stroke=0)
                    c.setFillGray(0);c.setLineWidth(.12*mm);c.rect((62+index*8)*mm,29*mm,6*mm,5*mm,fill=0,stroke=1)
            c.setLineWidth(1)
        c.showPage()
    c.save()
    return output.getvalue()
