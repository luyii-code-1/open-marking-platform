import cv2
import numpy as np
import pytest
from server.omr import orient_scan,recognize


@pytest.mark.parametrize("turns",[0,1,2,3])
def test_scan_direction_and_number(turns):
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
    oriented=orient_scan(np.ascontiguousarray(np.rot90(page,turns)),template,'front')
    assert recognize(oriented,template,'front')[1]=='012'
