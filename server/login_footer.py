"""Administrator-managed HTML shown on the public login screen."""
import re
from html import escape
from html.parser import HTMLParser
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .db import connect, find, put
from .dependencies import system_admin

router = APIRouter(prefix='/api/v1')
TAGS = {'p', 'div', 'span', 'br', 'a', 'img', 'small', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li'}
VOID = {'br', 'img'}
DROP = {'script', 'style', 'iframe', 'object', 'svg', 'math', 'template', 'noscript', 'textarea', 'title', 'xmp'}
CHOICES = {
    'text-align': {'left', 'center', 'right', 'justify'},
    'display': {'block', 'inline', 'inline-block', 'flex', 'inline-flex'},
    'align-items': {'center', 'flex-start', 'flex-end', 'baseline'},
    'justify-content': {'center', 'flex-start', 'flex-end', 'space-between'},
    'flex-wrap': {'wrap', 'nowrap'},
    'font-weight': {'normal', 'bold', '400', '500', '600', '700'},
    'text-decoration': {'none', 'underline'},
}


def safe_url(value, image=False):
    value = value.strip()
    if '\\' in value or any(ord(c) < 32 for c in value):
        return ''
    if value.startswith('/') and not value.startswith('//'):
        return value
    if not image and value.startswith('#'):
        return value
    try:
        parsed = urlsplit(value)
        if parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password:
            return value
    except ValueError:
        pass
    return ''


def clean_style(value):
    rules = []
    for declaration in value.split(';'):
        name, separator, css = declaration.partition(':')
        name, css = name.strip().lower(), css.strip().lower()
        if not separator:
            continue
        allowed = css in CHOICES.get(name, set())
        if name == 'color':
            allowed = bool(re.fullmatch(r'#[0-9a-f]{3,8}|[a-z]{1,20}', css))
        if name in ('font-size', 'line-height', 'gap', 'margin', 'margin-top', 'margin-bottom', 'padding'):
            allowed = bool(re.fullmatch(r'(?:\d{1,2}(?:\.\d{1,2})?(?:px|pt|em)|0|[1-3](?:\.\d{1,2})?)(?: (?:\d{1,2}(?:\.\d{1,2})?(?:px|pt|em)|0)){0,3}', css))
        if allowed:
            rules.append(name + ':' + css)
    return ';'.join(rules)


class FooterHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output = []
        self.open_tags = []
        self.blocked = []

    def handle_starttag(self, tag, attributes):
        if tag in DROP:
            self.blocked.append(tag)
        if self.blocked or tag not in TAGS:
            return
        attrs = dict(attributes)
        retained = {}
        if attrs.get('title'):
            retained['title'] = attrs['title']
        style = clean_style(attrs.get('style') or '')
        if style:
            retained['style'] = style
        if tag == 'a':
            href = safe_url(attrs.get('href') or '')
            if href:
                retained.update(href=href, target='_blank', rel='noopener noreferrer')
        if tag == 'img':
            src = safe_url(attrs.get('src') or '', image=True)
            if not src:
                return
            retained.update(src=src, alt=attrs.get('alt') or '', loading='lazy')
            for dimension in ('width', 'height'):
                raw = attrs.get(dimension) or ''
                if len(raw) <= 4 and raw.isascii() and raw.isdigit() and 0 < int(raw) <= 4096:
                    retained[dimension] = raw
        attributes = ''.join(f' {name}="{escape(value, quote=True)}"' for name, value in retained.items())
        self.output.append(f'<{tag}{attributes}>')
        if tag not in VOID:
            self.open_tags.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.blocked:
            if tag == self.blocked[-1]:
                self.blocked.pop()
            return
        if tag in self.open_tags:
            index = len(self.open_tags) - 1 - self.open_tags[::-1].index(tag)
            self.output.extend(f'</{name}>' for name in reversed(self.open_tags[index:]))
            del self.open_tags[index:]

    def handle_data(self, value):
        if not self.blocked:
            self.output.append(escape(value))


def clean_html(value):
    parser = FooterHTML()
    parser.feed(value)
    parser.close()
    parser.output.extend(f'</{tag}>' for tag in reversed(parser.open_tags))
    return ''.join(parser.output).strip()


class FooterInput(BaseModel):
    html: str = Field(max_length=20000)


def saved_footer(db):
    matches = find(db, 'site-settings', key='login-footer')
    return matches[0] if matches else {}


@router.get('/public/login-footer')
def public_footer():
    with connect() as db:
        saved = saved_footer(db)
    return JSONResponse({'html': saved.get('html', '')}, headers={'Cache-Control': 'no-store'})


@router.get('/system/login-footer')
def footer_settings(current=Depends(system_admin)):
    with connect() as db:
        saved = saved_footer(db)
    return {'html': saved.get('source_html', ''), 'rendered_html': saved.get('html', '')}


@router.post('/system/login-footer/preview')
def preview_footer(body: FooterInput, current=Depends(system_admin)):
    return {'html': clean_html(body.html)}


@router.put('/system/login-footer')
def save_footer(body: FooterInput, current=Depends(system_admin)):
    rendered = clean_html(body.html)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        saved = saved_footer(db)
        put(db, 'site-settings', {**saved, 'key': 'login-footer', 'source_html': body.html, 'html': rendered}, current['id'])
    return {'html': body.html, 'rendered_html': rendered}
