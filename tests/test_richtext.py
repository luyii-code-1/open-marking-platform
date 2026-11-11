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
