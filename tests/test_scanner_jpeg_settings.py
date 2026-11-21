from hashlib import sha256
from uuid import uuid4

import cv2
import numpy as np
import pytest

from scanner_engine.main import estimate_upload, prepare_upload


@pytest.fixture(autouse=True)
def database_environment():
    # JPEG encoding runs entirely in the local recognition worker.
    pass


def test_sample_uses_upload_encoder_without_mutating_queue(tmp_path):
    capture = str(uuid4())
    folder = tmp_path / 'processed' / capture
    folder.mkdir(parents=True)
    image = np.random.default_rng(42).integers(0, 256, size=(184, 200), dtype=np.uint8)
    normalized = cv2.imencode('.png', image)[1].tobytes()
    (folder / 'normalized.png').write_bytes(normalized)
    args = {'capture_id': capture, 'normalized_sha256': sha256(normalized).hexdigest()}
    jpeg = folder / 'sheet.jpg'
    legacy = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 80, cv2.IMWRITE_JPEG_OPTIMIZE, 1])[1].tobytes()
    assert prepare_upload(tmp_path, args)['quality'] == 80 and jpeg.read_bytes() == legacy
    sizes = []
    for quality in (60, 80, 90):
        options = {**args, 'jpeg_quality': quality}
        before = jpeg.read_bytes()
        estimate = estimate_upload(tmp_path, options)
        assert jpeg.read_bytes() == before
        sent = prepare_upload(tmp_path, options)
        actual = jpeg.read_bytes()
        assert estimate == {'quality': quality, 'size': len(actual)}
        assert sent['sha256'] == sha256(actual).hexdigest()
        assert (folder / 'normalized.png').read_bytes() == normalized
        sizes.append(sent['size'])
    assert sizes[0] < sizes[1] < sizes[2]
    for value in (0, 75, '80', 80.0, True):
        with pytest.raises(ValueError, match='JPEG'):
            prepare_upload(tmp_path, {**args, 'jpeg_quality': value})
    with pytest.raises(ValueError, match='校验失败'):
        estimate_upload(tmp_path, {**args, 'normalized_sha256': '0' * 64})


def test_reference_works_before_first_scan(tmp_path):
    for paper in ('A3', 'A4'):
        sizes = [estimate_upload(tmp_path, {'reference_paper': paper, 'jpeg_quality': q})['size'] for q in (60, 80, 90)]
        assert 0 < sizes[0] < sizes[1] < sizes[2]
    assert not list(tmp_path.iterdir())
