import io
import math
import numpy as np
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF
from reportlab.pdfbase import pdfmetrics
from .paper_fonts import FONT
from reportlab.lib.utils import ImageReader
from . import db as database
from .richtext import layout as rich_layout

from .omr import ABSENT_X, ABSENT_Y, dimensions, code, bubbles, decode, align, manual_align, absent_mark, recognize, manual_binding, panels, absent_position






def validate(template):
    w,h=dimensions(template)
    compact=any(q.get('choice_style') in ('bracket','compact') for q in template.get('questions',[]))
    columns=panels(template)
    if type(columns) is not int or columns not in ((2,3) if template['paper']=='A3' and manual_binding(template) else (1,)):raise ValueError('A3请选择每面2栏或3栏，A4使用单栏模板')
    panel_width=(w-24-(columns-1)*8)/columns
    if manual_binding(template) and 18+(template.get('candidate_length',8)-1)*6+2>12+panel_width:raise ValueError('准考证号超出首栏，请减少位数或选择较宽的模板')
    if not isinstance(template.get('candidate_length',8),int) or not 1<=template.get('candidate_length',8)<=20: raise ValueError('准考证号长度应为1至20位')
    occupied=[]
    for question in template.get('questions',[]):
        for region in question.get('regions',[]):
            if not all(isinstance(region[k],(int,float)) and math.isfinite(region[k]) for k in ('x','y','width','height')): raise ValueError('答题区坐标无效')
            if not 1<=int(region['page'])<=template['sides']:
                raise ValueError('答题区页码超出题卡范围')
            if min(region['x'],region['y'])<0 or min(region['width'],region['height'])<=0 or region['x']+region['width']>w-8 or region['y']+region['height']>h-8:
                raise ValueError('答题区超出纸张有效范围')
            reserved=100 if not manual_binding(template) or (region['page']==1 and region['x']<12+panel_width) else 35
            if region['y']<reserved:raise ValueError(f'本栏答题区需从{reserved}毫米开始，保留标题及考号区域')
            if manual_binding(template):
                panel=min(columns-1,max(0,int((region['x']-12+.01)/(panel_width+8))))
                left=12+panel*(panel_width+8)
                if region['x']<left-.01 or region['x']+region['width']>left+panel_width+.01:raise ValueError('答题区域不能跨越题卡分栏')
            bracket=question.get('choice_style')=='bracket'
            tight=question.get('choice_style')=='compact'
            if question.get('choice_style') not in (None,'bracket','compact'):raise ValueError('选择题填涂样式无效')
            minimum_width=12+(question.get('options',4)-1)*5 if tight else 20+(question.get('options',4)-1)*9.5 if bracket else 12+question.get('options',4)*6
            if question['type']!='subjective' and (region['width']<minimum_width or region['height']<(4.6 if tight else 6 if bracket else 14)): raise ValueError('客观题区域不足以容纳选项')
            if compact and region['x']<110 and region['x']+region['width']>12 and region['y']<h-26 and region['y']+region['height']>h-38:raise ValueError('答题区与页脚灰度校准区域重叠')
            for previous in occupied:
                if previous['page']==region['page'] and region['x']<previous['x']+previous['width'] and previous['x']<region['x']+region['width'] and region['y']<previous['y']+previous['height'] and previous['y']<region['y']+region['height']: raise ValueError('答题区域重叠')
            occupied.append(region)
            if question.get('content_html'):
                image_height=min(region['height']-12,question.get('image_height',25)) if question.get('image_asset_id') else 0
                rich_layout(question['content_html'],(region['width']-6)*mm,(region['height']-12-image_height)*mm)
        if question['type']!='subjective':
            count=int(question.get('options',4))
            if count not in (3,4,5) or not set(question.get('answer',[]))<=set('ABCDE'[:count]):
                raise ValueError('选项或标准答案无效')




def forbidden_regions(template,page):
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
    validate(template)
    output=io.BytesIO()
    w,h=dimensions(template)
    c=canvas.Canvas(output,pagesize=(w*mm,h*mm))
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
            c.drawString(15*mm,(h-20)*mm,template['name'])
            if template.get('subtitle'):
                c.setFont(FONT,10);c.drawString(15*mm,(h-25)*mm,template['subtitle'])
        c.setFont(FONT,9)
        c.drawString(15*mm,(h-29)*mm,f"第{page}面 · 按实际大小打印，保留定位标记")
        if not manual_binding(template):
            widget=qr.QrCodeWidget(code(template,side)); x0,y0,x1,y1=widget.getBounds()
            drawing=Drawing(26*mm,26*mm,transform=[26*mm/(x1-x0),0,0,26*mm/(y1-y0),0,0]); drawing.add(widget)
            renderPDF.draw(drawing,c,(w-42)*mm,(h-36)*mm)
        if manual_binding(template):
            count=panels(template);pw=(w-24-(count-1)*8)/count
            for panel in range(count):
                left=12+panel*(pw+8)
                if panel:
                    c.setDash(1,3);c.setStrokeGray(.65);c.line((left-4)*mm,15*mm,(left-4)*mm,(h-15)*mm);c.setDash();c.setStrokeGray(0)
                c.setFont(FONT,8);c.drawRightString((left+pw-2)*mm,16*mm,f'第{(page-1)*count+panel+1}栏 / 共{count*template["sides"]}栏')
        for x,y in ((7,7),(w-7,7),(7,h-7),(w-7,h-7)):
            c.rect((x-2)*mm,(h-y-2)*mm,4*mm,4*mm,fill=1,stroke=0)
        if page==1:
            c.drawString(15*mm,(h-39)*mm,'姓名：____________  班级：____________  考场：____________')
            if template.get('layout_version',1)>=2:
                c.drawString(15*mm,(h-46)*mm,'准考证号：')
                ax,ay=absent_position(template)
                c.drawString((ax-23)*mm,(h-46)*mm,'缺考标记：')
                c.rect((ax-2)*mm,(h-ay-1.5)*mm,4*mm,3*mm)
                c.setFont(FONT,7);c.drawString((ax-24)*mm,(h-51)*mm,'由监考教师填涂')
            else:c.drawString(15*mm,(h-46)*mm,'准考证号：                       缺考标记：□（由监考教师填写）')
            for column in range(int(template.get('candidate_length',8))):
                x=18+column*6
                c.rect((x-2)*mm,(h-54)*mm,4*mm,5*mm)
                for digit in range(10):
                    y=57+digit*3.5
                    c.rect((x-1.6)*mm,(h-y-1.2)*mm,3.2*mm,2.4*mm)
                    c.setFont('Helvetica',5); c.drawCentredString(x*mm,(h-y-.6)*mm,str(digit))
        column_tops={}
        for q in template.get('questions',[]):
            if q.get('choice_style') in ('bracket','compact') and q['type']!='subjective':
                for r in q['regions']:
                    if int(r['page'])==page:column_tops[r['x']]=min(column_tops.get(r['x'],r['y']),r['y'])
        c.setFont(FONT,8)
        for x,top in column_tops.items():c.drawString((x+2)*mm,(h-top+2)*mm,'题号')
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
                    if style=='line':
                        lines=int(question.get('lines',max(1,int((rh-14)/8))))
                        if not 1<=lines<=100:raise ValueError('横线行数应为1至100')
                        for ly in np.linspace(y+12,y+rh-3,lines):c.line((x+3)*mm,(h-ly)*mm,(x+rw-3)*mm,(h-ly)*mm)
                    elif style=='grid':
                        cell=float(question.get('cell_size',8))
                        if not 4<=cell<=20:raise ValueError('作文格大小应为4至20毫米')
                        cols=int((rw-6)/cell);rows=int((rh-12)/cell)
                        for row in range(rows):
                            for col in range(cols):c.rect((x+3+col*cell)*mm,(h-y-10-(row+1)*cell)*mm,cell*mm,cell*mm)
                    c.setStrokeColorRGB(0,0,0)
                    image_height=min(rh-12,question.get('image_height',25)) if question.get('image_asset_id') else 0
                    if question.get('content_html'):rich_layout(question['content_html'],(rw-6)*mm,(rh-12-image_height)*mm,c,(x+3)*mm,(h-y-9)*mm)
                    if question.get('image_asset_id'):
                        from .storage import materialize
                        try:asset=materialize('assets/'+question['image_asset_id']+'.png')
                        except FileNotFoundError:raise ValueError('题卡插图不存在')
                        c.drawImage(str(asset),(x+3)*mm,(h-y-rh+3)*mm,width=(rw-6)*mm,height=min(rh-12,question.get('image_height',25))*mm,preserveAspectRatio=True,anchor='c',mask='auto')
        for area in forbidden_regions(template,page):
            x,y,rw,rh=(area[k] for k in ('x','y','width','height'))
            c.saveState();c.setStrokeGray(.7);c.setLineWidth(.15*mm);c.setDash(2,2)
            c.rect(x*mm,(h-y-rh)*mm,rw*mm,rh*mm)
            c.setDash();c.setStrokeGray(.88)
            c.line(x*mm,(h-y)*mm,(x+rw)*mm,(h-y-rh)*mm);c.line(x*mm,(h-y-rh)*mm,(x+rw)*mm,(h-y)*mm)
            label='该区域禁止答题';font_size=min(11,(rw-4)*mm/8);label_width=pdfmetrics.stringWidth(label,FONT,font_size)
            c.setFillGray(1);c.rect((x+rw/2)*mm-label_width/2-3,(h-y-rh/2)*mm-4,label_width+6,font_size+4,fill=1,stroke=0)
            c.setFillGray(.35);c.setFont(FONT,font_size);c.drawCentredString((x+rw/2)*mm,(h-y-rh/2)*mm,label);c.restoreState()
        if any(q.get('choice_style') in ('bracket','compact') for q in template.get('questions',[])):
            c.setFillGray(1);c.rect(12*mm,26*mm,98*mm,12*mm,fill=1,stroke=0);c.setFillGray(0)
            c.setFont(FONT,8);c.drawString(12*mm,30*mm,'灰度校准 · 请勿填涂')
            for index,gray in enumerate((255,192,128,64,0)):
                c.setFillGray(gray/255);c.rect((62+index*8)*mm,29*mm,6*mm,5*mm,fill=1,stroke=0)
                c.setFillGray(0);c.setLineWidth(.12*mm);c.rect((62+index*8)*mm,29*mm,6*mm,5*mm,fill=0,stroke=1)
            c.setLineWidth(1)
        c.showPage()
    c.save()
    return output.getvalue()
