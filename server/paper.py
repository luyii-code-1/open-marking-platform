import io
import math
import cv2
import zxingcpp
import numpy as np
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.utils import ImageReader
from . import db as database
from .richtext import layout as rich_layout

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
pdfmetrics.registerFontFamily('STSong-Light',normal='STSong-Light',bold='STSong-Light',italic='STSong-Light',boldItalic='STSong-Light')
ABSENT_X,ABSENT_Y=124,45


def dimensions(template):
    return (420,297) if template['paper']=='A3' else (210,297)


def code(template,side):
    return f"OMP1:{template['id']}:{template['revision']}:{side}"


def validate(template):
    w,h=dimensions(template)
    if not isinstance(template.get('candidate_length',8),int) or not 1<=template.get('candidate_length',8)<=20: raise ValueError('准考证号长度应为1至20位')
    occupied=[]
    for question in template.get('questions',[]):
        for region in question.get('regions',[]):
            if not all(isinstance(region[k],(int,float)) and math.isfinite(region[k]) for k in ('x','y','width','height')): raise ValueError('答题区坐标无效')
            if not 1<=int(region['page'])<=template['sides']:
                raise ValueError('答题区页码超出题卡范围')
            if min(region['x'],region['y'])<0 or min(region['width'],region['height'])<=0 or region['x']+region['width']>w-8 or region['y']+region['height']>h-8:
                raise ValueError('答题区超出纸张有效范围')
            if region['y']<100:
                raise ValueError('请将答题区放在100毫米以下，保留标题及考号区域')
            if question['type']!='subjective' and (region['width']<12+question.get('options',4)*6 or region['height']<14): raise ValueError('客观题区域不足以容纳选项')
            for previous in occupied:
                if previous['page']==region['page'] and region['x']<previous['x']+previous['width'] and previous['x']<region['x']+region['width'] and region['y']<previous['y']+previous['height'] and previous['y']<region['y']+region['height']: raise ValueError('答题区域重叠')
            occupied.append(region)
            if question.get('content_html'):
                image_height=min(region['height']-12,question.get('image_height',25)) if question.get('image_asset_id') else 0
                rich_layout(question['content_html'],(region['width']-6)*mm,(region['height']-12-image_height)*mm)
        if question['type']!='subjective':
            count=int(question.get('options',4))
            if count not in (3,4,5) or not set(question.get('answer',[]))<=set('ABCDE'[:count]):
                raise ValueError('选项或标准答案无效')


def bubbles(question,region):
    count=int(question.get('options',4))
    spacing=min(12,(region['width']-12)/count)
    return [(chr(65+i),region['x']+12+i*spacing,region['y']+7) for i in range(count)]


def pdf(template):
    validate(template)
    output=io.BytesIO()
    w,h=dimensions(template)
    c=canvas.Canvas(output,pagesize=(w*mm,h*mm))
    for page in range(1,template['sides']+1):
        side='front' if page==1 else 'back'
        background_id=template.get('background_assets',{}).get(str(page)) or (template.get('background_asset_id') if page==1 else None)
        if background_id:
            from .storage import materialize
            try:background=materialize('assets/'+background_id+'.png')
            except FileNotFoundError:raise ValueError('题卡底图不存在')
            if not background.exists():raise ValueError('题卡底图不存在')
            c.drawImage(str(background),0,0,width=w*mm,height=h*mm)
            c.setFillColorRGB(1,1,1);c.rect(0,(h-100)*mm,w*mm,100*mm,fill=1,stroke=0);c.setFillColorRGB(0,0,0)
        c.setFont('STSong-Light',16)
        c.drawString(15*mm,(h-20)*mm,template['name'])
        if template.get('subtitle'):
            c.setFont('STSong-Light',10);c.drawString(15*mm,(h-25)*mm,template['subtitle'])
        c.setFont('STSong-Light',9)
        c.drawString(15*mm,(h-29)*mm,f"第{page}面 · 请按100%实际大小打印 · 不要裁去定位标记")
        widget=qr.QrCodeWidget(code(template,side)); x0,y0,x1,y1=widget.getBounds()
        drawing=Drawing(26*mm,26*mm,transform=[26*mm/(x1-x0),0,0,26*mm/(y1-y0),0,0]); drawing.add(widget)
        renderPDF.draw(drawing,c,(w-42)*mm,(h-36)*mm)
        for x,y in ((7,7),(w-7,7),(7,h-7),(w-7,h-7)):
            c.rect((x-2)*mm,(h-y-2)*mm,4*mm,4*mm,fill=1,stroke=0)
        if page==1:
            c.drawString(15*mm,(h-39)*mm,'姓名：____________  班级：____________  考场：____________')
            if template.get('layout_version',1)>=2:
                c.drawString(15*mm,(h-46)*mm,'准考证号：')
                c.drawString(104*mm,(h-46)*mm,'缺考标记：')
                c.rect((ABSENT_X-2)*mm,(h-ABSENT_Y-1.5)*mm,4*mm,3*mm)
                c.drawString(130*mm,(h-46)*mm,'（监考填涂）')
            else:c.drawString(15*mm,(h-46)*mm,'准考证号：                       缺考标记：□（由监考教师填写）')
            for column in range(int(template.get('candidate_length',8))):
                x=18+column*6
                c.rect((x-2)*mm,(h-54)*mm,4*mm,5*mm)
                for digit in range(10):
                    y=57+digit*3.5
                    c.rect((x-1.6)*mm,(h-y-1.2)*mm,3.2*mm,2.4*mm)
                    c.setFont('Helvetica',5); c.drawCentredString(x*mm,(h-y-.6)*mm,str(digit))
        for question in template.get('questions',[]):
            for region in question['regions']:
                if int(region['page'])!=page: continue
                x,y,rw,rh=(region[k] for k in ('x','y','width','height'))
                c.setFont('STSong-Light',9)
                if question['type']!='subjective':
                    c.setFillColorRGB(1,1,1);c.rect(x*mm,(h-y-rh)*mm,rw*mm,rh*mm,fill=1,stroke=0);c.setFillColorRGB(0,0,0)
                c.rect(x*mm,(h-y-rh)*mm,rw*mm,rh*mm)
                c.drawString((x+2)*mm,(h-y-5)*mm,str(question['number']))
                if question['type']!='subjective':
                    for label,bx,by in bubbles(question,region):
                        c.rect((bx-2)*mm,(h-by-1.5)*mm,4*mm,3*mm)
                        c.setFont('Helvetica',6); c.drawCentredString(bx*mm,(h-by-.8)*mm,label)
                else:
                    c.setStrokeColorRGB(.7,.7,.7)
                    style=question.get('style','none' if background_id else 'line')
                    if style=='line':
                        lines=int(question.get('lines',max(1,int((rh-14)/8))))
                        if not 1<=lines<=100:raise ValueError('横线行数应为1至100')
                        for ly in np.linspace(y+12,y+rh-3,lines):c.line((x+3)*mm,(h-ly)*mm,(x+rw-3)*mm,(h-ly)*mm)
                    elif style=='grid':
                        cell=float(question.get('cell_size',8))
                        if not 4<=cell<=20:raise ValueError('作文格大小应为4至20毫米')
                        cols=int((rw-6)/cell);rows=int((rh-12)/cell)
                        for row in range(rows):
                            for col in range(cols):c.rect((x+3+col*cell)*mm,(h-y-10-(row+1)*cell)*mm,cell*mm,cell*mm)
                    c.setStrokeColorRGB(0,0,0)
                    image_height=min(rh-12,question.get('image_height',25)) if question.get('image_asset_id') else 0
                    if question.get('content_html'):rich_layout(question['content_html'],(rw-6)*mm,(rh-12-image_height)*mm,c,(x+3)*mm,(h-y-9)*mm)
                    if question.get('image_asset_id'):
                        from .storage import materialize
                        try:asset=materialize('assets/'+question['image_asset_id']+'.png')
                        except FileNotFoundError:raise ValueError('题卡插图不存在')
                        c.drawImage(str(asset),(x+3)*mm,(h-y-rh+3)*mm,width=(rw-6)*mm,height=min(rh-12,question.get('image_height',25))*mm,preserveAspectRatio=True,anchor='c',mask='auto')
        c.showPage()
    c.save()
    return output.getvalue()


def decode(data):
    array=np.frombuffer(data,dtype=np.uint8)
    image=cv2.imdecode(array,cv2.IMREAD_GRAYSCALE)
    if image is None or image.size>40_000_000:raise ValueError('图片无效或像素超过4000万')
    barcodes=zxingcpp.read_barcodes(image,formats=zxingcpp.BarcodeFormat.QRCode)
    native={b.text:b for b in barcodes if b.text.startswith('OMP1:')}
    if len(native)>1:return image,'OMP1:AMBIGUOUS'
    if native:
        selected=next(iter(native.values()))
        turns=round(selected.orientation/90)
        return (np.ascontiguousarray(np.rot90(image,turns)) if turns else image),selected.text
    detector=cv2.QRCodeDetector();value,points,_=detector.detectAndDecode(image)
    if not value:
        for scale in (.75,1.5):
            scale=min(scale,3500/max(image.shape))
            probe=cv2.resize(image,None,fx=scale,fy=scale,interpolation=cv2.INTER_CUBIC)
            value,points,_=detector.detectAndDecode(probe)
            if value:break
    if value and points is not None:
        direction=points[0][1]-points[0][0]
        turns=round(math.atan2(float(direction[1]),float(direction[0]))/(math.pi/2))
        return (np.ascontiguousarray(np.rot90(image,turns)) if turns else image),value
    if barcodes:
        selected=barcodes[0];turns=round(selected.orientation/90)
        return (np.ascontiguousarray(np.rot90(image,turns)) if turns else image),selected.text
    return image,''


def align(image,template):
    width,height=dimensions(template)
    _,binary=cv2.threshold(image,90,255,cv2.THRESH_BINARY_INV)
    contours,_=cv2.findContours(binary,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    ih,iw=image.shape
    candidates=[]
    for contour in contours:
        x,y,w,h=cv2.boundingRect(contour)
        if .65<w/max(h,1)<1.5 and 2.5<w*width/iw<6.5 and 2.5<h*height/ih<6.5 and cv2.contourArea(contour)/(w*h)>.75:
            candidates.append([x+w/2,y+h/2])
    if len(candidates)<4: raise ValueError('无法定位四角标记')
    points=np.array(candidates,dtype=np.float32)
    corners=np.array([[0,0],[iw,0],[iw,ih],[0,ih]],dtype=np.float32)
    chosen=np.array([points[np.argmin(np.linalg.norm((points-corner)/[iw,ih],axis=1))] for corner in corners])
    if len(np.unique(chosen,axis=0))!=4: raise ValueError('四角标记不完整')
    expected=np.array([[7,7],[width-7,7],[width-7,height-7],[7,height-7]],dtype=np.float32)
    if np.max(np.abs(chosen/[iw/width,ih/height]-expected))>8:raise ValueError('四角标记位置异常，需要人工定位')
    target=np.array([[7,7],[width-7,7],[width-7,height-7],[7,height-7]],dtype=np.float32)*4
    transform=cv2.getPerspectiveTransform(chosen,target)
    return cv2.warpPerspective(image,transform,(width*4,height*4),borderValue=255)


def manual_align(image,template,corners):
    if not isinstance(corners,list) or len(corners)!=4:raise ValueError('请按左上、右上、右下、左下顺序选择四点')
    ih,iw=image.shape
    try:points=np.array([[p['x'],p['y']] for p in corners],dtype=np.float32)
    except (KeyError,TypeError,ValueError):raise ValueError('定位点无效')
    if points.shape!=(4,2) or not np.isfinite(points).all() or (points<0).any() or (points[:,0]>=iw).any() or (points[:,1]>=ih).any():raise ValueError('定位点超出原图')
    contour=points.reshape(4,1,2)
    if not cv2.isContourConvex(contour) or cv2.contourArea(contour,oriented=True)<iw*ih*.15:raise ValueError('定位点顺序或范围无效，请依次选择四个定位方块中心')
    width,height=dimensions(template)
    target=np.array([[7,7],[width-7,7],[width-7,height-7],[7,height-7]],dtype=np.float32)*4
    transform=cv2.getPerspectiveTransform(points,target)
    if not np.isfinite(transform).all():raise ValueError('无法计算校正位置')
    return cv2.warpPerspective(image,transform,(width*4,height*4),borderValue=255)


def absent_mark(normalized,side,template=None):
    if side!='front':return False
    if template is not None and template.get('layout_version',1)<2:return False
    crop=normalized[round((ABSENT_Y-.75)*4):round((ABSENT_Y+.75)*4),round((ABSENT_X-1.1)*4):round((ABSENT_X+1.1)*4)]
    return bool(crop.size and np.mean(crop<135)>.45)


def recognize(image,template,side,corners=None):
    normalized=manual_align(image,template,corners) if corners is not None else align(image,template)
    def ink(x,y):
        crop=normalized[round((y-.75)*4):round((y+.75)*4),round((x-1.1)*4):round((x+1.1)*4)]
        return float(np.mean(crop<135)) if crop.size else 0
    candidate=None
    if side=='front':
        digits=[]
        for column in range(int(template.get('candidate_length',8))):
            marked=[str(d) for d in range(10) if ink(18+column*6,57+d*3.5)>.45]
            digits.append(marked[0] if len(marked)==1 else '?')
        candidate=''.join(digits)
    selections={}
    for question in template.get('questions',[]):
        if question['type']=='subjective': continue
        for region in question['regions']:
            if int(region['page'])==(1 if side=='front' else 2):
                selections[question['id']]=[label for label,x,y in bubbles(question,region) if ink(x,y)>.45]
    return normalized,candidate,selections
