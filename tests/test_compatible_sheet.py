import io
from uuid import uuid4

import cv2
import numpy as np
import pytest
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.pdfgen import canvas

from scanner_engine.main import digest, process
from server import compatible_omr as external
from server.compatible_templates import input_pages, prep_dimensions
from server.omr import recognize
from server.scanner_pipeline import config_hash, configuration
from server.template_checks import issues


def box(x, y, width, height):
    return dict(x=x, y=y, width=width, height=height)


def fill(image, region, value=30):
    x, y, r, b = external.bounds(region)
    image[y + 2:b - 2, x + 2:r - 2] = value


def sheet(paper, sides):
    width, height = prep_dimensions(paper)
    candidate = [[box(24 + c * 8, 31 + d * 6, 5, 4) for d in range(10)] for c in range(3)]
    choices = [box(25 + i * 10, 115, 5, 4) for i in range(4)]
    qid = str(uuid4())
    subject_id = str(uuid4())
    template = {
        'id': str(uuid4()), 'revision': 1, 'layout_version': 3, 'name': 'External',
        'paper': paper, 'sides': sides, 'candidate_length': 3,
        'external_sheet': {'version': 1, 'mode': 'completed', 'pages': {}},
        'questions': [
            {'id': qid, 'number': 1, 'type': 'single', 'points': 2, 'options': 4,
             'regions': [{**box(25, 115, 35, 4), 'page': 1}], 'external_options': choices},
            {'id': subject_id, 'number': 2, 'type': 'subjective', 'points': 8,
             'regions': [{**box(47, 160, 85, 64), 'page': sides}]},
        ],
    }
    images = []
    for face in range(1, sides + 1):
        image = np.full((height, width), 245, np.uint8)
        anchor_boxes = [box(x, y, 25, 13) for x, y in ((8, 8), (width / 4 - 33, 8), (width / 4 - 33, 274), (8, 274))]
        for i, region in enumerate(anchor_boxes):
            x, y, _, _ = external.bounds(region)
            cv2.putText(image, ('FR' if face == 1 else 'B8') + str(i), (x + 4, y + 39), cv2.FONT_HERSHEY_SIMPLEX, 1.1, 15, 3)
        definition = {'anchors': [external.make_anchor(external.grayscale(image), region) for region in anchor_boxes]}
        if face == 1:
            definition['candidate'] = candidate
            definition['absent'] = box(124, 45, 5, 4)
            for cells in [*candidate, choices]:
                for region in cells:
                    x, y, r, b = external.bounds(region)
                    cv2.rectangle(image, (x, y), (r - 1, b - 1), 60, 1)
            for column, digit in zip(candidate, (0, 1, 2)):
                fill(image, column[digit])
            fill(image, choices[2])
        template['external_sheet']['pages'][str(face)] = definition
        images.append(image)
    return template, images


@pytest.mark.parametrize('paper,sides', [('A4', 1), ('A3', 2)])
def test_external_reading_preserves_identity_options_and_cuts(tmp_path, paper, sides):
    template, images = sheet(paper, sides)
    assert issues(template, complete=True, require_answers=False) == []
    batch, capture = str(uuid4()), str(uuid4())
    original = tmp_path / 'pages' / batch / (capture + '.jpg')
    original.parent.mkdir(parents=True)
    w, h = prep_dimensions(paper)
    skew = np.float32([[1, .012, -4], [-.009, 1, 4]])
    rotated = np.rot90(cv2.warpAffine(images[0], skew, (w, h), borderValue=235), 1)
    original.write_bytes(cv2.imencode('.jpg', rotated)[1].tobytes())
    result = process(tmp_path, {'batch_id': batch, 'capture_id': capture, 'template': configuration(template),
                               'side': 'front', 'source_sha256': digest(original.read_bytes()), 'config_sha256': config_hash(template)})
    assert result['engine_version'] == external.ENGINE_VERSION
    assert result['candidate_number'] == '012'
    assert result['selections'] == {template['questions'][0]['id']: ['C']}
    assert len(result['cuts']) == (2 if sides == 1 else 1)
    assert not result['absent_mark']
    if sides == 2:
        assert recognize(images[1], template, 'back')[0].shape == (h, w)
        with pytest.raises(ValueError, match='正反面'):
            recognize(images[1], template, 'front')


def test_external_rejects_other_layout_and_uncertain_fill():
    template, (image,) = sheet('A4', 1)
    with pytest.raises(ValueError, match='版式'):
        recognize(np.full_like(image, 250), template, 'front')
    x, y, r, b = external.bounds(template['questions'][0]['external_options'][0])
    image[y + 3:b - 3, x + 6:x + 10] = 20
    with pytest.raises(ValueError, match='填涂难判'):
        recognize(image, template, 'front')


@pytest.mark.parametrize('paper,pdf_page', [('A4', A4), ('A3', landscape(A3))])
def test_reference_import_reads_both_pdf_faces(paper, pdf_page):
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=pdf_page)
    for face in ('Front', 'Back'):
        pdf.drawString(50, 80, face)
        pdf.showPage()
    pdf.save()
    images = input_pages(output.getvalue(), *prep_dimensions(paper))
    assert len(images) == 2
    assert (images[0].shape[1] > images[0].shape[0]) == (paper == 'A3')
    assert np.min(images[0]) < 50


def test_publish_trial_and_wire_compatibility(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from server import db, jobs
    from server.main import app

    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setattr(jobs, 'dispatch', lambda *args, **kwargs: None)
    template, (image,) = sheet('A4', 1)
    sample = cv2.imencode('.png', image)[1].tobytes()
    with TestClient(app) as client:
        account = {'username': 'admin', 'password': 'administrator-password', 'name': '管理员'}
        assert client.post('/api/v1/auth/bootstrap', json=account).is_success
        login = client.post('/api/v1/auth/login', json=account)
        assert login.is_success
        headers = {'Authorization': 'Bearer ' + login.json()['token']}
        with db.connect() as connection:
            project = db.put(connection, 'projects', {'name': '兼容测试', 'status': 'draft'})
            subject = db.put(connection, 'subjects', {'project_id': project['id'], 'name': '数学'})
            group = db.put(connection, 'groups', {'subject_id': subject['id'], 'name': '题卡组'})
        template['group_id'] = group['id']
        group_url = f"/api/v1/groups/{group['id']}"
        reference = client.post(group_url + '/compatible/reference', data={'paper': 'A4'},
                                files={'files': ('reference.png', sample)}, headers=headers)
        assert reference.is_success and len(reference.json()['pages']) == 1, reference.text[:400]
        url = f"/api/v1/templates/{template['id']}"
        saved = client.put(group_url + f"/drafts/{template['id']}", headers=headers,
                           json={'value': template, 'base_version': 0, 'request_id': str(uuid4())})
        assert saved.is_success, saved.text
        assert client.post(url + '/publish', headers=headers).status_code == 422
        trial = client.post(url + '/compatible/trial', data={'side': 'front'},
                            files={'file': ('trial.png', sample)}, headers=headers)
        assert trial.is_success and trial.json()['candidate'] == '012', trial.text[:400]
        with db.connect() as connection:
            assert not db.objects(connection, 'pages') and not db.objects(connection, 'submissions')
        published = client.post(url + '/publish', headers=headers)
        assert published.is_success, published.text
        package_url = f"/api/v1/scanner/projects/{project['id']}/package"
        assert not client.get(package_url, headers=headers).json()['groups']
        group_config = client.get(package_url, params={'capability': external.CAPABILITY}, headers=headers).json()['groups'][0]
        assert group_config['config_sha256'] == config_hash(published.json())
        assert group_config['template']['external_sheet'] == template['external_sheet']
        batch, page = str(uuid4()), str(uuid4())
        created = client.post(f'/api/v1/scanner/batches/{batch}', headers=headers,
                              json={'group_id': group['id'], 'template_id': template['id'],
                                    'template_revision': published.json()['revision'], 'config_sha256': group_config['config_sha256']})
        assert created.is_success, created.text
        qid = template['questions'][0]['id']
        x, y, _, b = external.bounds(template['questions'][0]['external_options'][0])
        image[y + 3:b - 3, x + 6:x + 10] = 20
        uploaded = client.post(f'/api/v1/scan-batches/{batch}/pages', headers=headers,
                               data={'capture_id': page, 'side': 'front', 'sequence': 1},
                               files={'file': ('answer.png', cv2.imencode('.png', image)[1].tobytes())})
        assert uploaded.is_success, uploaded.text
        jobs.process_page(page)
        page_url = f'/api/v1/pages/{page}'
        assert client.put(page_url, json={'reason': '核对扫描页'}, headers=headers).status_code == 422
        corrected = client.put(page_url, json={'reason': '核对扫描页', 'selections': {qid: ['C']}}, headers=headers)
        assert corrected.is_success and corrected.json()['status'] == 'recognized', corrected.text


def test_external_accuracy_with_preprinted_letters_light_pencil_and_perspective():
    template, (base,) = sheet('A4', 1)
    # Render a realistic blank + filled sheet with pre-printed digits/letters inside bubbles and light 2B pencil fill.
    width, height = prep_dimensions('A4')
    realistic = base.copy()
    # Redraw all bubbles cleanly with pre-printed characters inside every cell.
    for col_idx, column in enumerate(template['external_sheet']['pages']['1']['candidate']):
        for digit, cell in enumerate(column):
            x, y, r, b = external.bounds(cell)
            realistic[y + 1:b - 1, x + 1:r - 1] = 244
            cv2.rectangle(realistic, (x, y), (r - 1, b - 1), 85, 1)
            cv2.putText(realistic, str(digit), (x + 5, b - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.34, 115, 1)
        # Fill with lighter 2B pencil intensity (~118)
        fill(realistic, column[(col_idx + 3) % 10], value=118)
    for i, cell in enumerate(template['questions'][0]['external_options']):
        x, y, r, b = external.bounds(cell)
        realistic[y + 1:b - 1, x + 1:r - 1] = 244
        cv2.rectangle(realistic, (x, y), (r - 1, b - 1), 85, 1)
        cv2.putText(realistic, chr(65 + i), (x + 5, b - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.34, 115, 1)
    fill(realistic, template['questions'][0]['external_options'][1], value=118)

    # Apply mild perspective warp + uneven lighting gradient.
    src = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    dst = np.float32([[8, 6], [width - 14, 12], [width - 6, height - 10], [12, height - 6]])
    warped = cv2.warpPerspective(realistic, cv2.getPerspectiveTransform(src, dst), (width, height), borderValue=235)
    gradient = np.linspace(0.86, 1.0, width, dtype=np.float32)[None, :]
    shaded = np.clip(warped.astype(np.float32) * gradient, 0, 255).astype(np.uint8)

    normalized, candidate, selections = recognize(shaded, template, 'front')
    assert normalized.shape == (height, width)
    assert candidate == '345'
    assert selections == {template['questions'][0]['id']: ['B']}


def test_compatible_adopt_auto_corrected_and_reextract_anchors(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from server import db, jobs
    from server.main import app

    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setattr(jobs, 'dispatch', lambda *args, **kwargs: None)
    template, (image,) = sheet('A4', 1)
    sample = cv2.imencode('.png', image)[1].tobytes()
    with TestClient(app) as client:
        account = {'username': 'admin', 'password': 'administrator-password', 'name': '管理员'}
        assert client.post('/api/v1/auth/bootstrap', json=account).is_success
        headers = {'Authorization': 'Bearer ' + client.post('/api/v1/auth/login', json=account).json()['token']}
        with db.connect() as connection:
            project = db.put(connection, 'projects', {'name': '校正测试', 'status': 'draft'})
            subject = db.put(connection, 'subjects', {'project_id': project['id'], 'name': '物理'})
            group = db.put(connection, 'groups', {'subject_id': subject['id'], 'name': '兼容卡'})
        group_url = f"/api/v1/groups/{group['id']}"
        adopted = client.post(group_url + '/compatible/reference', data={'paper': 'A4', 'already_corrected': 'true'},
                              files={'files': ('corrected.png', sample)}, headers=headers)
        assert adopted.is_success and adopted.json()['pages'][0].get('image'), adopted.text
        boxes = [{k: a[k] for k in ('x', 'y', 'width', 'height')} for a in template['external_sheet']['pages']['1']['anchors']]
        import json
        refreshed = client.post(group_url + '/compatible/reextract-anchors', data={'paper': 'A4', 'boxes': json.dumps(boxes)},
                                files={'file': ('corrected.png', sample)}, headers=headers)
        assert refreshed.is_success and len(refreshed.json()['anchors']) == len(boxes), refreshed.text


def test_external_tight_anchor_excludes_dashed_line_and_rectifies_by_anchors():
    from server.compatible_templates import suggest_anchors, suggest_regions

    width, height = prep_dimensions('A4')
    page = np.full((height, width), 236, np.uint8)
    # Four 12x12 px (3x3 mm) black corner fiducials, with a vertical dashed fold line 4 px left of bottom-left anchor.
    corners_px = [(40, 40), (width - 52, 40), (width - 52, height - 52), (40, height - 52)]
    for cx, cy in corners_px:
        page[cy:cy + 12, cx:cx + 12] = 20
    dashed_x = 34
    for dy in range(height - 120, height - 10, 12):
        page[dy:dy + 5, dashed_x:dashed_x + 2] = 25
    # Add distinctive header text so a 5th anchor can be found.
    cv2.putText(page, 'EXAM-SHEET-2026', (120, 90), cv2.FONT_HERSHEY_SIMPLEX, 1.0, 20, 2)
    # Draw clean 3-column candidate grid + 1 objective choice row so suggest_regions works after rectification.
    for col in range(3):
        for d in range(10):
            x, y = 100 + col * 32, 160 + d * 24
            cv2.rectangle(page, (x, y), (x + 20, y + 14), 40, 1)
    for opt in range(4):
        x, y = 100 + opt * 38, 460
        cv2.rectangle(page, (x, y), (x + 20, y + 14), 40, 1)

    suggested = suggest_anchors(external.grayscale(page))
    assert len(suggested) >= 4
    bl = min(suggested[:4], key=lambda a: (a['x'] ** 2 + (height / 4 - a['y']) ** 2))
    # Tightened box should stay compact (<= 5.5 mm) and stay strictly to the right of the dashed fold line.
    assert bl['width'] <= 5.5 and bl['height'] <= 5.5, bl
    assert bl['x'] * external.SCALE > dashed_x + 1, bl

    # Manual loose draw covering both the black square and the dashed line should still tighten tightly onto the black square.
    loose = box(7.0, (height - 62) / 4, 12.0, 10.0)
    tight_anchor = external.make_anchor(external.grayscale(page), loose, tighten=True)
    assert tight_anchor['width'] <= 5.5 and tight_anchor['height'] <= 5.5, tight_anchor
    assert tight_anchor['x'] * external.SCALE > dashed_x + 1, tight_anchor

    # Tight box sitting 100% on solid black ink should auto-pad for contrast instead of raising ValueError.
    exact_black = box(40 / 4, 40 / 4, 12 / 4, 12 / 4)
    padded_anchor = external.make_anchor(external.grayscale(page), exact_black, tighten=False)
    assert padded_anchor['width'] > 3.0 and .025 < external.patch_data(padded_anchor).mean() < .92

    # Slightly drifted external AI anchor box in nearby white margin should snap onto the real black corner square.
    drifted_ai = box(20 / 4, 20 / 4, 14 / 4, 14 / 4)
    snapped_anchor = external.make_anchor(external.grayscale(page), drifted_ai, tighten=True, snap_nearby=True)
    assert abs((snapped_anchor['x'] + snapped_anchor['width'] / 2) * 4 - 46) < 4, snapped_anchor

    # Four plain solid corner squares automatically get a 5th distinctive directional printed reference added.
    from server.compatible_templates import ensure_distinctive_anchor
    plain_four = [external.make_anchor(external.grayscale(page), box((cx - 4) / 4, (cy - 4) / 4, 5.0, 5.0), tighten=True) for cx, cy in corners_px]
    assert not any(external.distinctive(external.patch_data(a)) for a in plain_four)
    enriched, added = ensure_distinctive_anchor(external.grayscale(page), plain_four)
    assert added is True and len(enriched) == 5
    assert any(external.distinctive(external.patch_data(a)) for a in enriched)

    # Warp the page with trapezoid perspective distortion + uneven shading, then rectify via the 4 skewed anchors.
    src_q = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    dst_q = np.float32([[14, 18], [width - 26, 8], [width - 8, height - 20], [22, height - 10]])
    H = cv2.getPerspectiveTransform(src_q, dst_q)
    skewed = cv2.warpPerspective(page, H, (width, height), borderValue=225)
    grad = np.linspace(0.75, 1.0, width, dtype=np.float32)[None, :]
    shaded_skewed = np.clip(skewed.astype(np.float32) * grad, 0, 255).astype(np.uint8)
    warped_anchors = []
    for cx, cy in corners_px:
        pt = cv2.perspectiveTransform(np.float32([[[cx + 6, cy + 6]]]), H)[0, 0]
        warped_anchors.append(box((pt[0] - 10) / 4, (pt[1] - 10) / 4, 5.0, 5.0))
    rectified, mapped = external.rectify_by_anchors(shaded_skewed, warped_anchors, apply_grayscale=True)
    assert rectified.shape == (height, width)
    # Mapped 4 corner anchors should now be axis-aligned horizontally and vertically.
    c_mapped = [(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2) for a in mapped]
    assert abs(c_mapped[0][0] - c_mapped[3][0]) < 1.0 and abs(c_mapped[0][1] - c_mapped[1][1]) < 1.0, c_mapped
    # Grayscale normalization evens out left-right shading so left paper background is bright (> 220).
    assert float(np.median(rectified[200:260, 10:40])) > 220
    regions = suggest_regions(rectified)
    assert len(regions['candidate']) == 3 and len(regions['choices']) >= 1, regions
