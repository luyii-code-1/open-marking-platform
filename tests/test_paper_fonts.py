from fastapi.testclient import TestClient
from reportlab.pdfbase import pdfmetrics
from server.main import app
from server.paper_fonts import FAMILIES,font_name


def test_print_families_embed_distinct_chinese_faces():
    names=[]
    for family in FAMILIES.values():
        for suffix in ('','-Bold','-Italic','-BoldItalic'):
            face=pdfmetrics.getFont(family+suffix).face
            names.append(face.name)
            assert ord('中') in face.charWidths
    assert len(set(names))==8
    assert font_name('宋体')==FAMILIES['OMP Serif']
    assert font_name('Arial')==FAMILIES['OMP Sans']


def test_editor_font_endpoint_is_limited_to_bundled_fonts(tmp_path,monkeypatch):
    from server import db
    monkeypatch.setattr(db,'ROOT',tmp_path)
    with TestClient(app) as client:
        response=client.get('/api/v1/paper-fonts/sans/400')
        assert response.status_code==200 and response.headers['content-type']=='font/ttf'
        assert response.content.startswith(b'\x00\x01\x00\x00')
        assert client.get('/api/v1/paper-fonts/unknown/400').status_code==404
        assert client.get('/api/v1/paper-fonts/serif/999').status_code==404
