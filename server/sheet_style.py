"""Print conventions for current editable answer sheets."""
STANDARD = 'standard-v2'
FOOTER = '请在各题目的答题区域内作答，超出黑色矩形边框限定区域的答案无效'


def enabled(template):
    return template.get('print_style') == STANDARD and template.get('layout_version', 2) >= 3


def defaults(template):
    template.setdefault('print_style', STANDARD)
    template.setdefault('notice_layout', 2)
    template.setdefault('candidate_length', 9)
    template.setdefault('forbidden_regions', [])


def header_geometry(template):
    count = template.get('candidate_length', 9)
    right = max(69, 21 + (count - 1) * 6)
    return {'left': 15, 'right': right, 'top': 35, 'bottom': 94, 'notice_left': right + 1}
