import {useState} from 'react'
import {Card,Modal,Space,Tag} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {SheetLookup} from './SheetLookup'
import {ErrorNotice} from './EntityTable'
import {useResource,type Row} from './api'

const statuses=[{value:'pending',label:'待结分'},{value:'completed',label:'已完成'},{value:'absent',label:'缺考'},{value:'unscanned',label:'未扫描'}]
export function AnswerPool({groupId,projectId}:{groupId:string;projectId:string}){
  const resource=useResource<Row[]>(`/results?group_id=${groupId}`,[]),[candidate,setCandidate]=useState('')
  const classes=[...new Map(resource.data.map(row=>[row.class_id,{value:row.class_id,label:row.class_name}])).values()]
  return <><Card title="答卷池" extra={<Button loading={resource.loading} onClick={resource.reload}>刷新</Button>}>
    <ErrorNotice error={resource.error} retry={resource.reload}/>
    <Space wrap style={{marginBottom:12}}>{statuses.map(status=><Tag key={status.value}>{status.label} {resource.data.filter(row=>row.status===status.value).length} 份</Tag>)}</Space>
    <Table<Row> rowKey="student_id" loading={resource.loading} dataSource={resource.data} filterFields={[
      {key:'class',label:'班级',options:classes,values:row=>[row.class_id]},
      {key:'status',label:'状态',options:statuses,values:row=>[row.status]},
    ]} columns={[
      {title:'准考证号',dataIndex:'candidate_number'},
      {title:'姓名',dataIndex:'name'},
      {title:'年级',dataIndex:'grade'},
      {title:'班级',dataIndex:'class_name'},
      {title:'状态',dataIndex:'status',render:value=><Tag color={value==='completed'?'green':value==='pending'?'blue':undefined}>{statuses.find(s=>s.value===value)?.label||value}</Tag>},
      {title:'已结分小题',render:(_,row)=>`${Object.values(row.scores||{}).filter(score=>score!==null).length} / ${Object.keys(row.scores||{}).length}`},
      {title:'总分',dataIndex:'total',render:value=>value??'待结分'},
      {title:'操作',render:(_,row)=><Button type="link" disabled={row.status==='unscanned'} onClick={()=>setCandidate(row.scanned_candidate_number||row.candidate_number)}>查看答卷</Button>},
    ]}/>
  </Card><Modal title="答卷查询" width="80vw" open={!!candidate} onCancel={()=>setCandidate('')} footer={null}>{candidate&&<SheetLookup key={candidate} projectId={projectId} groupId={groupId} initialQuery={candidate}/>}</Modal></>
}
