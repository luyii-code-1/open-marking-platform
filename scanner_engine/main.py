"""Authenticated loopback RPC; images stay in the owned local workspace."""
import argparse
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import socket
import struct
import sys
import threading
import uuid
import zipfile
from server.scan_files import write_atomic
import cv2
from server.omr import ENGINE_VERSION, absent_mark, code, decode, recognize, manual_binding, orient_scan

MAX_MESSAGE = 2 * 1024 * 1024


def digest(data): return hashlib.sha256(data).hexdigest()


def process(root, request):
    batch_id = str(uuid.UUID(request['batch_id'])); capture_id = str(uuid.UUID(request['capture_id']))
    template = request['template']; side = request['side']
    if side not in ('front', 'back'): raise ValueError('扫描面无效')
    source = (root / 'pages' / batch_id / (capture_id + '.jpg')).resolve()
    if not source.is_relative_to(root): raise ValueError('图像路径无效')
    content = source.read_bytes()
    if len(content) > 30 * 1024 * 1024 or digest(content) != request['source_sha256']: raise ValueError('本地原图校验失败')
    image, value = decode(content,template)
    if not manual_binding(template) and value != code(template, side): raise ValueError('二维码与当前题卡版本或扫描面不符')
    image = orient_scan(image, template, side)
    normalized, candidate, selections = recognize(image, template, side)
    encoded = cv2.imencode('.png', normalized)[1].tobytes(); entries = []
    directory = root / 'processed' / capture_id
    write_atomic(directory / 'normalized.png', encoded)
    packed = io.BytesIO()
    with zipfile.ZipFile(packed, 'w', zipfile.ZIP_STORED) as package:
        for question in template.get('questions', []):
            for index, region in enumerate(question.get('regions', [])):
                if region['page'] != (1 if side == 'front' else 2): continue
                x, y, w, h = (region[k] * 4 for k in ('x', 'y', 'width', 'height'))
                cut = normalized[int(y):int(y + h), int(x):int(x + w)]
                if cut.size == 0: raise ValueError('题目答题区无效')
                data = cv2.imencode('.png', cut)[1].tobytes()
                name = str(uuid.UUID(question['id'])) + '.' + str(index) + '.png'
                package.writestr(zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0)), data)
                entries.append({'entry': name, 'question_id': question['id'], 'region_index': index,
                                'region': region, 'sha256': digest(data), 'size': len(data),
                                'width': cut.shape[1], 'height': cut.shape[0]})
    cuts = packed.getvalue(); write_atomic(directory / 'cuts.zip', cuts)
    result = {'engine_version': ENGINE_VERSION, 'template_id': template['id'], 'template_revision': template['revision'],
              'config_sha256': request['config_sha256'], 'source_sha256': digest(content),
              'candidate_number': candidate, 'selections': selections, 'absent_mark': absent_mark(normalized, side, template),
              'absence_layout_known': 'notice_layout' in template or not manual_binding(template),
              'normalized_sha256': digest(encoded), 'local_cuts_sha256': digest(cuts), 'cuts': entries}
    write_atomic(directory / 'recognition.json', json.dumps(result, ensure_ascii=False).encode())
    return result


def receive(stream, count):
    value = bytearray()
    while len(value) < count:
        part = stream.recv(count - len(value))
        if not part: raise EOFError('RPC连接已关闭')
        value.extend(part)
    return bytes(value)


def serve(root, token):
    root = root.resolve(strict=True)
    cv2.setNumThreads(2)
    closed = threading.Event()
    def watch_parent():
        try:
            while os.read(sys.stdin.fileno(), 1): pass
        finally: closed.set()
    threading.Thread(target=watch_parent, daemon=True).start()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); listener.listen(2); listener.settimeout(1)
        print(json.dumps({'port': listener.getsockname()[1], 'protocol': 'omp-recognition-1'}), flush=True)
        while not closed.is_set():
            try: connection, _ = listener.accept()
            except TimeoutError:
                continue
            with connection:
                connection.settimeout(120)
                try:
                    size = struct.unpack('<I', receive(connection, 4))[0]
                    if not 0 < size <= MAX_MESSAGE: raise ValueError('RPC消息过大')
                    request = json.loads(receive(connection, size))
                    if not hmac.compare_digest(str(request.get('token', '')), token): raise ValueError('RPC认证失败')
                    method = request.get('method')
                    if method == 'stop':
                        response = {'ok': True, 'result': {}}
                    elif method == 'recognize': response = {'ok': True, 'result': process(root, request['args'])}
                    elif method == 'ping': response = {'ok': True, 'result': {'engine_version': ENGINE_VERSION}}
                    else: raise ValueError('不支持的识读命令')
                except (ValueError, KeyError, OSError, EOFError, cv2.error) as error:
                    response = {'ok': False, 'error': str(error)}; method = None
                encoded = json.dumps(response, ensure_ascii=False).encode()
                try: connection.sendall(struct.pack('<I', len(encoded)) + encoded)
                except OSError: pass
                if method == 'stop' and response['ok']: return


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--root', required=True, type=Path)
    options = parser.parse_args()
    # Secret arrives on an inherited pipe, never a command line or log.
    token = json.loads(sys.stdin.readline(4096)).get('token', '')
    if not isinstance(token, str) or len(token) != 64: raise ValueError('缺少本地会话凭据')
    serve(options.root, token)


if __name__ == '__main__': main()
