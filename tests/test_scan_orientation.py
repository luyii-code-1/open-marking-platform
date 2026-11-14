import cv2
import numpy as np
import pytest
from server.omr import recognize


@pytest.mark.parametrize("turns",[0,1,2,3])
@pytest.mark.parametrize("side",["front","back"])
def test_scan_direction_and_number(turns,side):
    page=np.full((1188,840),255,np.uint8)
    for x in [28,812]:
        for y in [28,1160]:
            cv2.rectangle(page,(x-8,y-8),(x+8,y+8),0,-1)
    for i,gray in enumerate([255,192,128,64,0]):
        x=(210-44+i*5)*4
        page[24:30,x:x+16]=gray
    for c,d in enumerate([0,1,2]):
        x=(18+c*6)*4;y=int((57+d*3.5)*4)
        page[y-4:y+5,x-6:x+7]=0
    template={'layout_version':3,'paper':'A4','candidate_length':3,'questions':[]}
    transform=np.float32([[1,.009,0],[.005,1,-2],[.000006,0,1]])
    skewed=cv2.warpPerspective(page,transform,(840,1188),borderValue=255)
    result,number,_=recognize(np.ascontiguousarray(np.rot90(skewed,turns)),template,side)
    assert number==('012' if side=='front' else None)
    assert result.shape==page.shape
    assert np.median(result[25:29,(210-23)*4:(210-21)*4])<60
