from pathlib import Path
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

FONT = 'OMP-Paper'
pdfmetrics.registerFont(TTFont(FONT, str(Path(__file__).parent / 'fonts/OMPPaperSans-Regular.ttf')))
pdfmetrics.registerFontFamily(FONT, normal=FONT, bold=FONT, italic=FONT, boldItalic=FONT)
