"""Import and test external answer-sheet geometry without ingesting answer sheets."""
import base64
import hashlib
import io
import json
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

from . import compatible_omr as omr, statistics_sheet
from .db import connect, put
from .dependencies import admin, require
from .lifecycle import writable
from .omr import dimensions, recognize, absent_mark
from .templates import require_replaceable

router = APIRouter(prefix='/api/v1')
MAX_UPLOAD = 30 * 1024 * 1024
_slots = threading.BoundedSemaphore(3)


def picture(image, extension='.png'):
    return 'data:image/' + ('jpeg' if extension == '.jpg' else 'png') + ';base64,' + base64.b64encode(cv2.imencode(extension, image)[1]).decode()


def input_pages(content, width, height):
    if content.startswith(b'%PDF-'):
        renderer, info = shutil.which('pdftoppm'), shutil.which('pdfinfo')
        if not renderer or not info:
            raise HTTPException(503, 'PDF 导入工具不可用，请上传扫描图片')
        with tempfile.TemporaryDirectory(prefix='omp-external-sheet-') as directory:
            source = Path(directory, 'sample.pdf')
            source.write_bytes(content)
            details = subprocess.run([info, '-f', '1', '-l', '2', str(source)], capture_output=True, timeout=15, check=True)
            count = re.search(rb'^Pages:\s+(\d+)', details.stdout, re.M)
            if count is None or int(count[1]) not in (1, 2):
                raise ValueError('题卡 PDF 应为一页或两页')
            sizes = re.findall(rb'^Page(?:\s+\d+)?\s+size:\s+([\d.]+) x ([\d.]+)', details.stdout, re.M)
            expected = sorted((width / omr.SCALE, height / omr.SCALE))
            if len(sizes) != int(count[1]) or any(any(abs(d * 25.4 / 72 - e) > 3 for d, e in zip(sorted(map(float, size)), expected)) for size in sizes):
                raise ValueError('PDF 页面尺寸与所选纸型不符')
            target = Path(directory, 'page')
            subprocess.run([renderer, '-f', '1', '-l', count[1].decode(), '-scale-to', str(max(width, height) * 2), '-gray', '-png', str(source), str(target)], capture_output=True, timeout=20, check=True)
            images = [cv2.imdecode(np.frombuffer(path.read_bytes(), np.uint8), cv2.IMREAD_GRAYSCALE) for path in sorted(Path(directory).glob('page-*.png'))]
            if len(images) != int(count[1]) or any(image is None for image in images):
                raise ValueError('无法渲染 PDF 纸面')
            return images
    with Image.open(io.BytesIO(content)) as source:
        count = getattr(source, 'n_frames', 1)
        if source.format not in ('JPEG', 'PNG', 'TIFF', 'BMP') or not 1 <= count <= 2:
            raise ValueError('请选择单面或双面 PDF、JPG、PNG、TIFF 或 BMP')
        images = []
        for frame in range(count):
            source.seek(frame)
            if source.width * source.height > 40_000_000 or min(source.size) < 150:
                raise ValueError('题卡图片尺寸无效或超过 4000 万像素')
            gray = ImageOps.exif_transpose(source).convert('L')
            gray.thumbnail((2200, 2200), Image.Resampling.LANCZOS)
            images.append(np.array(gray))
        return images


def read_file(file):
    content = file.file.read(MAX_UPLOAD + 1)
    if len(content) > MAX_UPLOAD:
        raise HTTPException(413, '单个文件超过 30 MB')
    return content


def box_from_pixels(x, y, w, h):
    return dict(zip(('x', 'y', 'width', 'height'), (v / omr.SCALE for v in (x, y, w, h))))


def suggest_anchors(page):
    height, width = page.shape
    mask = np.uint8(page < 155)
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    candidates = []
    for x, y, w, h, area in stats[1:]:
        if 6 <= w <= 34 and 6 <= h <= 34 and .55 <= w / h <= 1.85 and area >= .66 * w * h:
            candidates.append((int(x), int(y), int(w), int(h), x + w / 2, y + h / 2))
    anchors = []
    for tx, ty in ((.08, .08), (.92, .08), (.92, .92), (.08, .92)):
        options = [c for c in candidates if abs(c[4] / width - tx) < .15 and abs(c[5] / height - ty) < .16]
        if not options:
            horizontal = range(18, int(width * .26), 34) if tx < .5 else range(int(width * .70), width - 97, 34)
            vertical = range(20, int(height * .18), 32) if ty < .5 else range(int(height * .78), height - 60, 32)
            proposals = []
            for y in vertical:
                for x in horizontal:
                    try:
                        anchor = omr.make_anchor(page, box_from_pixels(x, y, 80, 48))
                    except ValueError:
                        continue
                    pattern = omr.patch_data(anchor)
                    if omr.distinctive(pattern):
                        detail = cv2.cornerMinEigenVal(np.float32(pattern), 3).sum()
                        proposals.append((detail, anchor))
            if proposals:
                anchors.append(max(proposals, key=lambda item: item[0])[1])
            continue
        bx, by, bw, bh, cx, cy = min(options, key=lambda c: (c[4] / width - tx) ** 2 + (c[5] / height - ty) ** 2)
        # Tight ROI around the detected solid fiducial block, then snap tightly away from nearby lines.
        pad = max(3, min(6, round(max(bw, bh) * 0.35)))
        left = max(0, bx - pad)
        top = max(0, by - pad)
        right = min(width, bx + bw + pad)
        bottom = min(height, by + bh + pad)
        if right - left < 12:
            left = max(0, min(width - 12, int(cx - 6)))
            right = left + 12
        if bottom - top < 12:
            top = max(0, min(height - 12, int(cy - 6)))
            bottom = top + 12
        anchors.append(omr.make_anchor(page, box_from_pixels(left, top, right - left, bottom - top), tighten=True))
    if len(anchors) == 4:
        for y in (56, 92, 132):
            for x in range(90, width - 160, 76):
                box = box_from_pixels(x, y, 96, 44)
                if any(box['x'] < a['x'] + a['width'] and box['x'] + box['width'] > a['x']
                       and box['y'] < a['y'] + a['height'] and box['y'] + box['height'] > a['y'] for a in anchors):
                    continue
                try:
                    anchor = omr.make_anchor(page, box)
                except ValueError:
                    continue
                if omr.distinctive(omr.patch_data(anchor)):
                    return [*anchors, anchor]
    return anchors


def suggest_regions(page, anonymous=False, statistics=False):
    adaptive = cv2.adaptiveThreshold(page, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 21, 10)
    mask = np.uint8((page < 165) | (adaptive > 0))
    contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    # Light horizontal closing helps merge open-bracket OMR cells such as [A].
    closed_cells = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((1, 5), np.uint8))
    bracket_contours, _ = cv2.findContours(closed_cells, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    small, frames = [], []
    height, width = page.shape
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:3500]:
        x, y, w, h = cv2.boundingRect(contour)
        if w >= width * .15 and h >= 44 and w < width * .95 and h < height * .83:
            points = cv2.approxPolyDP(contour, .013 * cv2.arcLength(contour, True), True)
            if len(points) == 4 and cv2.contourArea(contour) >= .84 * w * h:
                if not any(abs(x - a) < 8 and abs(y - b) < 8 and abs(w - c) < 14 and abs(h - d) < 14 for a, b, c, d in frames):
                    frames.append((x, y, w, h))
        elif 9 <= w <= 44 and 6 <= h <= 28 and w / h <= 3.2 and cv2.contourArea(contour) > .48 * w * h:
            if not any(abs(x + w / 2 - a - c / 2) < 3 and abs(y + h / 2 - b - d / 2) < 3 for a, b, c, d in small):
                small.append((x, y, w, h))
    for contour in bracket_contours:
        x, y, w, h = cv2.boundingRect(contour)
        if 10 <= w <= 42 and 6 <= h <= 24 and 0.8 <= w / h <= 3.2 and cv2.contourArea(contour) > .30 * w * h:
            if not any(abs(x + w / 2 - a - c / 2) < 4 and abs(y + h / 2 - b - d / 2) < 4 for a, b, c, d in small):
                small.append((x, y, w, h))
    rows = []
    for cell in sorted(small, key=lambda c: c[1] + c[3] / 2):
        center = cell[1] + cell[3] / 2
        if not rows or abs(center - (rows[-1][0][1] + rows[-1][0][3] / 2)) > 5:
            rows.append([])
        rows[-1].append(cell)
    runs = []
    for row in rows:
        ordered = sorted(row)
        start = 0
        for i, (left, right) in enumerate(zip(ordered, ordered[1:]), 1):
            if right[0] - left[0] > max(34, 2.8 * left[2]):
                runs.append(ordered[start:i])
                start = i
        runs.append(ordered[start:])
    grid = []
    for i, run in enumerate(runs):
        if not 1 <= len(run) <= 20:
            continue
        similar = [other for other in runs[i:] if len(other) == len(run) and all(abs(a[0] - b[0]) <= 4 for a, b in zip(run, other))]
        if len(similar) < 10:
            continue
        offsets = np.diff([row[0][1] for row in similar[:10]])
        if offsets.min() >= 8 and offsets.max() - offsets.min() <= 7:
            grid = similar[:10]
            break
    minimum, maximum = (2, 26) if anonymous or statistics else (3, 7)
    choice = [[box_from_pixels(*cell) for cell in row] for row in runs
              if minimum <= len(row) <= maximum and (anonymous or row not in grid)]
    candidate = [[box_from_pixels(*cell) for cell in column] for column in zip(*grid)] if grid else []
    return {'candidate': candidate, 'choices': choice[:150], 'frames': [box_from_pixels(*frame) for frame in frames[:45]]}


def prep_dimensions(paper):
    if paper not in ('A3', 'A4'):
        raise ValueError('请选择 A3 或 A4')
    return tuple(d * omr.SCALE for d in dimensions({'paper': paper}))


def draft_in_group(db, group_id, current):
    group = require(db, group_id, 'groups')
    writable(db, 'groups', group)
    if group.get('frozen'):
        raise HTTPException(409, '已冻结的题卡组无法制版')
    require_replaceable(db, group_id)
    return group


@router.post('/groups/{group_id}/compatible/reference')
def reference(group_id: str, files: list[UploadFile] = File(), paper: str = Form(),
              rotation: int = Form(0), corners: str = Form(''), combine: bool = Form(False),
              already_corrected: bool = Form(False), apply_grayscale: bool = Form(True), current=Depends(admin)):
    with connect() as db:
        group = draft_in_group(db, group_id, current)
        from .statistics_projects import is_statistics_group
        statistics = is_statistics_group(db, group)
    if not 1 <= len(files) <= (5 if combine else 2) or not 0 <= rotation <= 3:
        raise HTTPException(422, '请选择有效的题卡样张和旋转方向')
    if not _slots.acquire(blocking=False):
        raise HTTPException(503, '题卡导入较繁忙，请稍后重试')
    try:
        width, height = prep_dimensions(paper)
        images = [image for file in files for image in input_pages(read_file(file), width, height)]
        if len(images) > (5 if combine else 2) or (corners or already_corrected) and len(images) != 1:
            raise ValueError('每次最多导入两面，手动校正或引用校正图请逐面处理')
        result, pages = {}, []
        for index, image in enumerate(images):
            # Return the exact preview coordinate space for subsequent manual corner placement.
            factor = min(1, 1800 / max(image.shape))
            image = np.ascontiguousarray(np.rot90(image, rotation))
            if not corners and not already_corrected and (image.shape[1] > image.shape[0]) != (width > height):
                image = np.ascontiguousarray(np.rot90(image))
            if factor < 1:
                image = cv2.resize(image, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
            if already_corrected:
                page = image if image.shape == (height, width) else cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA if image.shape[1] > width else cv2.INTER_CUBIC)
            elif corners:
                page = omr.warp(image, json.loads(corners), width, height)
            else:
                try:
                    page = omr.rectangular_page(image, width, height)
                except ValueError as error:
                    result[index] = {'source': picture(image, '.jpg'), 'error': str(error)}
                    continue
            pages.append((index, page, image))
        if combine and len(pages) > 1:
            reference_page = omr.grayscale(pages[0][1])
            anchors = suggest_anchors(reference_page)
            aligned = [pages[0][1]]
            for _, page, _ in pages[1:]:
                match = omr.registration(omr.grayscale(page), anchors)
                if match and match[0] >= .54:
                    aligned.append(omr.warp_match(page, match[1], width, height))
            pages = [(pages[0][0], np.quantile(aligned, .70, axis=0).astype(np.uint8), pages[0][2])]
        if combine:
            if not pages:
                result = {min(result): result[min(result)]}
            else:
                result = {}
                pages = pages[:1]
        for index, page, source in pages:
            normalized = omr.grayscale(page)
            rendered = normalized if apply_grayscale else page
            result[index] = {'source': picture(source, '.jpg'), 'image': picture(rendered),
                             'anchors': suggest_anchors(normalized),
                             **suggest_regions(normalized, bool(group.get('statistics_group')), statistics)}
        return JSONResponse({'pages': [result[index] for index in sorted(result)]}, headers={'Cache-Control': 'private, no-store'})
    except (ValueError, OSError, cv2.error, subprocess.SubprocessError) as error:
        raise HTTPException(422, f'无法导入题卡：{error}') from error
    finally:
        _slots.release()


def _decode_page_for_anchor(content, width, height, apply_grayscale=True):
    image = cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError('请先校正并载入当前纸面的样张')
    if image.shape != (height, width):
        ratio = (image.shape[1] / image.shape[0]) / (width / height)
        if not .96 <= ratio <= 1.04:
            raise ValueError('请先校正并载入当前纸面的样张')
        image = cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA if image.shape[1] > width else cv2.INTER_CUBIC)
    return omr.grayscale(image) if apply_grayscale else image


@router.post('/groups/{group_id}/compatible/anchor')
def anchor(group_id: str, file: UploadFile = File(), box: str = Form(), paper: str = Form(),
           tighten: bool = Form(True), current=Depends(admin)):
    with connect() as db:
        draft_in_group(db, group_id, current)
    try:
        width, height = prep_dimensions(paper)
        normalized = _decode_page_for_anchor(read_file(file), width, height)
        return omr.make_anchor(normalized, json.loads(box), tighten=tighten)
    except (ValueError, cv2.error) as error:
        raise HTTPException(422, str(error)) from error


@router.post('/groups/{group_id}/compatible/reextract-anchors')
def reextract_anchors(group_id: str, file: UploadFile = File(), boxes: str = Form(), paper: str = Form(),
                      tighten: bool = Form(True), current=Depends(admin)):
    with connect() as db:
        draft_in_group(db, group_id, current)
    try:
        width, height = prep_dimensions(paper)
        normalized = _decode_page_for_anchor(read_file(file), width, height)
        raw_boxes = json.loads(boxes)
        if not isinstance(raw_boxes, list) or not 1 <= len(raw_boxes) <= 8:
            raise ValueError('定位参照数量应为 1 至 8 个')
        return {'anchors': [omr.make_anchor(normalized, {k: item[k] for k in ('x', 'y', 'width', 'height')}, tighten=tighten) for item in raw_boxes]}
    except (ValueError, KeyError, TypeError, cv2.error) as error:
        raise HTTPException(422, str(error)) from error


@router.post('/groups/{group_id}/compatible/rectify')
def rectify(group_id: str, file: UploadFile = File(), paper: str = Form(),
            corners: str = Form(''), anchors: str = Form(''),
            apply_grayscale: bool = Form(True), detect_regions: bool = Form(True),
            already_rectified: bool = Form(False), current=Depends(admin)):
    """Run grayscale + rectangular perspective correction first, then detect regions on the clean sheet."""
    with connect() as db:
        group = draft_in_group(db, group_id, current)
        from .statistics_projects import is_statistics_group
        statistics = is_statistics_group(db, group)
    if not _slots.acquire(blocking=False):
        raise HTTPException(503, '题卡校正较繁忙，请稍后重试')
    try:
        width, height = prep_dimensions(paper)
        raw_content = read_file(file)
        if corners:
            images = input_pages(raw_content, width, height)
            if len(images) != 1:
                raise ValueError('四角校正请逐面处理')
            image = images[0]
            factor = min(1, 1800 / max(image.shape))
            if factor < 1:
                image = cv2.resize(image, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
            warped = omr.warp(image, json.loads(corners), width, height)
            cleaned = omr.grayscale(warped) if apply_grayscale else warped
            normalized = cleaned if apply_grayscale else omr.grayscale(warped)
            found_anchors = suggest_anchors(normalized)
        elif anchors:
            page = _decode_page_for_anchor(raw_content, width, height, apply_grayscale=False)
            raw_anchors = json.loads(anchors)
            cleaned, mapped_boxes = omr.rectify_by_anchors(page, raw_anchors, apply_grayscale=apply_grayscale)
            normalized = cleaned if apply_grayscale else omr.grayscale(cleaned)
            found_anchors = [omr.make_anchor(normalized, box, tighten=True) for box in mapped_boxes]
        elif already_rectified:
            page = _decode_page_for_anchor(raw_content, width, height, apply_grayscale=False)
            cleaned = omr.grayscale(page) if apply_grayscale else page
            normalized = cleaned if apply_grayscale else omr.grayscale(page)
            found_anchors = suggest_anchors(normalized)
        else:
            images = input_pages(raw_content, width, height)
            if len(images) != 1:
                raise ValueError('自动矩形校正请逐面处理')
            image = images[0]
            if (image.shape[1] > image.shape[0]) != (width > height):
                image = np.ascontiguousarray(np.rot90(image))
            warped = omr.rectangular_page(image, width, height)
            cleaned = omr.grayscale(warped) if apply_grayscale else warped
            normalized = cleaned if apply_grayscale else omr.grayscale(warped)
            found_anchors = suggest_anchors(normalized)
        regions = (suggest_regions(normalized, bool(group.get('statistics_group')), statistics) if detect_regions
                   else {'candidate': [], 'choices': [], 'frames': []})
        return JSONResponse({'image': picture(cleaned), 'anchors': found_anchors, **regions}, headers={'Cache-Control': 'private, no-store'})
    except (ValueError, KeyError, TypeError, OSError, cv2.error) as error:
        raise HTTPException(422, f'灰度与矩形校正失败：{error}') from error
    finally:
        _slots.release()


def fingerprint(template):
    geometry = {k: template.get(k) for k in ('paper', 'sides', 'candidate_length', 'external_sheet', 'background_assets')}
    if template.get('candidate_enabled') is False:
        geometry['candidate_enabled'] = False
    geometry['questions'] = [{k: q.get(k) for k in ('id', 'number', 'type', 'options', 'regions', 'external_options')} for q in template['questions']]
    return hashlib.sha256(json.dumps(geometry, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def trials_current(template):
    return all(template.get('external_trials', {}).get(side) == fingerprint(template) for side in ('front', 'back')[:template['sides']])


@router.post('/templates/{identifier}/compatible/trial')
def trial(identifier: str, file: UploadFile = File(), side: str = Form(), current=Depends(admin)):
    from .template_checks import issues

    with connect() as db:
        template = require(db, identifier, 'templates')
        draft_in_group(db, template['group_id'], current)
    if not omr.profile(template) or template['status'] != 'draft' or side not in ('front', 'back')[:template['sides']]:
        raise HTTPException(422, '请选择兼容草稿中的有效纸面')
    errors = issues(template, complete=True, require_answers=False)
    if errors:
        raise HTTPException(422, '；'.join(errors))
    try:
        images = input_pages(read_file(file), *prep_dimensions(template['paper']))
        if len(images) != 1:
            raise ValueError('试扫时请逐面上传样张')
        normalized, candidate, selections = recognize(images[0], template, side)
        missing = absent_mark(normalized, side, template)
        if side == 'front' and statistics_sheet.uses_candidate_number(template) and omr.profile(template)['mode'] == 'completed' and (not candidate or '?' in candidate):
            raise ValueError('试扫件存在无法识读的考号，请核对考号格或使用填涂清晰的试扫件')
    except (ValueError, OSError, cv2.error, subprocess.SubprocessError) as error:
        raise HTTPException(422, str(error)) from error
    signature = fingerprint(template)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        latest = require(db, identifier, 'templates')
        if latest['status'] != 'draft' or fingerprint(latest) != signature:
            raise HTTPException(409, '试扫期间题卡已修改，请按最新配置重试')
        draft_in_group(db, latest['group_id'], current)
        put(db, 'templates', {**latest, 'external_trials': {**latest.get('external_trials', {}), side: signature}}, current['id'])
    return JSONResponse({'image': picture(normalized, '.jpg'), 'candidate': candidate, 'selections': selections,
                         'absent': missing}, headers={'Cache-Control': 'private, no-store'})
