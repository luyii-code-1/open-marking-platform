"""Shared image recognition used by server recovery and the desktop worker."""
import math
import cv2
import numpy as np
import zxingcpp

ABSENT_X, ABSENT_Y = 124, 45
ENGINE_VERSION = "omp-omr-3"


def manual_binding(template):
    return template.get('layout_version', 2) >= 3


def panels(template):
    return template.get('sheet_columns', 2 if template['paper']=='A3' else 1) if manual_binding(template) else 1


def absent_position(template=None):
    if template and manual_binding(template):
        from . import sheet_notices
        if sheet_notices.enabled(template) and template.get('notice_layout',1)==2:
            left,width=sheet_notices.geometry(template)
            return left+width*.275,88
        width,_=dimensions(template)
        return min(124, (width-24-(panels(template)-1)*8)/panels(template)-8),45
    return ABSENT_X,ABSENT_Y


def dimensions(template):
    return (420,297) if template['paper']=='A3' else (210,297)


def code(template,side):
    return f"OMP1:{template['id']}:{template['revision']}:{side}"


def bubbles(question,region):
    count=int(question.get('options',4))
    if question.get('choice_style')=='compact':return [(chr(65+i),region['x']+9+i*5,region['y']+2.4) for i in range(count)]
    if question.get('choice_style')=='bracket':return [(chr(65+i),region['x']+14+i*9.5,region['y']+3) for i in range(count)]
    spacing=min(12,(region['width']-12)/count)
    return [(chr(65+i),region['x']+12+i*spacing,region['y']+7) for i in range(count)]


def decode(data,template=None):
    array=np.frombuffer(data,dtype=np.uint8)
    image=cv2.imdecode(array,cv2.IMREAD_GRAYSCALE)
    if image is None or image.size>40_000_000:raise ValueError('图片无效或像素超过4000万')
    if template and manual_binding(template):
        width,height=dimensions(template)
        if (image.shape[1]>image.shape[0]) != (width>height):image=cv2.rotate(image,cv2.ROTATE_90_CLOCKWISE)
        return image,''
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
    x,y=absent_position(template)
    crop=normalized[round((y-.75)*4):round((y+.75)*4),round((x-1.1)*4):round((x+1.1)*4)]
    return bool(crop.size and np.mean(crop<135)>.45)


def recognize(image,template,side,corners=None):
    normalized=manual_align(image,template,corners) if corners is not None else align(image,template)
    calibrated=135
    if any(q.get('choice_style') in ('bracket','compact') for q in template.get('questions',[])):
        width,height=dimensions(template)
        samples=[]
        if manual_binding(template):samples.append([float(np.median(normalized[25:29,round((width-43+i*5)*4):round((width-41+i*5)*4)])) for i in range(5)])
        samples.append([float(np.median(normalized[round((height-33)*4):round((height-30)*4),round((63+i*8)*4):round((67+i*8)*4)])) for i in range(5)])
        for levels in samples:
            if levels[0]-levels[4]>60 and all(a>=b-12 for a,b in zip(levels,levels[1:])):
                calibrated=(levels[0]+levels[1])/2;break
    def ink(x,y,style=None):
        radius=2.6 if style=='bracket' else 1.5 if style=='compact' else 1.1
        crop=normalized[round((y-.75)*4):round((y+.75)*4),round((x-radius)*4):round((x+radius)*4)]
        return float(np.mean(crop<(calibrated if style else 135))) if crop.size else 0
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
                selections[question['id']]=[label for label,x,y in bubbles(question,region) if ink(x,y,question.get('choice_style'))>.45]
    return normalized,candidate,selections

