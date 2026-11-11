"""Bounded scanner evidence; server recognition remains authoritative."""
import json
import math
from fastapi import HTTPException

ISSUES = {
    'low_resolution': '页面分辨率不足', 'missing_binding': '缺少考卷版本绑定',
    'missing_qr': '二维码未读出', 'wrong_paper': '二维码与所选考卷或面不符',
    'multiple_qr': '混有多个题卡二维码', 'missing_markers': '四角定位标记不完整',
    'blur': '页面可能模糊', 'too_large': '上传文件超过30MB',
    'inspection_failed': '本地检查未完成',
}


def parse(value):
    try:
        if len(value) > 4096: raise ValueError()
        report = json.loads(value)
        if report == {}: return None  # Earlier clients have no local report.
        if not isinstance(report, dict): raise ValueError()
        issues = report['issues']
        if not isinstance(issues, list) or len(issues) > len(ISSUES) or any(not isinstance(i, str) or i not in ISSUES for i in issues): raise ValueError()
        metrics = {}
        for key in ('dpi', 'sharpness'):
            v = report[key]
            if type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 2_000_000: raise ValueError()
            metrics[key] = v
        if type(report['corners']) is not int or not 0 <= report['corners'] <= 4: raise ValueError()
        source = report['options']; options = {}
        for key in ('checkQr', 'checkCorners', 'checkSharpness'):
            if type(source[key]) is not bool: raise ValueError()
            options[key] = source[key]
        for key, low, high in (('minDpi', 100, 600), ('minSharpness', 0, 10000)):
            v = source[key]
            if type(v) not in (int, float) or not math.isfinite(v) or not low <= v <= high: raise ValueError()
            options[key] = v
        return {'issues': list(dict.fromkeys(issues)), **metrics, 'corners': report['corners'], 'options': options}
    except (ValueError, TypeError, KeyError, RecursionError):
        raise HTTPException(422, '本地质量检查记录无效')
