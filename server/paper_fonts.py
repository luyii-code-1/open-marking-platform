from pathlib import Path
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from fastapi import APIRouter,HTTPException
from fastapi.responses import FileResponse

FONT = 'OMP-Paper'
pdfmetrics.registerFont(TTFont(FONT, str(Path(__file__).parent / 'fonts/OMPPaperSans-Regular.ttf')))
DIRECTORY=Path(__file__).parent/'fonts'
FAMILIES={'OMP Sans':FONT,'OMP Serif':'OMP-Paper-Serif'}
for family,regular in FAMILIES.items():
    label='Sans' if family=='OMP Sans' else 'Serif'
    if regular!=FONT:pdfmetrics.registerFont(TTFont(regular,str(DIRECTORY/f'OMPPaper{label}-Regular.ttf')))
    bold=regular+'-Bold'
    pdfmetrics.registerFont(TTFont(bold,str(DIRECTORY/f'OMPPaper{label}-Bold.ttf')))
    italic=regular+'-Italic';bold_italic=regular+'-BoldItalic'
    pdfmetrics.registerFont(TTFont(italic,str(DIRECTORY/f'OMPPaper{label}-Italic.ttf')))
    pdfmetrics.registerFont(TTFont(bold_italic,str(DIRECTORY/f'OMPPaper{label}-BoldItalic.ttf')))
    pdfmetrics.registerFontFamily(regular,normal=regular,bold=bold,italic=italic,boldItalic=bold_italic)

def font_name(family):
    value=str(family or '').strip().strip('\"\'').split(',')[0].strip().strip('\"\'').lower()
    return FAMILIES['OMP Serif'] if value in ('omp serif','serif','times new roman','times','simsun','宋体','仿宋') else FONT

router=APIRouter(prefix='/api/v1/paper-fonts')
@router.get('/{family}/{weight}')
def paper_font(family:str,weight:int,italic:bool=False):
    if family not in ('sans','serif') or weight not in (400,700):raise HTTPException(404,'字体不存在')
    style=('Italic' if weight==400 else 'BoldItalic') if italic else ('Regular' if weight==400 else 'Bold')
    path=DIRECTORY/f'OMPPaper{family.title()}-{style}.ttf'
    return FileResponse(path,media_type='font/ttf',headers={'Cache-Control':'public, max-age=86400'})
