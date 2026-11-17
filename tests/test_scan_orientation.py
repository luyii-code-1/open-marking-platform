import cv2
import numpy as np
import pytest
from server.omr import align,recognize


@pytest.mark.parametrize("turns",[0,1,2,3])
@pytest.mark.parametrize("side",["front","back"])
@pytest.mark.parametrize("paper,width",[("A4",210),("A3",420)])
def test_scan_direction_and_number(turns,side,paper,width):
    page=np.full((1188,width*4),255,np.uint8)
    for x in [28,(width-7)*4]:
        for y in [28,1160]:
            cv2.rectangle(page,(x-8,y-8),(x+8,y+8),0,-1)
    for i,gray in enumerate([255,192,128,64,0]):
        x=(width-44+i*5)*4
        page[24:30,x:x+16]=gray
    for c,d in enumerate([0,1,2]):
        x=(18+c*6)*4;y=int((57+d*3.5)*4)
        page[y-4:y+5,x-6:x+7]=0
    template={'layout_version':3,'paper':paper,'candidate_length':3,'questions':[]}
    # A print shrunk to fit, placed off-centre and slightly skewed on a flatbed.
    transform=np.float32([[.92,-.009,51],[.009,.92,48],[.000002,0,1]])
    skewed=cv2.warpPerspective(page,transform,(width*4,1188),borderValue=255)
    result,number,_=recognize(np.ascontiguousarray(np.rot90(skewed,turns)),template,side)
    assert number==('012' if side=='front' else None)
    assert result.shape==page.shape
    assert np.median(result[25:29,(width-23)*4:(width-21)*4])<60


@pytest.mark.parametrize("damage",["missing","inconsistent","ambiguous"])
def test_registration_rejects_incomplete_or_conflicting_frames(damage):
    page=np.full((1188,840),255,np.uint8)
    marks=[(75,76),(795,83),(785,1126),(65,1119)]
    if damage=="missing":marks.pop()
    elif damage=="inconsistent":marks[-1]=(130,1080)
    else:marks += [(x+8,y+20) for x,y in marks]
    for x,y in marks:cv2.rectangle(page,(x-7,y-7),(x+7,y+7),0,-1)
    with pytest.raises(ValueError,match='四角'):
        align(page,{'paper':'A4'})
