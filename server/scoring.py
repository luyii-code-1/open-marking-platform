from decimal import Decimal, ROUND_HALF_UP


def cents(value):
    amount = Decimal(str(value))
    if not amount.is_finite():
        raise ValueError('分值必须为有限数值')
    return int((amount * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def objective_score(selected, answer, maximum, rule=None):
    selected, answer = set(selected), set(answer)
    rule = rule or {'mode': 'exact'}
    maximum = cents(maximum)
    if rule.get('mode','exact') == 'exact':
        return maximum if selected == answer else 0
    if rule['mode'] == 'partial':
        if selected - answer:
            return 0
        return maximum if selected == answer else min(maximum, cents(rule.get('partial_points',0))) if selected else 0
    if rule['mode'] == 'per_option':
        if rule.get('wrong_action','deduct')=='zero' and selected-answer:return 0
        return max(0,min(maximum,len(selected & answer)*cents(rule.get('correct_points',1))-len(selected-answer)*cents(rule.get('wrong_penalty',1))))
    raise ValueError('不支持的评分规则')


def final_score(values, mode='single', threshold=0):
    if not values:
        return None
    if mode == 'single':
        return values[0]
    if len(values) < 2:
        return None
    if abs(values[0]-values[1]) <= cents(threshold):
        return int((Decimal(values[0]+values[1])/2).quantize(Decimal('1'),rounding=ROUND_HALF_UP))
    return values[2] if len(values)>2 else None
