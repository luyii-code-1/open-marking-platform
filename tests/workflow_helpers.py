def close_scanning(client,group_id,headers=None):
    base='/api/v1/groups/'+group_id
    roster=client.get(base+'/roster',headers=headers).json()
    if not roster['configured']:return
    result=client.post(base+'/roster/review',headers=headers,json={'student_ids':[s['id'] for s in roster['students']]})
    assert result.status_code==200,result.text
    state=client.get(base+'/workflow',headers=headers).json()
    result=client.post(base+'/scan-close',headers=headers,json={'confirm':True,'signature':state['scan_signature']})
    assert result.status_code==200,result.text
