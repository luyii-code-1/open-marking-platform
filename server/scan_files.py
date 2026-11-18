"""Durable image writes and the files belonging to one captured page."""
import os
from uuid import uuid4


def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    try:
        with temporary.open('xb') as stream: stream.write(data); stream.flush(); os.fsync(stream.fileno())
        temporary.replace(path)
    finally: temporary.unlink(missing_ok=True)


def page_suffixes(page):
    if page.get('upload_format') == 'jpeg-sheet-1': return ('.jpg',)
    return ('.image', '.png', '.cuts.zip') if page.get('local_cuts_sha256') else ('.image', '.png')


def normalized_relative(page):
    suffix = '.jpg' if page.get('upload_format') == 'jpeg-sheet-1' else '.png'
    return 'pages/' + page['id'] + suffix


def hash_field(suffix):
    return {'.png': 'normalized_sha256', '.jpg': 'normalized_sha256', '.cuts.zip': 'local_cuts_sha256'}.get(suffix, 'sha256')
