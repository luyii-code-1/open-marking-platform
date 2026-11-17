import io
import pytest
from reportlab.pdfgen.canvas import Canvas
from server import paper
from server.richtext import PaperCanvas,EnclosedText,flowables,layout


def test_word_style_and_table_pdf_layout():
    html='<p><span style="font-weight:700">题目标题</span>与<em>说明</em>，x<sup>2</sup></p><table><tbody><tr><th>项目</th><th>数值</th></tr><tr><td>A</td><td>10</td></tr></tbody></table>'
    output=io.BytesIO();canvas=PaperCanvas(output)
    height=layout(html,300,200,canvas,30,700)
    canvas.save()
    assert 20<height<200 and output.getvalue().startswith(b'%PDF')
    clean=flowables('<script>hidden</script><p><a href="file:///secret">visible</a><img src="http://localhost/private"></p>',300)
    assert clean[0].getPlainText()=='visible'
    with pytest.raises(ValueError,match='超过答题区域'):layout('<p>很长的内容</p>'*100,100,30)


def test_grid_image_background_and_overflow(tmp_path,monkeypatch):
    from PIL import Image
    from server import db
    monkeypatch.setattr(db,'ROOT',tmp_path)
    directory=tmp_path/'assets';directory.mkdir()
    Image.new('RGB',(300,400),'white').save(directory/'background.png')
    Image.new('RGB',(100,80),'blue').save(directory/'figure.png')
    question={'id':'question','number':1,'type':'subjective','points':10,'style':'grid','cell_size':8,'content_html':'<p>中文说明与<b>加粗</b></p>','image_asset_id':'figure','image_height':15,'regions':[{'page':1,'x':15,'y':110,'width':160,'height':100}]}
    template={'id':'template','revision':1,'paper':'A4','sides':1,'name':'中文题卡','subtitle':'副标题','candidate_length':8,'background_assets':{'1':'background'},'questions':[question]}
    assert paper.pdf(template).startswith(b'%PDF')
    question['content_html']='<p>内容</p>'*100
    with pytest.raises(ValueError,match='超过答题区域'):paper.validate(template)


@pytest.mark.parametrize('short',[
    '<span data-answer-line="15">&nbsp;</span>',
    '<u>'+'&nbsp;'*21+'</u>',
    '__________',
])
def test_inline_answer_lines_keep_ink_separate_from_prompt(short):
    from reportlab.lib.units import mm
    sample='1.句子'+short+'有问题，修改：<span data-answer-line="60">&nbsp;</span><div>下一行</div>'
    canvas=Canvas(io.BytesIO())
    boxes=[];underlines=[]
    canvas.drawImage=lambda image,x,y,w,h,**opts:boxes.append((x,y,w,h))
    canvas.line=lambda *xy:underlines.append(xy)
    layout(sample,125*mm,100*mm,canvas)
    assert len(boxes)==2 and not underlines
    first,second=boxes
    assert first[0]>0 and second[0]>first[0]+first[2]
    assert first[1]==second[1] and second[2]==pytest.approx(60*mm,abs=.001)
    boxes.clear()
    layout(sample,70*mm,100*mm,canvas)
    assert len(boxes)==2 and boxes[1][0]==0 and boxes[1][2]==pytest.approx(60*mm,abs=.001)
    layout('<p>普通<u>强调</u>普通</p>',70*mm,100*mm,canvas)
    assert len(underlines)==1 and underlines[0][0]>0


@pytest.mark.parametrize('width',[90,240])
def test_fill_to_end_uses_remaining_print_width(width):
    rule='<span data-answer-line="end">&nbsp;</span>'
    canvas=Canvas(io.BytesIO())
    ink=[]
    canvas.drawImage=lambda image,x,y,w,h,**opts:ink.append((x,y,w))
    prompt='请根据前面的题干作答，<b>修改：</b>'
    layout(prompt+rule+'下一行：'+rule,width,100,canvas)
    assert len(ink)==2
    assert ink[0][1]>ink[1][1]
    for x,_,w in ink:
        assert x>0 and w>0
        assert x+w==pytest.approx(width)
    ink.clear()
    layout(rule+'<br/>'+rule,width,100,canvas)
    assert len(ink)==2 and ink[0][1]-ink[1][1]==pytest.approx(13)
    assert all(x==0 and w==pytest.approx(width) for x,_,w in ink)


def test_individual_line_leading_and_vector_rules():
    from server.richtext import PaperCanvas
    html='<div data-line-leading="24">(1)<span data-answer-line="15"></span></div><div data-line-leading="36">(2)<span data-answer-line="30"></span></div>'
    output=io.BytesIO()
    canvas=PaperCanvas(output,pageCompression=0)
    assert layout(html,300,100,canvas,10,90,font_size=13,leading=20)==60
    canvas.save()
    data=output.getvalue()
    assert b'/Subtype /Image' not in data and data.count(b' re f')==2
    with pytest.raises(ValueError):
        layout(html.replace('"24"','"3"'),300,100,font_size=13)


def test_font_family_size_colors_and_character_styles():
    html='<p><span style="font-family:OMP Serif;font-size:18pt;color:#123456;background-color:#def;font-weight:700;font-style:italic;text-decoration:underline line-through">中文 Abc</span> x<sup>2</sup> H<sub>2</sub>O</p>'
    paragraph=flowables(html,300)[0]
    styled=next(f for f in paragraph.frags if '中文' in getattr(f,'text',''))
    assert styled.fontName=='OMP-Paper-Serif-BoldItalic' and styled.fontSize==18
    assert styled.textColor.hexval()=='0x123456' and styled.backColor.hexval()=='0xddeeff'
    assert len(styled.us_lines)==2
    shifts=[f.rise for f in paragraph.frags]
    assert max(shifts)>0 and min(shifts)<0
    assert layout(html,300,1000)>18


def test_paragraph_spacing_indents_and_measurement_height():
    html='<p data-line-leading="30" style="text-align:right;margin-left:24pt;margin-right:12pt;text-indent:-12pt;margin-top:6pt;margin-bottom:9pt">段落设置</p>'
    flows=flowables(html,300)
    paragraph=flows[1]
    assert paragraph.style.leftIndent==24 and paragraph.style.rightIndent==12
    assert paragraph.style.firstLineIndent==-12 and paragraph.style.alignment==2
    assert layout(html,300,1000000)==45
    assert layout(html,300,45)==45
    with pytest.raises(ValueError,match='超过答题区域'):layout(html,300,44)
    nested='<div style="margin-left:20pt;margin-right:10pt;margin-top:4pt;margin-bottom:5pt;text-align:center"><p data-line-leading="20">第一段</p><p data-line-leading="20">第二段</p></div>'
    assert layout(nested,300,1000000)==55


def test_numbered_lists_bullets_and_equal_width_table():
    from reportlab.platypus import Paragraph,Table
    paragraphs=[f for f in flowables('<ol start="3" type="A"><li>甲</li><li>乙</li></ol><ul style="list-style-type:square"><li>丙</li></ul>',300) if isinstance(f,Paragraph)]
    assert [p.bulletText for p in paragraphs]==['C.','D.','▪']
    nested=flowables('<ol start="9" type="i"><li><p>项目</p><ul><li>子项目</li></ul></li></ol>',300)
    assert nested and layout('<ol start="9" type="i"><li><p>项目</p><ul><li>子项目</li></ul></li></ol>',300,1000000)>26
    table=next(f for f in flowables('<table><tr><th>栏目</th><th>内容</th></tr><tr><td><p>文字</p></td><td>数值 10</td></tr></table>',300) if isinstance(f,Table))
    assert table._argW==[150,150]
    with pytest.raises(ValueError,match='等宽单元格'):flowables('<table><tr><td colspan="2">合并</td></tr></table>',300)


def test_enclosed_text_is_indivisible_vector_and_keeps_source_text():
    html='<p>圈选<span data-enclosed-text="甲乙" contenteditable="false" style="font-family:OMP Serif;font-size:18pt;color:#f00">甲乙</span>之后</p>'
    paragraph=flowables(html,300)[0]
    circled=next(f.cbDefn for f in paragraph.frags if isinstance(getattr(getattr(f,'cbDefn',None),'image',None),EnclosedText))
    assert circled.image.text=='甲乙' and circled.image.font=='OMP-Paper-Serif'
    assert circled.image.color.hexval()=='0xff0000'
    output=io.BytesIO();canvas=PaperCanvas(output,pageCompression=0);drawn=[]
    original=canvas.drawCentredString
    def draw_text(x,y,text,*args,**kwargs):
        drawn.append(text);return original(x,y,text,*args,**kwargs)
    canvas.drawCentredString=draw_text
    layout(html,300,100,canvas,20,700);canvas.save()
    assert drawn==['甲乙']
    data=output.getvalue()
    assert b'/Subtype /Image' not in data and b' c\n' in data
    with pytest.raises(ValueError,match='带圈文字超过'):layout(html,20,100)


@pytest.mark.parametrize('html',[
    '<span style="font-size:5pt">文字</span>',
    '<span style="font-size:37pt">文字</span>',
    '<span style="color:red">文字</span>',
    '<span style="background-color:url(secret)">文字</span>',
    '<p style="margin-left:145pt">文字</p>',
    '<p style="text-indent:-73pt">文字</p>',
    '<p style="text-indent:-12pt">文字</p>',
    '<p style="margin-top:73pt">文字</p>',
    '<p data-line-leading="73">文字</p>',
    '<span data-enclosed-text="一二三四五六七八九">一二三四五六七八九</span>',
])
def test_invalid_word_style_values_are_rejected(html):
    with pytest.raises(ValueError):layout(html,300,1000)
