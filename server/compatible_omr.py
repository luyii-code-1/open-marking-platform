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
            if not valid_box(anchor, width, height, 3) or max(anchor['width'], anchor['height']) > 36:
                raise ValueError('定位参照的边长应为 3 至 36 毫米')
            pattern = patch_data(anchor)
            if not .025 < pattern.mean() < .92:
                raise ValueError('定位参照需包含清晰的固定印刷图案')
            distinctive_count += distinctive(pattern)
            centers.append((anchor['x'] + anchor['width'] / 2, anchor['y'] + anchor['height'] / 2))
        if cv2.contourArea(cv2.convexHull(np.float32(centers))) < width * height * .13:
            raise ValueError('请将定位参照分布在纸面的四周')
        if not distinctive_count:
            raise ValueError('请增加一处能辨别当前版式和方向的固定印刷参照')
        if page == '1' and statistics_sheet.uses_candidate_number(template):
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


def _find_solid_anchor_in_roi(image, x, y, r, b, target_cx, target_cy):
    ih, iw = image.shape
    x, y = max(0, x), max(0, y)
    r, b = min(iw, r), min(ih, b)
    roi = image[y:b, x:r]
    if roi.size == 0 or roi.shape[0] < 10 or roi.shape[1] < 10:
        return None
    otsu_thresh, _ = cv2.threshold(roi, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    threshold = float(np.clip(otsu_thresh, 145, 195)) if roi.max() - roi.min() >= 35 else 160.0
    dark = (roi < threshold).astype(np.uint8)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(dark)
    if count <= 1:
        return None
    solid = []
    other_substantial = 0
    for idx in range(1, count):
        cx_i, cy_i, cw, ch, area = stats[idx]
        if area < 20:
            continue
        fill = area / max(1, cw * ch)
        ratio = cw / max(1, ch)
        touches_edge = cx_i == 0 or cy_i == 0 or cx_i + cw >= roi.shape[1] or cy_i + ch >= roi.shape[0]
        if 6 <= cw <= 40 and 6 <= ch <= 40 and 0.45 <= ratio <= 2.2 and fill >= 0.58:
            dist = math.hypot((x + centroids[idx][0]) - target_cx, (y + centroids[idx][1]) - target_cy)
            solid.append((idx, int(cx_i), int(cy_i), int(cw), int(ch), int(area), dist, touches_edge))
        elif not touches_edge:
            other_substantial += int(area)
    if not solid:
        return None
    solid.sort(key=lambda item: (item[7], item[6], -item[5]))
    best_idx, bx, by, bw, bh, b_area, _, _ = solid[0]
    return roi, dark, labels, best_idx, bx, by, bw, bh, b_area, solid, other_substantial, x, y


def tighten_anchor_box(image, box, snap_nearby=False):
    """Snap a loose or slightly drifted anchor box tightly around a solid fiducial block, avoiding nearby lines."""
    ih, iw = image.shape
    x, y, r, b = bounds(box)
    target_cx, target_cy = (x + r) / 2.0, (y + b) / 2.0
    found = _find_solid_anchor_in_roi(image, x, y, r, b, target_cx, target_cy)
    snapped_outside = False
    if found is None and snap_nearby:
        # External AI boxes can drift by several millimeters; search nearby for a solid fiducial block.
        margin = 14 * SCALE
        found = _find_solid_anchor_in_roi(image, x - margin, y - margin, r + margin, b + margin, target_cx, target_cy)
        snapped_outside = found is not None
    if found is None:
        return box

    roi, dark, labels, best_idx, bx, by, bw, bh, b_area, solid, other_substantial, rx, ry = found
    if not snapped_outside:
        other_solid = sum(item[5] for item in solid[1:] if not item[7])
        if other_solid + other_substantial > b_area * 0.45:
            return box

    # Expand tightly around the solid block without touching neighboring dark strokes/dashed lines.
    other_dark = (dark > 0) & (labels != best_idx)
    max_pad = max(2, min(5, round(min(bw, bh) * 0.28)))
    pl = pr = pt = pb = 0
    for step in range(1, max_pad + 1):
        col = bx - step
        if col < 0 or other_dark[max(0, by - 1):min(roi.shape[0], by + bh + 1), col].any():
            break
        pl = step
    for step in range(1, max_pad + 1):
        col = bx + bw - 1 + step
        if col >= roi.shape[1] or other_dark[max(0, by - 1):min(roi.shape[0], by + bh + 1), col].any():
            break
        pr = step
    for step in range(1, max_pad + 1):
        row = by - step
        if row < 0 or other_dark[row, max(0, bx - pl):min(roi.shape[1], bx + bw + pr)].any():
            break
        pt = step
    for step in range(1, max_pad + 1):
        row = by + bh - 1 + step
        if row >= roi.shape[0] or other_dark[row, max(0, bx - pl):min(roi.shape[1], bx + bw + pr)].any():
            break
        pb = step

    nx1 = rx + bx - pl
    ny1 = ry + by - pt
    nx2 = rx + bx + bw + pr
    ny2 = ry + by + bh + pb
    # Ensure white contrast border so solid black blocks stay below the 0.92 fill ceiling.
    if (bw * bh) / max(1, (nx2 - nx1) * (ny2 - ny1)) > 0.82:
        nx1 = max(0, nx1 - 2)
        ny1 = max(0, ny1 - 2)
        nx2 = min(iw, nx2 + 2)
        ny2 = min(ih, ny2 + 2)
    min_px = 3 * SCALE
    if nx2 - nx1 < min_px:
        need = min_px - (nx2 - nx1)
        nx1 = max(0, nx1 - need // 2)
        nx2 = min(iw, nx1 + min_px)
        nx1 = max(0, nx2 - min_px)
    if ny2 - ny1 < min_px:
        need = min_px - (ny2 - ny1)
        ny1 = max(0, ny1 - need // 2)
        ny2 = min(ih, ny1 + min_px)
        ny1 = max(0, ny2 - min_px)
    return {
        'x': round(nx1 / SCALE, 2),
        'y': round(ny1 / SCALE, 2),
        'width': round((nx2 - nx1) / SCALE, 2),
        'height': round((ny2 - ny1) / SCALE, 2),
    }


def rectify_by_anchors(page, anchors, apply_grayscale=True):
    """Rectify perspective skew using the 4 outermost corner anchors, then normalize grayscale."""
    ih, iw = page.shape
    if not isinstance(anchors, list) or len(anchors) < 4:
        raise ValueError('请先标定至少 4 个四角定位块再执行矩形校正')
    centers = np.float32([[(a['x'] + a['width'] / 2.0) * SCALE, (a['y'] + a['height'] / 2.0) * SCALE] for a in anchors])
    sums = centers[:, 0] + centers[:, 1]
    diffs = centers[:, 0] - centers[:, 1]
    tl_i = int(np.argmin(sums))
    br_i = int(np.argmax(sums))
    tr_i = int(np.argmax(diffs))
    bl_i = int(np.argmin(diffs))
    if len({tl_i, tr_i, br_i, bl_i}) != 4:
        raise ValueError('请将 4 个定位块分别分布在纸面左上、右上、右下、左下四周')
    src = np.float32([centers[tl_i], centers[tr_i], centers[br_i], centers[bl_i]])
    if not cv2.isContourConvex(src) or cv2.contourArea(src) < iw * ih * 0.12:
        raise ValueError('四角定位块围成面积过小或未形成有效四边形，请调整位置')
    x_left = float((src[0, 0] + src[3, 0]) * 0.5)
    x_right = float((src[1, 0] + src[2, 0]) * 0.5)
    y_top = float((src[0, 1] + src[1, 1]) * 0.5)
    y_bot = float((src[3, 1] + src[2, 1]) * 0.5)
    if x_right - x_left < iw * 0.30 or y_bot - y_top < ih * 0.30:
        raise ValueError('定位块水平或垂直跨度不足，无法执行矩形校正')
    dst = np.float32([[x_left, y_top], [x_right, y_top], [x_right, y_bot], [x_left, y_bot]])
    matrix = cv2.getPerspectiveTransform(src, dst)
    rectified = cv2.warpPerspective(page, matrix, (iw, ih), flags=cv2.INTER_CUBIC, borderValue=255)
    cleaned = grayscale(rectified) if apply_grayscale else rectified

    # Map every anchor box through the same homography so subsequent anchor re-extraction stays aligned.
    mapped = []
    max_w, max_h = iw / SCALE, ih / SCALE
    for a in anchors:
        x1, y1, x2, y2 = bounds(a)
        quad = np.float32([[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]])
        warped_quad = cv2.perspectiveTransform(quad, matrix)[0]
        mx1 = float(np.clip(warped_quad[:, 0].min() / SCALE, 0.0, max_w - 3.0))
        my1 = float(np.clip(warped_quad[:, 1].min() / SCALE, 0.0, max_h - 3.0))
        mx2 = float(np.clip(warped_quad[:, 0].max() / SCALE, mx1 + 3.0, max_w))
        my2 = float(np.clip(warped_quad[:, 1].max() / SCALE, my1 + 3.0, max_h))
        mapped.append({
            'x': round(mx1, 2),
            'y': round(my1, 2),
            'width': round(mx2 - mx1, 2),
            'height': round(my2 - my1, 2),
        })
    return cleaned, mapped


def _sample_patch(image, box):
    x, y, r, b = bounds(box)
    crop = cv2.resize(image[y:b, x:r], (PATCH_SIZE, PATCH_SIZE), interpolation=cv2.INTER_AREA)
    otsu_thresh, _ = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    threshold = float(np.clip(otsu_thresh, 145, 195)) if crop.max() - crop.min() >= 35 else 160.0
    bits = crop < threshold
    if not .025 < bits.mean() < .92:
        bits = crop < 160
    return bits


def _expand_box(box, delta_mm, max_w, max_h):
    x1 = max(0.0, box['x'] - delta_mm)
    y1 = max(0.0, box['y'] - delta_mm)
    x2 = min(max_w, box['x'] + box['width'] + delta_mm)
    y2 = min(max_h, box['y'] + box['height'] + delta_mm)
    w = min(36.0, round(x2 - x1, 2))
    h = min(36.0, round(y2 - y1, 2))
    return {'x': round(x1, 2), 'y': round(y1, 2), 'width': w, 'height': h}


def make_anchor(image, box, tighten=False, snap_nearby=False):
    max_w, max_h = image.shape[1] / SCALE, image.shape[0] / SCALE
    if tighten:
        box = tighten_anchor_box(image, box, snap_nearby=snap_nearby)
    if not valid_box(box, max_w, max_h, 3) or max(box['width'], box['height']) > 36:
        raise ValueError('定位参照的边长应为 3 至 36 毫米')
    bits = _sample_patch(image, box)
    # If a tightly drawn box covers almost 100% solid black ink, pad slightly for clean white border contrast.
    if bits.mean() >= .92:
        for delta in (1.25, 2.5):
            padded = _expand_box(box, delta, max_w, max_h)
            if valid_box(padded, max_w, max_h, 3) and max(padded['width'], padded['height']) <= 36:
                candidate = _sample_patch(image, padded)
                if .025 < candidate.mean() < .92:
                    box, bits = padded, candidate
                    break
    # If an AI-supplied distinctive text/logo box landed slightly off-target, gently widen to capture nearby ink.
    if bits.mean() <= .025 and snap_nearby:
        for delta in (4.0, 8.0):
            widened = _expand_box(box, delta, max_w, max_h)
            if valid_box(widened, max_w, max_h, 3) and max(widened['width'], widened['height']) <= 36:
                candidate = _sample_patch(image, widened)
                if .025 < candidate.mean() < .92:
                    box, bits = widened, candidate
                    break
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
    if page == 1 and statistics_sheet.uses_candidate_number(template):
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
    if not statistics_sheet.uses_absence_mark(template):
        return 0
    box = page_profile(template, side).get('absent') if side == 'front' else None
    return mark(normalized, box) if box else 0


def absent(normalized, template, side):
    return absence_level(normalized, template, side) >= .40
