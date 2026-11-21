"""Select the visible areas on each scanned face for one scoring item."""
import math
from .omr import dimensions


def frame_errors(template, question):
    if question.get('review_layout', 'stack') not in ('stack', 'paper'):
        return ['阅卷画面排版无效']
    frames = question.get('review_frames', [])
    if not isinstance(frames, list):
        return ['阅卷显示框应为区域列表']
    width, height = dimensions(template)
    seen = set()
    for frame in frames:
        if not isinstance(frame, dict) or type(frame.get('page')) is not int:
            return ['阅卷显示框页码无效']
        page = frame['page']
        if page not in range(1, (2 if template.get('sides') == 2 else 1) + 1) or page in seen:
            return ['每个纸面最多设置一个阅卷显示框，请检查页码']
        seen.add(page)
        if any(type(frame.get(k)) not in (int, float) or not math.isfinite(frame[k])
               for k in ('x', 'y', 'width', 'height')):
            return ['阅卷显示框坐标无效']
        x, y, w, h = (frame[k] for k in ('x', 'y', 'width', 'height'))
        if min(x, y) < 0 or min(w, h) < 1 or x+w > width+.000001 or y+h > height+.000001:
            return ['阅卷显示框超出纸面或尺寸过小']
    return []


def pixel_box(region):
    x, y, w, h = (region[k]*4 for k in ('x', 'y', 'width', 'height'))
    return (int(x), int(y), int(x+w), int(y+h))


def display_sources(submission, template, question, answer):
    overrides = submission.get('region_overrides', {})
    regions = overrides.get(question['id'], {}).get('regions', question['regions'])
    sources = answer['sources'] if answer else [{'region': r} for r in regions]
    if question.get('review_layout') != 'paper':
        return sources

    frames = {f['page']: f for f in question.get('review_frames', [])}
    pages = {}
    for source in sources:
        pages.setdefault(source['region']['page'], []).append(source)
    others = [r for q in template['questions'] if q['id'] != question['id']
              for r in overrides.get(q['id'], {}).get('regions', q['regions'])]
    result = []
    for page, pieces in sorted(pages.items()):
        boxes = [pixel_box(p['region']) for p in pieces]
        # An individually corrected slice takes precedence over the template frame.
        original = [pixel_box(r) for r in question['regions'] if r['page'] == page]
        if page in frames and sorted(boxes) == sorted(original):
            bounds = pixel_box(frames[page])
        else:
            bounds = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                      max(b[2] for b in boxes), max(b[3] for b in boxes))
        x, y, right, bottom = bounds
        masks = []
        for other in others:
            if other['page'] != page:
                continue
            l, t, r, b = pixel_box(other)
            l, t, r, b = max(x, l), max(y, t), min(right, r), min(bottom, b)
            if l < r and t < b:
                masks.append([l, t, r-l, b-t])
        region = dict(page=page, x=x/4, y=y/4, width=(right-x)/4, height=(bottom-y)/4)
        result.append({**pieces[0], 'region': region, 'masks': masks})
    return result
