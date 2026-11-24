"""Geometry and optical mark reading for imported answer sheets."""
import base64
import binascii
import math

import cv2
import numpy as np

CAPABILITY = 'external-sheet-1'
ENGINE_VERSION = 'omp-external-1'
SCALE = 4
PATCH_SIZE = 32


class UncertainMarks(ValueError):
    def __init__(self, image, candidate, selections, questions, absent, absent_uncertain):
        message = '填涂难判，请核对客观题或缺考格'
        super().__init__(message)
        self.image = image
        self.candidate = candidate
        self.selections = selections
        self.questions = questions
        self.absent = absent
        self.absent_uncertain = absent_uncertain


def profile(template):
    return template.get('external_sheet')


def page_profile(template, side):
    return profile(template)['pages'][str(1 if side == 'front' else 2)]


def bounds(box):
    x, y, w, h = (box[k] for k in ('x', 'y', 'width', 'height'))
    return tuple(round(v * SCALE) for v in (x, y, x + w, y + h))


def valid_box(box, width, height, minimum=1):
    if not isinstance(box, dict):
        return False
    values = [box.get(k) for k in ('x', 'y', 'width', 'height')]
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
        return False
    x, y, w, h = values
    return min(x, y) >= 0 and min(w, h) >= minimum and x + w <= width + 1e-6 and y + h <= height + 1e-6


def patch_data(anchor):
    try:
        pattern = anchor.get('pattern')
        if not isinstance(pattern, str) or len(pattern) != 172:
            raise ValueError('定位参照数据无效')
        bits = base64.b64decode(pattern, validate=True)
    except binascii.Error as error:
        raise ValueError('定位参照数据无效') from error
    if len(bits) != PATCH_SIZE ** 2 // 8:
        raise ValueError('定位参照数据无效')
    return np.unpackbits(np.frombuffer(bits, np.uint8)).reshape(PATCH_SIZE, PATCH_SIZE)


def distinctive(pattern):
    contours, _ = cv2.findContours(pattern, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    substantial = [contour for contour in contours if len(contour) > 2 and cv2.contourArea(contour) >= 8]
    if len(substantial) >= 2:
        return True
    if not substantial:
        return False
    _, _, width, height = cv2.boundingRect(substantial[0])
    return cv2.contourArea(substantial[0]) / (width * height) < .65


def validate(template):
    from .omr import dimensions

    width, height = dimensions(template)
    external = profile(template)
    if not isinstance(external, dict) or external.get('version') != 1 or external.get('mode') not in ('blank', 'completed'):
        raise ValueError('兼容题卡配置无效')
    pages = external.get('pages')
    if not isinstance(pages, dict) or set(pages) != {str(i) for i in range(1, template['sides'] + 1)}:
        raise ValueError('请为每个纸面完成兼容标定')
    for page, definition in pages.items():
        if not isinstance(definition, dict):
            raise ValueError('纸面配置无效')
        anchors = definition.get('anchors')
        if not isinstance(anchors, list) or not 4 <= len(anchors) <= 8:
            raise ValueError('每面需确认至少四个固定印刷参照')
        centers, distinctive_count = [], 0
        for anchor in anchors:
            if not valid_box(anchor, width, height, 5) or max(anchor['width'], anchor['height']) > 36:
                raise ValueError('定位参照的边长应为 5 至 36 毫米')
            pattern = patch_data(anchor)
            if not .025 < pattern.mean() < .92:
                raise ValueError('定位参照需包含清晰的固定印刷图案')
            distinctive_count += distinctive(pattern)
            centers.append((anchor['x'] + anchor['width'] / 2, anchor['y'] + anchor['height'] / 2))
        if cv2.contourArea(cv2.convexHull(np.float32(centers))) < width * height * .13:
            raise ValueError('请将定位参照分布在纸面的四周')
        if not distinctive_count:
            raise ValueError('请增加一处能辨别当前版式和方向的固定印刷参照')
        if page == '1':
            reference = definition.get('candidate', [])
            length = template.get('candidate_length')
            if type(length) is not int or not 1 <= length <= 20 or not isinstance(reference, list) or len(reference) != length:
                raise ValueError('请按考号顺序配置每位数字的填涂格')
            if any(not isinstance(column, list) or len(column) != 10 or any(not valid_box(cell, width, height) for cell in column) for column in reference):
                raise ValueError('每位考号需按 0 至 9 配置十个填涂格')
            if definition.get('absent') is not None and not valid_box(definition['absent'], width, height):
                raise ValueError('缺考填涂格无效')
    if external['mode'] == 'blank' and set(template.get('background_assets', {})) != set(pages):
        raise ValueError('请导入每面的空白原稿')
    occupied = []
    for q in template['questions']:
        if q.get('parts'):
            raise ValueError('兼容题卡请为各题分别配置题区')
        regions = q.get('regions', [])
        for region in regions:
            page = region.get('page')
            if type(page) is not int or str(page) not in pages or not valid_box(region, width, height):
                raise ValueError('答题区超出纸面或尺寸过小')
            x, y, right, bottom = bounds(region)
            if any(page == p and x < r and right > l and y < b and bottom > t for p, l, t, r, b in occupied):
                raise ValueError('答题区域重叠')
            occupied.append((page, x, y, right, bottom))
        if q['type'] == 'subjective':
            continue
        cells = q.get('external_options')
        if len(regions) != 1 or not isinstance(cells, list) or len(cells) != q['options']:
            raise ValueError(f"第 {q['number']} 题需配置每个选项的填涂格")
        x, y, right, bottom = bounds(regions[0])
        for cell in cells:
            if not valid_box(cell, width, height):
                raise ValueError(f"第 {q['number']} 题填涂格无效")
            left, top, r, b = bounds(cell)
            if left < x or top < y or r > right or b > bottom:
                raise ValueError(f"第 {q['number']} 题填涂格须位于题区内")


def grayscale(page):
    background = cv2.GaussianBlur(cv2.erode(page, None), (0, 0), 15)
    background = cv2.morphologyEx(background, cv2.MORPH_CLOSE, np.ones((23, 23), np.uint8))
    return cv2.divide(page, np.maximum(background, 110), scale=245)


def warp(image, corners, width, height):
    corners = np.asarray(corners, dtype=np.float32)
    ih, iw = image.shape
    if (corners.shape != (4, 2) or not np.isfinite(corners).all() or (corners < 0).any()
            or (corners[:, 0] >= iw).any() or (corners[:, 1] >= ih).any()
            or not cv2.isContourConvex(corners) or cv2.contourArea(corners, oriented=True) < ih * iw * .3):
        raise ValueError('请按左上、右上、右下、左下顺序标出纸边四角')
    target = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    matrix = cv2.getPerspectiveTransform(corners, target)
    return cv2.warpPerspective(image, matrix, (width, height), borderValue=255)


def rectangular_page(image, width, height):
    """Use a visible paper outline, or a full-frame scanner image."""
    ih, iw = image.shape
    factor = min(1, 1100 / max(ih, iw))
    probe = cv2.resize(image, None, fx=factor, fy=factor) if factor < 1 else image
    edges = cv2.Canny(cv2.GaussianBlur(probe, (5, 5), 0), 45, 135)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:12]:
        area = cv2.contourArea(contour) / probe.size
        if area < .60:
            break
        points = cv2.approxPolyDP(contour, .02 * cv2.arcLength(contour, True), True)
        if len(points) != 4 or not cv2.isContourConvex(points):
            continue
        points = points.reshape((4, 2)).astype(np.float32)
        center = points.mean(axis=0)
        points = points[np.argsort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))]
        points = np.roll(points, -int(np.argmin(points.sum(axis=1))), axis=0)
        horizontal = np.linalg.norm(points[1] - points[0]) + np.linalg.norm(points[2] - points[3])
        vertical = np.linalg.norm(points[3] - points[0]) + np.linalg.norm(points[2] - points[1])
        mids = (points + np.roll(points, -1, axis=0)) * .5
        directions = mids - center
        delta = directions / np.maximum(1, np.linalg.norm(directions, axis=1, keepdims=True)) * 7
        outside = np.int32(np.clip(mids + delta, 0, (probe.shape[1] - 1, probe.shape[0] - 1)))
        inside = np.int32(np.clip(mids - delta, 0, (probe.shape[1] - 1, probe.shape[0] - 1)))
        separated = probe[inside[:,1],inside[:,0]].astype(int) - probe[outside[:,1],outside[:,0]] > 22
        if .78 < (horizontal / vertical) / (width / height) < 1.28 and separated.sum() >= 3:
            corners = np.minimum(points / factor, (iw - 1, ih - 1))
            return warp(image, corners, width, height)
    if not .86 < (iw / ih) / (width / height) < 1.16:
        raise ValueError('纸张方向或比例不符，请校对纸型并框选四角')
    return cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA if iw > width else cv2.INTER_LINEAR)


def make_anchor(image, box):
    if not valid_box(box, image.shape[1] / SCALE, image.shape[0] / SCALE, 5) or max(box['width'], box['height']) > 36:
        raise ValueError('定位参照的边长应为 5 至 36 毫米')
    x, y, r, b = bounds(box)
    bits = cv2.resize(image[y:b, x:r], (PATCH_SIZE, PATCH_SIZE), interpolation=cv2.INTER_AREA) < 160
    if not .025 < bits.mean() < .92:
        raise ValueError('请选择含固定印刷内容的矩形')
    return {**box, 'pattern': base64.b64encode(np.packbits(bits).tobytes()).decode('ascii')}


def registration(page, anchors):
    ih, iw = page.shape
    dark = np.float32(page < 165)
    source, target, scores, signatures = [], [], [], []
    margin = 55
    for anchor in anchors:
        x, y, r, b = bounds(anchor)
        left, top = max(0, x - margin), max(0, y - margin)
        roi = dark[top:min(ih, b + margin), left:min(iw, r + margin)]
        bits = patch_data(anchor)
        pattern = cv2.resize(np.float32(bits), (r - x, b - y))
        matches = cv2.matchTemplate(roi, pattern, cv2.TM_CCOEFF_NORMED)
        _, score, _, location = cv2.minMaxLoc(matches)
        if score < .52:
            continue
        source.append((left + location[0], top + location[1]))
        target.append((x, y))
        scores.append(score)
        signatures.append(distinctive(bits))
    if len(source) < 4:
        return None
    if cv2.contourArea(cv2.convexHull(np.float32(source))) < iw * ih * .10:
        return None
    matrix, inliers = cv2.estimateAffine2D(np.float32(source), np.float32(target), ransacReprojThreshold=7)
    if matrix is None or inliers is None or int(inliers.sum()) < 4:
        return None
    if not any(good and identifying and score >= .60 for good, identifying, score in zip(inliers.ravel(), signatures, scores)):
        return None
    linear = matrix[:, :2]
    if not .78 < np.linalg.det(linear) < 1.25 or np.max(np.abs(linear - np.eye(2))) > .14:
        return None
    score = sum(v for v, good in zip(scores, inliers.ravel()) if good) / len(anchors)
    return score, matrix


def normalize(image, template, side, corners=None):
    from .omr import dimensions

    width, height = (d * SCALE for d in dimensions(template))
    if corners is not None:
        return grayscale(warp(image, [[p['x'], p['y']] for p in corners], width, height))
    first = 0 if (image.shape[1] > image.shape[0]) == (width > height) else 1
    matches = []
    for turn in (first, first + 2):
        oriented = np.ascontiguousarray(np.rot90(image, turn))
        try:
            page = grayscale(rectangular_page(oriented, width, height))
        except ValueError:
            continue
        for face in ('front', 'back')[:template['sides']]:
            match = registration(page, page_profile(template, face)['anchors'])
            if match:
                matches.append((match[0], face, page, match[1]))
    matches.sort(key=lambda item: item[0], reverse=True)
    if not matches or matches[0][0] < .52 or (len(matches) > 1 and matches[0][0] - matches[1][0] < .055):
        raise ValueError('无法可靠匹配题卡版式或方向，请核对扫描件')
    _, face, page, matrix = matches[0]
    if face != side:
        raise ValueError('扫描面与当前题卡正反面不符，请核对配页顺序')
    return cv2.warpAffine(page, matrix, (width, height), borderValue=255)


def mark(image, box):
    x, y, r, b = bounds(box)
    dx, dy = int((r - x) * .24), int((b - y) * .24)
    return float(np.mean(image[y + dy:b - dy, x + dx:r - dx] < 150))


def read(normalized, template, side):
    page = 1 if side == 'front' else 2
    candidate = None
    if page == 1:
        digits = []
        for column in page_profile(template, side)['candidate']:
            levels = [mark(normalized, cell) for cell in column]
            selected = [str(i) for i, level in enumerate(levels) if level >= .43]
            digits.append(selected[0] if len(selected) == 1 and sum(v > .24 for v in levels) == 1 else '?')
        candidate = ''.join(digits)
    selections, uncertain = {}, []
    for q in template['questions']:
        if q['type'] == 'subjective' or q['regions'][0]['page'] != page:
            continue
        levels = [mark(normalized, cell) for cell in q['external_options']]
        if any(.24 < level < .43 for level in levels):
            uncertain.append(q['id'])
        selections[q['id']] = [chr(65 + i) for i, level in enumerate(levels) if level >= .43]
    absent_level = absence_level(normalized, template, side)
    if uncertain or .24 < absent_level < .43:
        raise UncertainMarks(normalized, candidate, selections, uncertain, absent_level >= .43, .24 < absent_level < .43)
    return candidate, selections


def absence_level(normalized, template, side):
    box = page_profile(template, side).get('absent') if side == 'front' else None
    return mark(normalized, box) if box else 0


def absent(normalized, template, side):
    return absence_level(normalized, template, side) >= .43
