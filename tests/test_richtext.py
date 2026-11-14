import io
import pytest
from reportlab.pdfgen.canvas import Canvas
from server import paper
from server.richtext import flowables,layout


def test_word_style_and_table_pdf_layout():
    html='<p><span style="font-weight:700">题目标题</span>与<em>说明</em>，x<sup>2</sup></p><table><tbody><tr><th>项目</th><th>数值</th></tr><tr><td>A</td><td>10</td></tr></tbody></table>'
    output=io.BytesIO();canvas=Canvas(output)
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
