from .paper_fonts import FONT
import re
from html import escape
from html.parser import HTMLParser
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from PIL import Image
from reportlab.platypus import Paragraph,Table,TableStyle,Spacer


class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root=['root',{},[]]; self.stack=[self.root]; self.blocked=0
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style','iframe','object'): self.blocked+=1
        if self.blocked:return
        node=[tag,dict(attrs),[]]; self.stack[-1][2].append(node)
        if tag not in ('br','hr','img','meta','input','link'): self.stack.append(node)
    def handle_endtag(self,tag):
        if tag in ('script','style','iframe','object'):
            self.blocked=max(0,self.blocked-1);return
        if self.blocked:return
        for index in range(len(self.stack)-1,0,-1):
            if self.stack[index][0]==tag:self.stack=self.stack[:index];break
    def handle_data(self,data):
        if not self.blocked:self.stack[-1][2].append(data)


# ReportLab treats inline images as indivisible layout items. The ink is a
# local one-pixel swatch stretched to the specified physical dimensions.
_RULE_PIXEL=ImageReader(Image.new('RGB',(1,1),'black'))


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
    style=attrs.get('style','').lower()
    underline=tag=='u' or ('text-decoration' in style and 'underline' in style)
    content=''.join(inline(child,width,underlined or underline) for child in children)
    if tag=='br':return '<br/>'
    if tag in ('b','strong'):content='<b>'+content+'</b>'
    if tag in ('i','em'):content='<i>'+content+'</i>'
    if tag in ('u','sup','sub'):content=f'<{tag}>'+content+f'</{tag}>'
    if re.search(r'vertical-align:\s*super',style):content='<sup>'+content+'</sup>'
    if re.search(r'vertical-align:\s*sub',style):content='<sub>'+content+'</sub>'
    if 'font-weight' in style and any(v in style for v in ('bold','700','800')):content='<b>'+content+'</b>'
    if 'font-style' in style and 'italic' in style:content='<i>'+content+'</i>'
    if 'text-decoration' in style and 'underline' in style:content='<u>'+content+'</u>'
    return content


class AnswerParagraph(Paragraph):
    def breakLinesCJK(self, maxWidths):
        result = super().breakLinesCJK(maxWidths)
        if result.kind == 1:
            for line in result.lines:
                for word in line.words:
                    rule = getattr(word, 'cbDefn', None)
                    if rule and rule.label == 'end':
                        # Keep the source fragment independent of this wrap's width.
                        word.cbDefn = rule.clone(width=max(0, line.extraSpace))
                        line.extraSpace = 0
                        break
        return result


def flowables(html,width):
    if len(html)>100000:raise ValueError('单题富文本过长')
    parser=Parser();parser.feed(html)
    style=ParagraphStyle('answer',fontName=FONT,fontSize=9,leading=13,wordWrap='CJK')
    def paragraph(content):
        result=AnswerParagraph(content or ' ',style)
        for i,frag in enumerate(result.frags):
            cb=getattr(frag,'cbDefn',None)
            if cb and getattr(cb,'name',None)=='answerLine':
                cb.kind='img';cb.image=_RULE_PIXEL;cb.height=.75;cb.valign=-1
                if cb.label=='end':
                    cb.width=0
                    if i+1==len(result.frags) or not hasattr(result.frags[i+1],'lineBreak'):
                        frag.lineBreak=True
                else:cb.width=float(cb.label)
                # The CJK line breaker needs a character for its wrap decision.
                # For image fragments it uses the declared width and draws only the image.
                frag.text='\ufffc'
        return result
    def visit(node):
        if isinstance(node,str):return [paragraph(inline(node,width))] if node.strip() else []
        tag,attrs,children=node
        if tag=='table':
            rows=[]
            def collect(n):
                if isinstance(n,str):return
                if n[0]=='tr':rows.append([cell for cell in n[2] if not isinstance(cell,str) and cell[0] in ('td','th')])
                else:
                    for child in n[2]:collect(child)
            collect(node);rows=[r for r in rows if r]
            if not rows:return []
            columns=max(map(len,rows))
            if columns>30 or len(rows)>100:raise ValueError('表格过大')
            cells=[[paragraph(inline(cell,max(1,width/columns-8))) for cell in row]+['']*(columns-len(row)) for row in rows]
            table=Table(cells,colWidths=[width/columns]*columns)
            table.setStyle(TableStyle([('GRID',(0,0),(-1,-1),.4,'#555555'),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4)]))
            return [table,Spacer(1,3)]
        if tag in ('p','h1','h2','h3','li'):
            return [paragraph(('- ' if tag=='li' else '')+inline(node,width)),Spacer(1,3)]
        blocks=('p','div','table','ul','ol','li','h1','h2','h3')
        if any(not isinstance(child,str) and child[0] in blocks for child in children):
            result=[];run=[]
            for child in children:
                if not isinstance(child,str) and child[0] in blocks:
                    if run:
                        content=''.join(run)
                        if content.strip():result.append(paragraph(content))
                        run=[]
                    result.extend(visit(child))
                else:run.append(inline(child,width))
            if run and ''.join(run).strip():result.append(paragraph(''.join(run)))
            return result
        content=inline(node,width)
        return [paragraph(content)] if content.strip() else []
    return visit(parser.root)


def layout(html,width,height,canvas=None,x=0,top=0):
    used=0
    for flow in flowables(html,width):
        _,needed=flow.wrap(width,max(0,height-used))
        if used+needed>height+.01:raise ValueError('富文本超过答题区域，请扩大区域或精简内容')
        if canvas is not None:flow.drawOn(canvas,x,top-used-needed)
        used+=needed
    return used
