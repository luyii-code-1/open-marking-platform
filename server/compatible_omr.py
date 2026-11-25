"""Geometry and optical mark reading for imported answer sheets."""
import base64
import binascii
import math

import cv2
import numpy as np
from . import statistics_sheet

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
        if page == '1' and not statistics_sheet.enabled(template):
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
    # Dark ink sits on bright paper, so closing removes dark marks to estimate paper illumination.
    background = cv2.morphologyEx(page, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    background = cv2.GaussianBlur(background, (0, 0), 15)
    return cv2.divide(page, np.maximum(background, 110), scale=245)


def deskew_full_frame(image):
    """Correct small full-frame scanner skew (+/- 5 deg) using dominant table/text lines."""
    ih, iw = image.shape
    factor = min(1.0, 1200.0 / max(ih, iw))
    probe = cv2.resize(image, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA) if factor < 1 else image
    edges = cv2.Canny(cv2.GaussianBlur(probe, (3, 3), 0), 50, 150)
    min_len = max(40, int(min(probe.shape) * 0.12))
    lines = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=70, minLineLength=min_len, maxLineGap=14)
    if lines is None or len(lines) < 6:
        return image
    angles, weights = [], []
    for x1, y1, x2, y2 in lines[:, 0]:
        dx, dy = float(x2 - x1), float(y2 - y1)
        length = math.hypot(dx, dy)
        if length < min_len:
            continue
        angle = math.degrees(math.atan2(dy, dx))
        while angle > 45.0:
            angle -= 90.0
        while angle < -45.0:
            angle += 90.0
        if abs(angle) <= 5.0:
            angles.append(angle)
            weights.append(length)
    if len(angles) < 6:
        return image
    order = np.argsort(angles)
    sorted_angles = np.asarray(angles, dtype=np.float64)[order]
    sorted_weights = np.asarray(weights, dtype=np.float64)[order]
    median = float(sorted_angles[np.searchsorted(np.cumsum(sorted_weights), sorted_weights.sum() * 0.5)])
    mad = float(np.median(np.abs(sorted_angles - median)))
    if abs(median) < 0.25 or mad > 0.6:
        return image
    center = (iw / 2.0, ih / 2.0)
    matrix = cv2.getRotationMatrix2D(center, median, 1.0)
    return cv2.warpAffine(image, matrix, (iw, ih), flags=cv2.INTER_CUBIC, borderValue=255)


def warp(image, corners, width, height):
    corners = np.asarray(corners, dtype=np.float32)
    ih, iw = image.shape
    if (corners.shape != (4, 2) or not np.isfinite(corners).all() or (corners < 0).any()
            or (corners[:, 0] >= iw).any() or (corners[:, 1] >= ih).any()
            or not cv2.isContourConvex(corners) or cv2.contourArea(corners, oriented=True) < ih * iw * .3):
        raise ValueError('请按左上、右上、右下、左下顺序标出纸边四角')
    target = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    matrix = cv2.getPerspectiveTransform(corners, target)
    return cv2.warpPerspective(image, matrix, (width, height), flags=cv2.INTER_CUBIC, borderValue=255)


def rectangular_page(image, width, height):
    """Use a visible paper outline, or a deskewed full-frame scanner image."""
    ih, iw = image.shape
    factor = min(1, 1100 / max(ih, iw))
    probe = cv2.resize(image, None, fx=factor, fy=factor) if factor < 1 else image
    blurred = cv2.GaussianBlur(probe, (5, 5), 0)
    edge_maps = [cv2.Canny(blurred, 45, 135)]
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    edge_maps.append(otsu)
    for edge_map in edge_maps:
        contours, _ = cv2.findContours(edge_map, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
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
            separated = probe[inside[:, 1], inside[:, 0]].astype(int) - probe[outside[:, 1], outside[:, 0]] > 20
            if .78 < (horizontal / vertical) / (width / height) < 1.28 and separated.sum() >= 3:
                corners = np.minimum(points / factor, (iw - 1, ih - 1))
                return warp(image, corners, width, height)
    if not .86 < (iw / ih) / (width / height) < 1.16:
        raise ValueError('纸张方向或比例不符，请校对纸型并框选四角')
    deskewed = deskew_full_frame(image)
    return cv2.resize(deskewed, (width, height), interpolation=cv2.INTER_AREA if iw > width else cv2.INTER_CUBIC)


def make_anchor(image, box):
    if not valid_box(box, image.shape[1] / SCALE, image.shape[0] / SCALE, 5) or max(box['width'], box['height']) > 36:
        raise ValueError('定位参照的边长应为 5 至 36 毫米')
    x, y, r, b = bounds(box)
    crop = cv2.resize(image[y:b, x:r], (PATCH_SIZE, PATCH_SIZE), interpolation=cv2.INTER_AREA)
    otsu_thresh, _ = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    threshold = float(np.clip(otsu_thresh, 145, 195)) if crop.max() - crop.min() >= 35 else 160.0
    bits = crop < threshold
    if not .025 < bits.mean() < .92:
        bits = crop < 160
    if not .025 < bits.mean() < .92:
        raise ValueError('请选择含固定印刷内容的矩形')
    return {**box, 'pattern': base64.b64encode(np.packbits(bits).tobytes()).decode('ascii')}


def _subpixel_peak(matches, location):
    px, py = int(location[0]), int(location[1])
    mh, mw = matches.shape
    dx = dy = 0.0
    if 1 <= px < mw - 1:
        denom = float(matches[py, px - 1] - 2.0 * matches[py, px] + matches[py, px + 1])
        if abs(denom) > 1e-6:
            dx = float(np.clip(0.5 * (matches[py, px - 1] - matches[py, px + 1]) / denom, -0.5, 0.5))
    if 1 <= py < mh - 1:
        denom = float(matches[py - 1, px] - 2.0 * matches[py, px] + matches[py + 1, px])
        if abs(denom) > 1e-6:
            dy = float(np.clip(0.5 * (matches[py - 1, px] - matches[py + 1, px]) / denom, -0.5, 0.5))
    return px + dx, py + dy


def warp_match(page, matrix, width, height):
    if matrix.shape == (3, 3):
        return cv2.warpPerspective(page, matrix, (width, height), flags=cv2.INTER_CUBIC, borderValue=255)
    return cv2.warpAffine(page, matrix, (width, height), flags=cv2.INTER_CUBIC, borderValue=255)


def registration(page, anchors):
    ih, iw = page.shape
    ink = cv2.GaussianBlur(np.clip((245.0 - page.astype(np.float32)) / 245.0, 0.0, 1.0), (3, 3), 0.7)
    dark = cv2.GaussianBlur(np.float32(page < 170), (3, 3), 0.7)
    source, target, scores, signatures = [], [], [], []
    margin = 88
    for anchor in anchors:
        x, y, r, b = bounds(anchor)
        pw, ph = r - x, b - y
        left, top = max(0, x - margin), max(0, y - margin)
        right, bottom = min(iw, r + margin), min(ih, b + margin)
        roi_ink = ink[top:bottom, left:right]
        roi_dark = dark[top:bottom, left:right]
        bits = patch_data(anchor)
        base_pattern = np.float32(bits)
        best = None
        for scale in (1.0, 0.96, 1.04):
            sw, sh = max(8, round(pw * scale)), max(8, round(ph * scale))
            if sw >= roi_ink.shape[1] or sh >= roi_ink.shape[0]:
                continue
            pattern = cv2.GaussianBlur(cv2.resize(base_pattern, (sw, sh), interpolation=cv2.INTER_AREA), (3, 3), 0.7)
            for roi in (roi_ink, roi_dark):
                matches = cv2.matchTemplate(roi, pattern, cv2.TM_CCOEFF_NORMED)
                mh, mw = matches.shape
                mean_r = cv2.boxFilter(roi, cv2.CV_32F, (sw, sh), anchor=(0, 0), normalize=True)[:mh, :mw]
                sq_r = cv2.boxFilter(roi * roi, cv2.CV_32F, (sw, sh), anchor=(0, 0), normalize=True)[:mh, :mw]
                var_r = sq_r - mean_r * mean_r
                matches = np.where((var_r > 1e-3) & (mean_r > 0.01), matches, -1.0)
                _, score, _, location = cv2.minMaxLoc(matches)
                if best is None or score > best[0]:
                    sx, sy = _subpixel_peak(matches, location)
                    best = (float(score), left + sx + sw / 2.0, top + sy + sh / 2.0)
            if scale == 1.0 and best is not None and best[0] >= 0.72:
                break
        if best is None or best[0] < .50:
            continue
        source.append((best[1], best[2]))
        target.append((x + pw / 2.0, y + ph / 2.0))
        scores.append(best[0])
        signatures.append(distinctive(bits))
    if len(source) < 4:
        return None
    src_pts = np.float32(source)
    dst_pts = np.float32(target)
    if cv2.contourArea(cv2.convexHull(src_pts)) < iw * ih * .10:
        return None

    def _valid_distinctive(mask):
        return any(good and identifying and s >= .58 for good, identifying, s in zip(mask, signatures, scores))

    def _valid_homography(H):
        if H is None or not np.isfinite(H).all() or abs(H[2, 0]) >= 3e-4 or abs(H[2, 1]) >= 3e-4:
            return False
        corners = np.float32([[[0, 0], [iw - 1, 0], [iw - 1, ih - 1], [0, ih - 1]]])
        warped = cv2.perspectiveTransform(corners, H)[0]
        if not cv2.isContourConvex(warped):
            return False
        area_ratio = cv2.contourArea(warped) / (iw * ih)
        if not .76 < area_ratio < 1.28:
            return False
        top_w = float(np.linalg.norm(warped[1] - warped[0])) / iw
        bot_w = float(np.linalg.norm(warped[2] - warped[3])) / iw
        left_h = float(np.linalg.norm(warped[3] - warped[0])) / ih
        right_h = float(np.linalg.norm(warped[2] - warped[1])) / ih
        if any(not .78 < edge < 1.25 for edge in (top_w, bot_w, left_h, right_h)):
            return False
        linear = H[:2, :2] / max(float(H[2, 2]), 1e-6)
        return np.max(np.abs(linear - np.eye(2))) <= .18

    # Try perspective homography first so keystone/trapezoid camera or scanner warps align cleanly.
    homography, h_inliers = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 7.0)
    if homography is not None and h_inliers is not None:
        h_mask = h_inliers.ravel().astype(bool)
        if int(h_mask.sum()) >= 4 and _valid_distinctive(h_mask) and _valid_homography(homography):
            if cv2.contourArea(cv2.convexHull(src_pts[h_mask])) >= iw * ih * .10:
                score = sum(v for v, good in zip(scores, h_mask) if good) / len(anchors)
                return score, homography

    matrix, inliers = cv2.estimateAffine2D(src_pts, dst_pts, ransacReprojThreshold=7)
    if matrix is None or inliers is None or int(inliers.sum()) < 4:
        return None
    a_mask = inliers.ravel().astype(bool)
    if not _valid_distinctive(a_mask):
        return None
    linear = matrix[:, :2]
    if not .78 < np.linalg.det(linear) < 1.25 or np.max(np.abs(linear - np.eye(2))) > .16:
        return None
    score = sum(v for v, good in zip(scores, a_mask) if good) / len(anchors)
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
    if not matches or matches[0][0] < .50 or (len(matches) > 1 and matches[0][0] - matches[1][0] < .05):
        raise ValueError('无法可靠匹配题卡版式或方向，请核对扫描件')
    _, face, page, matrix = matches[0]
    if face != side:
        raise ValueError('扫描面与当前题卡正反面不符，请核对配页顺序')
    return warp_match(page, matrix, width, height)


def mark(image, box):
    ih, iw = image.shape
    x, y, r, b = bounds(box)
    x, y = max(0, min(iw - 1, x)), max(0, min(ih - 1, y))
    r, b = max(x + 1, min(iw, r)), max(y + 1, min(ih, b))
    bw, bh = r - x, b - y
    dx = min(int(bw * .24), max(0, (bw - 2) // 2))
    dy = min(int(bh * .24), max(0, (bh - 2) // 2))
    inner = image[y + dy:b - dy, x + dx:r - dx]
    if inner.size == 0:
        return 0.0
    pad_x, pad_y = max(4, bw), max(4, bh)
    ring = image[max(0, y - pad_y):min(ih, b + pad_y), max(0, x - pad_x):min(iw, r + pad_x)]
    paper_level = float(np.clip(np.percentile(ring, 88), 180.0, 250.0)) if ring.size else 245.0
    denom = max(paper_level - 45.0, 80.0)
    soft = np.clip((paper_level - inner.astype(np.float32)) / denom, 0.0, 1.0)
    binary = np.float32(inner < min(160.0, paper_level - 65.0))
    return float(0.65 * np.mean(soft) + 0.35 * np.mean(binary))


def read(normalized, template, side):
    page = 1 if side == 'front' else 2
    candidate = None
    if page == 1 and not statistics_sheet.enabled(template):
        digits = []
        for column in page_profile(template, side)['candidate']:
            levels = [mark(normalized, cell) for cell in column]
            baseline = min(0.28, float(np.percentile(levels, 50)))
            effective = [max(0.0, level - baseline) for level in levels]
            selected = [str(i) for i, (raw, eff) in enumerate(zip(levels, effective)) if eff >= .38 and raw >= .40]
            uncertain = [i for i, eff in enumerate(effective) if .22 < eff < .38]
            digits.append(selected[0] if len(selected) == 1 and not uncertain else '?')
        candidate = ''.join(digits)
    objective_questions = [q for q in template['questions'] if q['type'] != 'subjective' and q['regions'][0]['page'] == page]
    raw_by_question = {q['id']: [mark(normalized, cell) for cell in q['external_options']] for q in objective_questions}
    all_choice_levels = [level for levels in raw_by_question.values() for level in levels]
    choice_baseline = min(0.24, float(np.percentile(all_choice_levels, 30))) if all_choice_levels else 0.0
    selections, uncertain = {}, []
    for q in objective_questions:
        levels = raw_by_question[q['id']]
        effective = [max(0.0, level - choice_baseline) for level in levels]
        if any(.22 < eff < .38 for eff in effective):
            uncertain.append(q['id'])
        selections[q['id']] = [chr(65 + i) for i, (raw, eff) in enumerate(zip(levels, effective)) if eff >= .38 and raw >= .40]
    absent_level = absence_level(normalized, template, side)
    if uncertain or .24 < absent_level < .40:
        raise UncertainMarks(normalized, candidate, selections, uncertain, absent_level >= .40, .24 < absent_level < .40)
    return candidate, selections


def absence_level(normalized, template, side):
    if statistics_sheet.enabled(template):
        return 0
    box = page_profile(template, side).get('absent') if side == 'front' else None
    return mark(normalized, box) if box else 0


def absent(normalized, template, side):
    return absence_level(normalized, template, side) >= .40
