"""Built-in, printable exam notices transcribed from the supplied reference sheet."""
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from .paper_fonts import FONT

STANDARD = 'standard-v1'
ABSENCE = '缺考考生，由监考员用2B铅笔填涂下面的缺考标记。'
NOTICES = (
    '答题前，考生须将自己的姓名、准考证号填写清楚，并认真核对条形码上的姓名、准考证号。',
    '选择题部分必须使用2B铅笔填涂；非选择题部分必须使用0.5毫米的黑色签字笔书写，字体工整、笔迹清楚。',
    '请按照题号顺序在各题目的答题区域内作答，超出答题区域书写的答案无效；在草稿纸、试题卷上答题无效。',
    '未在规定区域内答题，每错一个区域扣卷面总分1分。',
    '保持答题纸清洁，不要折叠、不要弄破。',
)


def enabled(template):
    return template.get('notice_template') == STANDARD and template.get('layout_version', 2) >= 3


def wrap(text, width, size):
    lines=[];line=''
    for character in text:
        if line and pdfmetrics.stringWidth(line+character,FONT,size)>width*mm:
            lines.append(line);line=''
        line+=character
    if line:lines.append(line)
    return lines


def geometry(template):
    from .omr import dimensions,panels
    from . import sheet_style
    width,_=dimensions(template);count=panels(template)
    panel_width=(width-24-(count-1)*8)/count
    left=sheet_style.header_geometry(template)['notice_left'] if sheet_style.enabled(template) else max(70,22+(template.get('candidate_length',8)-1)*6)
    return left,12+panel_width-left


def fitted_notices(width):
    for size in (7.5,7.25,7,6.75,6.5,6.25,6,5.75,5.5):
        lines=[line for index,text in enumerate(NOTICES,1) for line in wrap(f'{index}. {text}',width-4,size)]
        leading=(size+1)/mm
        if len(lines)*leading<=25:return size,leading,lines
    raise ValueError('须知区域不足，请选择较宽的分栏或减少准考证号位数')


def draw(c,template):
    from .omr import dimensions,absent_position
    from . import sheet_style
    _,height=dimensions(template);left,width=geometry(template)
    if width<54:raise ValueError('当前考号位数与须知区域冲突，请选择较宽的分栏、减少考号位数或关闭内置须知')
    if template.get('notice_layout',1)==2:
        return draw_stacked(c,template,left,width,height)
    size,leading,lines=fitted_notices(width)
    ax,ay=absent_position(template)
    current=sheet_style.enabled(template)
    right=left+width;absence_left=left if current else 72
    def text(x,y,value,font_size):
        c.setFont(FONT,font_size);c.drawString(x*mm,(height-y)*mm,value)
    def box(x,y,w,h,fill=0):c.rect(x*mm,(height-y-h)*mm,w*mm,h*mm,fill=fill,stroke=1)
    c.saveState();c.setFillGray(0);c.setStrokeGray(0);c.setLineWidth(.18*mm)
    box(absence_left,35,right-absence_left,19 if current else 14.5)
    text(absence_left+2,38.5,'考生禁填',7.5)
    for index,line in enumerate(wrap(ABSENCE,ax-absence_left-8,6)):
        text(absence_left+2,42+index*2.4,line,6)
    box(ax-2,ay-1.5,4,3)
    c.setFont(FONT,6);c.drawCentredString(ax*mm,(height-49)*mm,'缺考标记')
    box(left,54,width,40)
    text(left+2,57.5,'注意事项',7.5)
    for index,line in enumerate(lines):text(left+2,60.5+index*leading,line,size)
    c.line(left*mm,(height-85.5)*mm,right*mm,(height-85.5)*mm)
    text(left+2,89,'填涂样例',6.5);text(left+20,89,'正确填涂',6)
    box(left+20+pdfmetrics.stringWidth('正确填涂',FONT,6)/mm+1.5,86.7,4,2.3,1)
    text(left+2,93.5,'错误填涂',6)
    for index in range(4):
        x=left+23+index*8;y=91
        box(x,y,4,2.3)
        if index==0:
            c.line(x*mm,(height-y)*mm,(x+4)*mm,(height-y-2.3)*mm)
            c.line(x*mm,(height-y-2.3)*mm,(x+4)*mm,(height-y)*mm)
        elif index==1:
            path=c.beginPath();path.moveTo((x+.2)*mm,(height-y-1.1)*mm);path.lineTo((x+1.5)*mm,(height-y-2)*mm);path.lineTo((x+3.7)*mm,(height-y-.2)*mm);c.drawPath(path)
        elif index==2:c.ellipse((x+.5)*mm,(height-y-2.1)*mm,(x+3.5)*mm,(height-y-.2)*mm)
        else:
            c.setFillGray(.6);box(x,y,1.7,2.3,1);c.setFillGray(0)
    c.restoreState()


def draw_stacked(c,template,left,width,height):
    """Aligned header: notices above absence instructions and fill examples."""
    from .omr import absent_position
    size,leading,lines=fitted_notices(width)
    split=left+width*.55;right=left+width
    def text(x,y,value,font_size=6):
        c.setFont(FONT,font_size);c.drawString(x*mm,(height-y)*mm,value)
    def box(x,y,w,h,fill=0):c.rect(x*mm,(height-y-h)*mm,w*mm,h*mm,fill=fill,stroke=1)
    def line(x1,y1,x2,y2):c.line(x1*mm,(height-y1)*mm,x2*mm,(height-y2)*mm)
    c.saveState();c.setFillGray(0);c.setStrokeGray(0);c.setLineWidth(.18*mm)
    box(left,35,width,59);line(left,72,right,72);line(split,72,split,94)
    text(left+2,39,'注意事项',7.5)
    for index,value in enumerate(lines):text(left+2,43+index*leading,value,size)
    text(left+2,76,'考生禁填',7)
    for index,value in enumerate(wrap(ABSENCE,split-left-4,6)):
        text(left+2,79.2+index*2.5,value)
    ax,ay=absent_position(template);box(ax-2,ay-1.5,4,3)
    c.setFont(FONT,6);c.drawCentredString(ax*mm,(height-92.5)*mm,'缺考标记')
    text(split+2,76,'填涂样例',7)
    text(split+2,80.5,'正确填涂');box(split+2+pdfmetrics.stringWidth('正确填涂',FONT,6)/mm+1.5,78.5,4,2.3,1)
    text(split+2,84.8,'错误填涂')
    for index in range(4):
        x=split+2+index*5.4;y=88
        box(x,y,4,2.3)
        if index==0:line(x,y,x+4,y+2.3);line(x,y+2.3,x+4,y)
        elif index==1:
            line(x+.2,y+1.1,x+1.5,y+2);line(x+1.5,y+2,x+3.7,y+.2)
        elif index==2:c.ellipse((x+.5)*mm,(height-y-2.1)*mm,(x+3.5)*mm,(height-y-.2)*mm)
        else:
            c.setFillGray(.6);box(x,y,1.7,2.3,1);c.setFillGray(0)
    c.restoreState()
