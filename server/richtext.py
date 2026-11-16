from reportlab.pdfgen.canvas import Canvas
from .paper_fonts import FONT,font_name
import base64
import math
import re
from dataclasses import dataclass
from html import escape
from html.parser import HTMLParser
from reportlab.lib.enums import TA_LEFT,TA_CENTER,TA_RIGHT,TA_JUSTIFY
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from PIL import Image
from reportlab.platypus import Flowable,Paragraph,Table,TableStyle,Spacer


class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root=['root',{},[]];self.stack=[self.root];self.blocked=0
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style','iframe','object'):self.blocked+=1
        if self.blocked:return
        node=[tag,dict(attrs),[]];self.stack[-1][2].append(node)
        if tag not in ('br','hr','img','meta','input','link'):self.stack.append(node)
    def handle_endtag(self,tag):
        if tag in ('script','style','iframe','object'):
            self.blocked=max(0,self.blocked-1);return
        if self.blocked:return
        for index in range(len(self.stack)-1,0,-1):
            if self.stack[index][0]==tag:self.stack=self.stack[:index];break
    def handle_data(self,data):
        if not self.blocked:self.stack[-1][2].append(data)


def css(attrs):
    return {key.strip().lower():value.strip() for part in attrs.get('style','').split(';') if ':' in part for key,value in [part.split(':',1)]}


def points(value,minimum,maximum,label):
    match=re.fullmatch(r'(-?\d+(?:\.\d+)?)\s*(pt|px)?',str(value).strip(),re.I)
    if not match:raise ValueError(label+'无效')
    number=float(match[1])*(.75 if (match[2] or '').lower()=='px' else 1)
    if not minimum<=number<=maximum:raise ValueError(f'{label}须介于 {minimum:g} 与 {maximum:g} 磅之间')
    return number


def hex_color(value):
    if not re.fullmatch(r'#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?',str(value)):raise ValueError('文字颜色须使用十六进制色值')
    return '#'+''.join(ch*2 for ch in value[1:]) if len(value)==4 else value


INLINE_PROPERTIES={'font-family','font-size','color','background-color','font-weight','font-style','text-decoration','vertical-align'}
INHERITED_PROPERTIES=INLINE_PROPERTIES|{'text-align','text-indent','data-line-leading'}


def styled_markup(content,style):
    weight=style.get('font-weight','').lower()
    if weight in ('bold','bolder','600','700','800','900'):content='<b>'+content+'</b>'
    if style.get('font-style','').lower() in ('italic','oblique'):content='<i>'+content+'</i>'
    decoration=style.get('text-decoration','').lower()
    if 'underline' in decoration:content='<u>'+content+'</u>'
    if 'line-through' in decoration:content='<strike>'+content+'</strike>'
    if style.get('vertical-align','').lower() in ('super','sup'):content='<sup>'+content+'</sup>'
    if style.get('vertical-align','').lower()=='sub':content='<sub>'+content+'</sub>'
    attributes=[]
    if 'font-family' in style:attributes.append('name="'+font_name(style['font-family'])+'"')
    if 'font-size' in style:attributes.append('size="'+str(points(style['font-size'],6,36,'字号'))+'"')
    if 'color' in style:attributes.append('color="'+hex_color(style['color'])+'"')
    if 'background-color' in style:attributes.append('backColor="'+hex_color(style['background-color'])+'"')
    return '<font '+' '.join(attributes)+'>'+content+'</font>' if attributes else content


# Indivisible inline boxes are painted by PaperCanvas as vectors.
_RULE_PIXEL=ImageReader(Image.new('RGB',(1,1),'black'))


@dataclass
class EnclosedText:
    text:str
    font:str
    size:float
    color:object
    background:object=None


class PaperCanvas(Canvas):
    def drawImage(self,image,x,y,width=None,height=None,**kwargs):
        if image is not _RULE_PIXEL and not isinstance(image,EnclosedText):
            return super().drawImage(image,x,y,width,height,**kwargs)
        self.saveState()
        if image is _RULE_PIXEL:
            self.setFillGray(0);self.rect(x,y,width,height,stroke=0,fill=1)
        else:
            self.setLineWidth(.65);self.setStrokeColor(image.color)
            if image.background is not None:
                self.setFillColor(image.background);self.ellipse(x+.35,y+.35,x+width-.35,y+height-.35,stroke=0,fill=1)
            self.ellipse(x+.35,y+.35,x+width-.35,y+height-.35,stroke=1,fill=0)
            self.setFillColor(image.color);self.setFont(image.font,image.size)
            ascent,descent=pdfmetrics.getAscentDescent(image.font,image.size)
            baseline=y+(height-ascent+descent)/2-descent
            self.drawCentredString(x+width/2,baseline,image.text)
        self.restoreState()
        return width,height


def rule_markup(length,width):
    size=min(width,max(mm,min(400,float(length))*mm))
    return f'<onDraw name="answerLine" label="{size:.4f}"/>'


def inline(node,width,underlined=False):
    if isinstance(node,str):
        pattern=r'(_(?:[ \t\xa0]*_)+|[ \t\xa0]{2,})' if underlined else r'(_(?:[ \t\xa0]*_)+)'
        return ''.join(rule_markup(len(part)*(1.42 if '_' in part else .71),width) if i%2 else escape(part)
                       for i,part in enumerate(re.split(pattern,node)))
    tag,attrs,children=node
    if tag=='span' and 'data-answer-line' in attrs:
        raw=attrs['data-answer-line'] or ''
        if raw=='end':return '<onDraw name="answerLine" label="end"/>'
        if not re.fullmatch(r'\d{1,3}(?:\.\d{1,2})?',raw):raise ValueError('答题线长度无效')
        return rule_markup(raw,width)
    if tag=='span' and 'data-enclosed-text' in attrs:
        text=attrs['data-enclosed-text'] or ''
        if not text.strip() or len(text)>8 or any(ord(ch)<32 for ch in text):raise ValueError('带圈文字须为 1 至 8 个可见字符')
        encoded=base64.urlsafe_b64encode(text.encode()).decode()
        return styled_markup(f'<onDraw name="circledText" label="{encoded}"/>',css(attrs))
    style=css(attrs)
    underline=tag=='u' or 'underline' in style.get('text-decoration','').lower()
    content=''.join(inline(child,width,underlined or underline) for child in children)
    if tag=='br':return '<br/>'
    if tag in ('b','strong','th'):content='<b>'+content+'</b>'
    if tag in ('i','em'):content='<i>'+content+'</i>'
    if tag in ('u','sup','sub'):content=f'<{tag}>'+content+f'</{tag}>'
    if tag in ('s','strike','del'):content='<strike>'+content+'</strike>'
    return styled_markup(content,style)


class AnswerParagraph(Paragraph):
    def breakLinesCJK(self,maxWidths):
        result=super().breakLinesCJK(maxWidths)
        if result.kind==1:
            for line in result.lines:
                for word in line.words:
                    rule=getattr(word,'cbDefn',None)
                    if rule and getattr(rule,'name',None)=='answerLine' and rule.label=='end':
                        word.cbDefn=rule.clone(width=max(0,line.extraSpace));line.extraSpace=0;break
        return result

    def wrap(self,availWidth,availHeight):
        result=super().wrap(availWidth,availHeight)
        for line in self.blPara.lines:
            extra=line[0] if self.blPara.kind==0 else line.extraSpace
            if extra<-.1:raise ValueError('富文本超过答题区域，请扩大区域或精简内容')
        return result


class InsetBlock(Flowable):
    def __init__(self,children,left=0,right=0,before=0,after=0):
        super().__init__();self.children=children;self.left=left;self.right=right;self.before=before;self.after=after
    def wrap(self,availWidth,availHeight):
        width=availWidth-self.left-self.right
        if width<=0:raise ValueError('段落缩进超出答题区域')
        self.boxes=[(flow,flow.wrap(width,1000000)[1]) for flow in self.children]
        self.width=availWidth;self.height=self.before+self.after+sum(height for _,height in self.boxes)
        return self.width,self.height
    def draw(self):
        used=self.before
        for flow,height in self.boxes:
            flow.drawOn(self.canv,self.left,self.height-used-height);used+=height


def list_label(number,kind):
    if kind=='1' or number<=0:return str(number)+'.'
    if kind in ('a','A'):
        out='';value=number
        while value:value,remainder=divmod(value-1,26);out=chr(97+remainder)+out
    else:
        out='';value=number
        for amount,letter in [(1000,'m'),(900,'cm'),(500,'d'),(400,'cd'),(100,'c'),(90,'xc'),(50,'l'),(40,'xl'),(10,'x'),(9,'ix'),(5,'v'),(4,'iv'),(1,'i')]:
            count,value=divmod(value,amount);out+=letter*count
    return (out.upper() if kind in ('A','I') else out)+'.'


def flowables(html,width,font_size=9,leading=13):
    if len(html)>100000:raise ValueError('单题富文本过长')
    if not math.isfinite(width) or width<=0:raise ValueError('富文本区域宽度无效')
    parser=Parser();parser.feed(html)
    base=ParagraphStyle('answer',fontName=FONT,fontSize=font_size,leading=leading,wordWrap='CJK',autoLeading='max')
    blocks={'p','div','table','ul','ol','li','h1','h2','h3','h4','h5','h6'}
    def paragraph(node,available,inherited=None,bullet=None,indent=0):
        inherited=inherited or {};attrs={} if isinstance(node,str) else node[1];own=css(attrs)
        combined={**inherited,**own}
        size=points(combined['font-size'],6,36,'字号') if 'font-size' in combined else font_size
        family=font_name(combined.get('font-family'))
        left=points(own.get('margin-left','0'),0,144,'左缩进')+indent
        right=points(own.get('margin-right','0'),0,144,'右缩进')
        first=points(combined.get('text-indent','0'),-72,144,'首行缩进')
        if left+first<-.01 or available-left-right<=0 or available-left-right-first<=0:raise ValueError('段落缩进超出答题区域')
        align=combined.get('text-align','left').lower()
        if align not in ('left','center','right','justify'):raise ValueError('段落对齐方式无效')
        line_height=attrs.get('data-line-leading',combined.get('data-line-leading'))
        exact=line_height is not None
        line_height=points(line_height,6,72,'单行行距') if exact else leading
        style=ParagraphStyle('row',parent=base,fontName=family,fontSize=size,leading=line_height,autoLeading='' if exact else 'max',
                             alignment={'left':TA_LEFT,'center':TA_CENTER,'right':TA_RIGHT,'justify':TA_JUSTIFY}[align],leftIndent=left,rightIndent=right,firstLineIndent=first,
                             bulletFontName=family,bulletFontSize=size,bulletIndent=max(0,left-indent))
        content=styled_markup(inline(node,available-left-right,'underline' in inherited.get('text-decoration','')), {key:value for key,value in inherited.items() if key in INLINE_PROPERTIES})
        result=AnswerParagraph(content or ' ',style,bulletText=bullet)
        for i,frag in enumerate(result.frags):
            cb=getattr(frag,'cbDefn',None)
            if not cb:continue
            if getattr(cb,'name',None)=='answerLine':
                cb.kind='img';cb.image=_RULE_PIXEL;cb.height=.75;cb.valign=-1
                if cb.label=='end':
                    cb.width=0
                    if i+1==len(result.frags) or not hasattr(result.frags[i+1],'lineBreak'):frag.lineBreak=True
                else:cb.width=float(cb.label)
                frag.text='\ufffc'
            elif getattr(cb,'name',None)=='circledText':
                text=base64.urlsafe_b64decode(cb.label.encode()).decode()
                cb.kind='img';cb.width=max(frag.fontSize*1.3,pdfmetrics.stringWidth(text,frag.fontName,frag.fontSize)+frag.fontSize*.5);cb.height=frag.fontSize*1.5;cb.valign=-frag.fontSize*.25
                if cb.width>available-left-right+.01:raise ValueError('带圈文字超过答题区域，请缩短文字或扩大区域')
                cb.image=EnclosedText(text,frag.fontName,frag.fontSize,frag.textColor,getattr(frag,'backColor',None));frag.text='\ufffc'
        before=points(own.get('margin-top','0'),0,72,'段前间距')
        tag='' if isinstance(node,str) else node[0]
        after=points(own.get('margin-bottom','3' if tag in ('p','li','h1','h2','h3','h4','h5','h6') else '0'),0,72,'段后间距')
        return ([Spacer(1,before)] if before else [])+[result]+([Spacer(1,after)] if after else [])
    def inherited_style(attrs,parent):
        combined={**parent,**{key:value for key,value in css(attrs).items() if key in INHERITED_PROPERTIES}}
        if 'data-line-leading' in attrs:combined['data-line-leading']=attrs['data-line-leading']
        return combined
    def visit(node,available=width,inherited=None,bullet=None,indent=0):
        inherited=inherited or {}
        if isinstance(node,str):return paragraph(node,available,inherited,bullet,indent) if node.strip() else []
        tag,attrs,children=node;own=css(attrs);child_style=inherited_style(attrs,inherited)
        if tag=='table':
            rows=[]
            def collect(n):
                if isinstance(n,str):return
                if n[0]=='tr':rows.append([cell for cell in n[2] if not isinstance(cell,str) and cell[0] in ('td','th')])
                elif n[0]!='table' or n is node:
                    for child in n[2]:collect(child)
            collect(node);rows=[row for row in rows if row]
            if not rows:return []
            columns=max(map(len,rows))
            if columns>30 or len(rows)>100:raise ValueError('表格过大')
            if any(cell[1].get('colspan','1')!='1' or cell[1].get('rowspan','1')!='1' for row in rows for cell in row):raise ValueError('表格仅支持独立等宽单元格')
            cell_width=max(1,available/columns-8)
            def cell_content(cell):
                cell_style=inherited_style(cell[1],child_style)
                if cell[0]=='th':cell_style['font-weight']='bold'
                return visit(['root',{},cell[2]],cell_width,cell_style)
            cells=[[cell_content(cell) for cell in row]+['']*(columns-len(row)) for row in rows]
            table=Table(cells,colWidths=[available/columns]*columns)
            table.setStyle(TableStyle([('GRID',(0,0),(-1,-1),.4,'#555555'),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4)]))
            return [table,Spacer(1,3)]
        if tag in ('ol','ul'):
            marker=attrs.get('type','1')
            start=str(attrs.get('start','1'))
            if tag=='ol' and (marker not in ('1','a','A','i','I') or not re.fullmatch(r'-?\d{1,4}',start)):raise ValueError('列表编号无效')
            counter=int(start) if tag=='ol' else 1;result=[]
            bullet_type=own.get('list-style-type',attrs.get('type','disc')) if tag=='ul' else ''
            if tag=='ul' and bullet_type not in ('disc','circle','square'):raise ValueError('项目符号无效')
            for item in children:
                if isinstance(item,str) or item[0]!='li':continue
                label=list_label(counter,marker) if tag=='ol' else {'disc':'•','circle':'○','square':'▪'}[bullet_type]
                marker_style=inherited_style(item[1],child_style)
                marker_size=points(marker_style['font-size'],6,36,'字号') if 'font-size' in marker_style else font_size
                marker_width=pdfmetrics.stringWidth(label,font_name(marker_style.get('font-family')),marker_size)
                result.extend(visit(item,available,child_style,label,max(18,marker_width+6)));counter+=1
            return result
        has_blocks=any(not isinstance(child,str) and child[0] in blocks for child in children)
        if not has_blocks:return paragraph(node,available,inherited,bullet,indent) if tag in blocks or inline(node,available).strip() else []
        left=points(own.get('margin-left','0'),0,144,'左缩进')
        right=points(own.get('margin-right','0'),0,144,'右缩进')
        before=points(own.get('margin-top','0'),0,72,'段前间距');after=points(own.get('margin-bottom','0'),0,72,'段后间距')
        inner=available-left-right
        if inner<=0:raise ValueError('段落缩进超出答题区域')
        result=[];run=[];first_bullet=bullet
        def flush():
            nonlocal run,first_bullet
            if run and any(not isinstance(child,str) or child.strip() for child in run):
                result.extend(paragraph(['div',{},run],inner,child_style,first_bullet,indent));first_bullet=None
            run=[]
        for child in children:
            if not isinstance(child,str) and child[0] in blocks:
                flush()
                if tag=='li' and child[0] in ('ul','ol'):
                    if first_bullet is not None:result.extend(paragraph(['div',{},[]],inner,child_style,first_bullet,indent));first_bullet=None
                    result.append(InsetBlock(visit(child,inner-indent,child_style),left=indent))
                else:
                    result.extend(visit(child,inner,child_style,first_bullet,indent));first_bullet=None
            else:run.append(child)
        flush()
        return [InsetBlock(result,left,right,before,after)] if left or right or before or after else result
    return visit(parser.root)


def layout(html,width,height,canvas=None,x=0,top=0,*,font_size=9,leading=13):
    if not math.isfinite(height) or height<0:raise ValueError('富文本区域高度无效')
    used=0
    for flow in flowables(html,width,font_size,leading):
        _,needed=flow.wrap(width,max(0,height-used))
        if used+needed>height+.01:raise ValueError('富文本超过答题区域，请扩大区域或精简内容')
        if canvas is not None:flow.drawOn(canvas,x,top-used-needed)
        used+=needed
    return used
