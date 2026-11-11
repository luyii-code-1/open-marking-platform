import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db, storage
from server.main import app
from tests.test_archive_release import seed


def test_storage_change_uses_verified_archive_without_requesting_new_bucket(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setenv('OMP_STORAGE', 's3')
    monkeypatch.setenv('OMP_S3_BUCKET', 'original')
    remote = {}
    calls = []

    class S3:
        def upload_file(self, source, bucket, key):
            remote[key] = Path(source).read_bytes()

        def download_file(self, bucket, key, target):
            calls.append(bucket)
            Path(target).write_bytes(remote[key])

    monkeypatch.setattr(storage.Storage, 's3', lambda self: S3())
    with TestClient(app) as client:
        headers, project, page, _, _, _, content = seed(client, tmp_path)
        relative = 'pages/' + page['id'] + '.image'
        storage.mirror(relative, project['id'])
        response = client.post(f"/api/v1/projects/{project['id']}/archive", headers=headers)
        assert response.status_code == 200
        storage.local_path(relative).unlink()
        monkeypatch.setenv('OMP_S3_BUCKET', 'different')
        assert storage.materialize(relative).read_bytes() == content
        assert calls == []


@pytest.mark.parametrize('changed', ['OMP_S3_BUCKET', 'OMP_S3_ENDPOINT', 'OMP_STORAGE_PREFIX', 'OMP_STORAGE'])
def test_changed_storage_without_archive_refuses_wrong_location(tmp_path, monkeypatch, changed):
    monkeypatch.setattr(db, 'ROOT', tmp_path)
    monkeypatch.setenv('OMP_STORAGE', 's3')
    monkeypatch.setenv('OMP_S3_BUCKET', 'original')
    db.initialize()
    with db.connect() as connection:
        db.put(connection, 'storage-assets', {'relative': 'assets/missing.png', 'key': 'projects/example/assets/missing.png',
                                            'backend': 's3', 'location': storage.location(), 'status': 'stored'})
    monkeypatch.setenv(changed, 'webdav' if changed == 'OMP_STORAGE' else 'different')
    monkeypatch.setattr(storage.Storage, 'download', lambda *args: pytest.fail('Must not access another storage location'))
    with pytest.raises(FileNotFoundError, match='远端位置'):
        storage.materialize('assets/missing.png')


def test_failed_or_corrupt_download_does_not_publish_partial_bytes(tmp_path, monkeypatch):
    monkeypatch.setenv('OMP_STORAGE', 's3')
    monkeypatch.setenv('OMP_S3_BUCKET', 'original')
    destination = tmp_path / 'page.png'
    destination.write_bytes(b'valid-local-file')

    class S3:
        fail = False

        def download_file(self, bucket, key, target):
            Path(target).write_bytes(b'partial-or-corrupt')
            if self.fail:
                raise OSError('Disconnected')

    client = S3()
    monkeypatch.setattr(storage.Storage, 's3', lambda self: client)
    provider = storage.Storage()
    with pytest.raises(FileNotFoundError, match='版本不一致'):
        provider.download('page.png', destination, hashlib.sha256(b'expected').hexdigest())
    assert destination.read_bytes() == b'valid-local-file'
    assert list(tmp_path.glob('*.download')) == []
    client.fail = True
    with pytest.raises(OSError, match='Disconnected'):
        provider.download('page.png', destination)
    assert destination.read_bytes() == b'valid-local-file'
    assert list(tmp_path.glob('*.download')) == []
