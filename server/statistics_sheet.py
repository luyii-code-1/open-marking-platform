"""Shared geometry for anonymous optical response cards."""
from string import ascii_uppercase

CAPABILITY = 'statistics-sheet-1'
ENGINE_VERSION = 'omp-statistics-1'
PER_LINE = 13
STEP_X = 13.5
STEP_Y = 7


def enabled(template):
    return bool(template.get('statistics_sheet'))


def bubbles(question, region):
    return [(letter, region['x'] + 9 + i % PER_LINE * STEP_X, region['y'] + 10 + i // PER_LINE * STEP_Y)
            for i, letter in enumerate(ascii_uppercase[:question['options']])]


def layout(questions):
    """Fit one anonymous card on at most two sides of A4."""
    output = []
    page, top = 1, 43
    for question in questions:
        height = 15 + STEP_Y * ((question['options'] - 1) // PER_LINE)
        if top + height > 283:
            page, top = page + 1, 43
        if page > 2:
            raise ValueError('题目超过一张双面 A4 题卡容量，请减少题目或选项')
        output.append({**question, 'regions': [{'page': page, 'x': 14, 'y': top, 'width': 183, 'height': height}]})
        top += height
    return output, page


def pdf(template, only_page=None):
    import io
    from reportlab.graphics import renderPDF
    from reportlab.graphics.barcode import qr
    from reportlab.graphics.shapes import Drawing
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfgen.canvas import Canvas
    from .omr import code
    from .paper_fonts import FONT

    width, height = 210, 297
    output = io.BytesIO()
    canvas = Canvas(output, pagesize=(width * mm, height * mm))
    pages = [only_page] if only_page is not None else range(1, template['sides'] + 1)
    for page in pages:
        for x, y in ((7, 7), (203, 7), (7, 290), (203, 290)):
            canvas.rect((x - 2) * mm, (height - y - 2) * mm, 4 * mm, 4 * mm, fill=1, stroke=0)
        widget = qr.QrCodeWidget(code(template, 'front' if page == 1 else 'back'))
        x0, y0, x1, y1 = widget.getBounds()
        span = 23 * mm
        symbol = Drawing(span, span, transform=[span / (x1-x0), 0, 0, span / (y1-y0), 0, 0])
        symbol.add(widget)
        renderPDF.draw(symbol, canvas, 170 * mm, (height - 36) * mm)
        title = template['name']
        size = min(16, 16 * 143 * mm / max(1, pdfmetrics.stringWidth(title, FONT, 16)))
        canvas.setFont(FONT, size)
        canvas.drawString(14 * mm, (height - 18) * mm, title)
        canvas.setFont(FONT, 9)
        canvas.drawString(14 * mm, (height - 27) * mm, f'第 {page} 面 / 共 {template["sides"]} 面')
        canvas.drawString(14 * mm, (height - 34) * mm, '按实际尺寸打印。请用深色笔涂满圆圈。')
        if template.get('status') == 'draft':
            canvas.drawString(75 * mm, (height - 27) * mm, '草稿 · 仅用于排版审阅')
        canvas.setLineWidth(.18 * mm)
        for question in template['questions']:
            region = question['regions'][0]
            if region['page'] != page:
                continue
            label = f'{question["number"]}. {"单选" if question["type"] == "single" else "多选"}  {question["title"]}'
            size = min(10, 10 * 181 * mm / max(1, pdfmetrics.stringWidth(label, FONT, 10)))
            canvas.setFont(FONT, size)
            canvas.drawString(region['x'] * mm, (height-region['y']-4) * mm, label)
            canvas.setFont('Helvetica', 8)
            for letter, x, y in bubbles(question, region):
                canvas.drawRightString((x-2.6)*mm, (height-y-.8)*mm, letter)
                canvas.circle(x*mm, (height-y)*mm, 1.65*mm, stroke=1, fill=0)
        canvas.showPage()
    canvas.save()
    return output.getvalue()
