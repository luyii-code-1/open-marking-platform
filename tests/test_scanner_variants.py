from pathlib import Path
from fastapi.testclient import TestClient
from server import db
from server.main import app
from tools.publish_scanner_distribution import publish


def test_independent_webview_and_electron_downloads(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'ROOT',tmp_path/'data')
    monkeypatch.delenv('OMP_SCANNER_DISTRIBUTION',raising=False)
    source=tmp_path/'source';source.mkdir()
    original=source/'scanner-webview2.exe';original.write_bytes(b'webview2-installer')
    compatible=source/'scanner-electron.exe';compatible.write_bytes(b'electron-installer')
    distribution=tmp_path/'data/scanner-distribution'
    publish(original,distribution,'test-webview2');publish(compatible,distribution/'electron','test-electron')
    with TestClient(app) as client:
        account={'username':'admin','name':'管理员','password':'administrator-test-password'}
        client.post('/api/v1/auth/bootstrap',json=account)
        headers={'Authorization':'Bearer '+client.post('/api/v1/auth/login',json=account).json()['token']}
        urls={}
        for variant,path in (('webview2',original),('electron',compatible)):
            info=client.get('/api/v1/scanner/distribution',params={'variant':variant},headers=headers)
            assert info.status_code==200 and info.json()['file']==path.name and info.json()['available']
            response=client.post('/api/v1/scanner/download-link',json={'variant':variant},headers=headers)
            assert response.status_code==200
            urls[variant]=response.json()['url']
            download=client.get(urls[variant]);assert download.status_code==200 and download.content==path.read_bytes()
        # Publishing either installer only invalidates tickets for that installer.
        next_file=source/'scanner-webview2-next.exe';next_file.write_bytes(b'next-webview2')
        publish(next_file,distribution,'next-webview2')
        assert client.get(urls['webview2']).status_code==409
        assert client.get(urls['electron']).content==compatible.read_bytes()
        legacy=client.post('/api/v1/scanner/download-link',headers=headers)
        assert legacy.status_code==200 and client.get(legacy.json()['url']).content==next_file.read_bytes()
        assert client.get('/api/v1/scanner/distribution?variant=other',headers=headers).status_code==422
        assert client.post('/api/v1/scanner/download-link',json={'variant':'../other'},headers=headers).status_code==422
