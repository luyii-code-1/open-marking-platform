"""Serve public files from the immutable web build shipped with each API worker."""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re

from starlette._utils import get_route_path
from starlette.datastructures import Headers, URL
from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, RedirectResponse, Response
from starlette.staticfiles import NotModifiedResponse, StaticFiles


_ENTRIES = {'/index.html', '/scanner.html', '/worker.js', '/version.json', '/manifest.webmanifest'}
_ASSET_PREFIXES = ('/assets/', '/icons/', '/branding/', '/licenses/')
_HASHED = re.compile(r'assets/(?:[^/]+/)*[^/]+-[\w-]{8,}\.[A-Za-z0-9.]+', re.ASCII)
_MEMORY_LIMIT = 256 * 1024  # per shell entry/encoding; never buffer the application bundles
_QUAL = re.compile(r'(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\Z', re.ASCII)


def _immutable_files(directory):
    try:
        manifest = json.loads((directory / '.vite' / 'manifest.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return set()
    files = set()
    for entry in manifest.values() if isinstance(manifest, dict) else ():
        if not isinstance(entry, dict):
            continue
        paths = [entry.get('file')]
        for key in ('css', 'assets'):
            if isinstance(entry.get(key), list):
                paths.extend(entry[key])
        files.update('/' + path for path in paths if isinstance(path, str) and _HASHED.fullmatch(path))
    return files


@dataclass(frozen=True)
class Representation:
    file: FileResponse
    body: bytes | None
    not_modified: NotModifiedResponse


def _representation(path, *, keep, cache_control, media_type=None, encoding=None):
    with path.open('rb') as stream:
        stat = os.fstat(stream.fileno())
        if keep and stat.st_size <= _MEMORY_LIMIT:
            body = stream.read()
            digest = hashlib.sha256(body).hexdigest()
        else:
            body = None
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    headers = {'etag': f'"{digest}"', 'cache-control': cache_control, 'vary': 'Accept-Encoding'}
    if encoding:
        headers['content-encoding'] = encoding
    file = FileResponse(path, stat_result=stat, media_type=media_type, headers=headers)
    return digest, Representation(file, body, NotModifiedResponse(file.headers))


def _choose(representations, headers, byte_range):
    offered = headers.getlist('accept-encoding')
    if not offered:
        return representations['identity']
    weights = {}
    for token in ','.join(offered).lower().split(','):
        name, _, parameter = token.strip().partition(';')
        weight = 1.0
        if parameter:
            key, _, value = parameter.strip().partition('=')
            value = value.strip()
            weight = float(value) if key.strip() == 'q' and _QUAL.fullmatch(value) else 0.0
        weights[name.strip()] = weight
    # An unlisted identity is a fallback unless explicitly excluded by "*;q=0".
    identity = weights.get('identity', 0)
    identity_allowed = identity > 0 if 'identity' in weights else weights.get('*') != 0
    acceptable = [(weights.get(enc, weights.get('*', 0)) if enc != 'identity' else identity, rep)
                  for enc, rep in representations.items()]
    if byte_range and identity_allowed:
        validator = headers.get('if-range')
        if validator:
            for weight, rep in acceptable:
                if weight > 0 and rep.file.headers['etag'] == validator:
                    return rep
        return representations['identity']
    # Insertion order breaks ties: Brotli, gzip, then identity.
    weight, selected = max(acceptable, key=lambda pair: pair[0])
    if weight > 0:
        return selected
    return representations['identity'] if identity_allowed else None


class WebStaticFiles(StaticFiles):
    def __init__(self, directory):
        super().__init__(directory=directory, html=True)
        root = Path(directory).resolve()
        encoded = root / '.http-enc'
        has_encodings = encoded.is_dir() and not encoded.is_symlink()
        immutable = _immutable_files(root)
        self.files = {}
        for folder, directories, names in os.walk(root):
            base = Path(folder)
            directories[:] = [name for name in directories if not name.startswith('.')
                              and not (base / name).is_symlink() and (base != root or name != 'api')]
            for name in names:
                path = base / name
                if name.startswith('.') or path.is_symlink() or not path.is_file():
                    continue
                url = '/' + path.relative_to(root).as_posix()
                keep = url in _ENTRIES
                cache = 'public, max-age=31536000, immutable' if url in immutable else 'no-cache'
                digest, original = _representation(path, keep=keep, cache_control=cache)
                variants = {}
                for encoding, suffix in [('br', '.br'), ('gzip', '.gz')]:
                    sidecar = encoded / (digest + suffix)
                    if has_encodings and not sidecar.is_symlink() and sidecar.is_file():
                        _, variants[encoding] = _representation(
                            sidecar, keep=keep, cache_control=cache, media_type=original.file.media_type, encoding=encoding)
                self.files[url] = {**variants, 'identity': original}
        if '/index.html' in self.files:
            self.files['/'] = self.files['/index.html']

    def select(self, variants, scope):
        headers = Headers(scope=scope)
        byte_range = scope['method'] == 'GET' and 'range' in headers
        rep = _choose(variants, headers, byte_range)
        if rep is None:
            return Response(status_code=406, headers={'vary': 'Accept-Encoding', 'cache-control': 'no-store'})
        validators = headers.getlist('if-none-match')
        if validators:
            tag = rep.file.headers['etag']
            if any(value.strip().removeprefix('W/') in ('*', tag) for value in ','.join(validators).split(',')):
                return rep.not_modified
        elif 'if-modified-since' in headers and self.is_not_modified(rep.file.headers, headers):
            return rep.not_modified
        if byte_range:
            # A separate response owns the range state/headers for each concurrent transfer.
            return FileResponse(rep.file.path, stat_result=rep.file.stat_result, headers=rep.file.headers)
        if rep.body is None and scope['method'] != 'HEAD':
            return rep.file
        response = Response(content=b'' if scope['method'] == 'HEAD' else rep.body)
        response.raw_headers = rep.file.raw_headers
        return response

    async def get_response(self, path, scope):
        # Look up the immutable release index even on the legacy catch-all mount.
        # Its filesystem may also contain private build metadata and encoding variants.
        if scope['method'] not in ('GET', 'HEAD'):
            raise HTTPException(405, headers={'Allow': 'GET, HEAD'})
        url = '/' if path == '.' else '/' + Path(path).as_posix()
        if variants := self.files.get(url):
            return self.select(variants, scope)
        if variants := self.files.get(url.rstrip('/') + '/index.html'):
            if not scope['path'].endswith('/'):
                request_url = URL(scope=scope)
                return RedirectResponse(request_url.replace(path=request_url.path + '/'))
            return self.select(variants, scope)
        if variants := self.files.get('/404.html'):
            file = variants['identity'].file
            return FileResponse(file.path, stat_result=file.stat_result, status_code=404)
        raise HTTPException(404)


class PublicAssetMiddleware:
    """Resolve known web routes inside the WAF and request journal, before the API router."""
    def __init__(self, app, files):
        self.app = app
        self.files = files
        self.paths = {path: item for path, item in files.files.items()
                      if path == '/' or path in _ENTRIES or path.startswith(_ASSET_PREFIXES)}

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http' and scope['method'] in ('GET', 'HEAD'):
            variants = self.paths.get(get_route_path(scope))
            if variants is not None:
                response = self.files.select(variants, scope)
                return await response(scope, receive, send)
        return await self.app(scope, receive, send)
