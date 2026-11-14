from .paper_fonts import FONT
import re
from html import escape
from html.parser import HTMLParser
from reportlab.lib.styles import ParagraphStyle
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


def inline(node,underlined=False):
    if isinstance(node,str):
        if underlined:
            node=re.sub(r'[ \t]+',lambda m:'\xa0'*len(m[0]),node)
        return re.sub(r'_(?:[ \t\xa0]*_)+',lambda m:'<u>'+'&#160;'*(2*len(m[0]))+'</u>',escape(node))
    tag,attrs,children=node
    style=attrs.get('style','').lower()
    underline=tag=='u' or ('text-decoration' in style and 'underline' in style)
    content=''.join(inline(child,underlined or underline) for child in children)
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


def flowables(html,width):
    if len(html)>100000:raise ValueError('单题富文本过长')
    parser=Parser();parser.feed(html)
    style=ParagraphStyle('answer',fontName=FONT,fontSize=9,leading=13,wordWrap='CJK')
    def paragraph(content):return Paragraph(content or ' ',style)
    def visit(node):
        if isinstance(node,str):return [paragraph(inline(node))] if node.strip() else []
        tag,attrs,children=node
        if tag=='table':
            rows=[]
            def collect(n):
                if isinstance(n,str):return
                if n[0]=='tr':rows.append([paragraph(inline(cell)) for cell in n[2] if not isinstance(cell,str) and cell[0] in ('td','th')])
                else:
                    for child in n[2]:collect(child)
            collect(node);rows=[r for r in rows if r]
            if not rows:return []
            columns=max(map(len,rows))
            if columns>30 or len(rows)>100:raise ValueError('表格过大')
            table=Table([row+['']*(columns-len(row)) for row in rows],colWidths=[width/columns]*columns)
            table.setStyle(TableStyle([('GRID',(0,0),(-1,-1),.4,'#555555'),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4)]))
            return [table,Spacer(1,3)]
        if tag in ('p','h1','h2','h3','li'):
            return [paragraph(('- ' if tag=='li' else '')+inline(node)),Spacer(1,3)]
        if any(not isinstance(c,str) and c[0] in ('p','div','table','ul','ol','h1','h2','h3') for c in children):return [f for child in children for f in visit(child)]
        return [paragraph(inline(node))] if inline(node).strip() else []
    return visit(parser.root)


def layout(html,width,height,canvas=None,x=0,top=0):
    used=0
    for flow in flowables(html,width):
        _,needed=flow.wrap(width,max(0,height-used))
        if used+needed>height+.01:raise ValueError('富文本超过答题区域，请扩大区域或精简内容')
        if canvas is not None:flow.drawOn(canvas,x,top-used-needed)
        used+=needed
    return used
