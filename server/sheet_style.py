"""Print conventions for current editable answer sheets."""
STANDARD = 'standard-v2'
FOOTER = '请在各题目的答题区域内作答，超出黑色矩形边框限定区域的答案无效'


def enabled(template):
    return template.get('print_style') == STANDARD and template.get('layout_version', 2) >= 3


def defaults(template):
    template.setdefault('print_style', STANDARD)
    template.setdefault('notice_layout', 2)
    template.setdefault('candidate_length', 9)
    template.setdefault('forbidden_regions', [])


def header_geometry(template):
    count = template.get('candidate_length', 9)
    right = max(69, 21 + (count - 1) * 6)
    return {'left': 15, 'right': right, 'top': 35, 'bottom': 94, 'notice_left': right + 1}


def body_top(template, page, panel):
    if template.get('layout_version', 2) >= 3 and (page != 1 or panel != 0):
        return 35
    return 44 if template.get('statistics_layout') == 1 and template.get('candidate_enabled') is False else 100


def adjacent_choice_rows(bottom, top):
    gap = top - bottom
    # Older row-major layouts left a 3.2 mm gap after every fifth row.
    return 0 <= gap < .3 or abs(gap - 3.2) < .01


def draw_choice_frames(canvas,template,page,height,columns,width):
    from reportlab.lib.units import mm
    panel_width=(width-24-(columns-1)*8)/columns
    groups={}
    for q in template.get('questions',[]):
        if q['type']=='subjective' or not q.get('choice_group'):
            continue
        for r in q['regions']:
            if r['page']==page:
                panel=int((r['x']-12+.01)/(panel_width+8))
                groups.setdefault((str(q['choice_group']),panel),{}).setdefault(r['y'],[]).append(r)

    canvas.saveState()
    canvas.setStrokeGray(.15)
    canvas.setLineWidth(.18*mm)
    obstacles=[r for q in template.get('questions',[]) for r in q.get('regions',[]) if r['page']==page]
    obstacles.extend(r for r in template.get('print_notes',[])+template.get('forbidden_regions',[]) if r['page']==page)

    def occupied(left, top, right, bottom):
        return any(r['x'] < right and r['x'] + r['width'] > left and
                   r['y'] < bottom and r['y'] + r['height'] > top for r in obstacles)

    for rows in groups.values():
        blocks=[]
        for y,cells in sorted(rows.items()):
            spans=[]
            for r in sorted(cells,key=lambda r:r['x']):
                left,right,bottom=r['x'],r['x']+r['width'],y+r['height']
                if spans and left-spans[-1][1]<=3.01 and bottom==spans[-1][2]:
                    spans[-1][1]=right
                else:spans.append([left,right,bottom])
            for left,right,bottom in spans:
                previous=next((b for b in reversed(blocks) if b[0]==left and right<=b[1] and adjacent_choice_rows(b[3],y)),None)
                if previous and (
                    (previous[3] < y and occupied(left, previous[3], previous[1], y)) or
                    (right < previous[1] and occupied(right + .01, y, previous[1] - .01, bottom))
                ):
                    previous=None
                if previous:previous[3]=bottom
                else:blocks.append([left,right,y,bottom])
        for left,right,top,bottom in blocks:
            canvas.rect(left*mm,(height-bottom)*mm,(right-left)*mm,(bottom-top)*mm)
    canvas.restoreState()
