"""Versioned identifiers for each scanned answer, distinct from review tasks."""
from .db import get,put


def sync(db,submission,template,actor=None):
    mapping=dict(submission.get('answer_slice_ids',{}))
    for question in template.get('questions',[]):
        override=submission.get('region_overrides',{}).get(question['id'],{})
        if not submission.get('pages') and not override.get('asset_id'):continue
        sources=[]
        if not override.get('asset_id'):
            for region in override.get('regions',question.get('regions',[])):
                index=int(region['page'])-1
                if not 0<=index<len(submission['pages']):continue
                page=get(db,submission['pages'][index],'pages')
                sources.append({'page_id':submission['pages'][index],'region':dict(region),'normalized_sha256':(page or {}).get('normalized_sha256')})
        content={'sources':sources,'asset_id':override.get('asset_id')}
        previous=get(db,mapping.get(question['id']),'answer-slices')
        if previous and all(previous.get(k)==v for k,v in content.items()):continue
        value=put(db,'answer-slices',{'submission_id':submission['id'],'group_id':submission['group_id'],'template_id':template['id'],
            'question_id':question['id'],'question_number':question.get('number'),**content,'previous_id':previous['id'] if previous else None,'status':'current'},actor)
        if previous:
            previous.update(status='superseded',superseded_by=value['id']);put(db,'answer-slices',previous,actor)
        mapping[question['id']]=value['id']
    if mapping!=submission.get('answer_slice_ids',{}):
        submission={**submission,'answer_slice_ids':mapping}
        return put(db,'submissions',submission,actor)
    return submission
