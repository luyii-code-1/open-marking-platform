import {useState} from 'react'
import {Card,Empty,Input,Modal,Space,Tabs} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {useResource,type Row} from './api'
import {AssetImage} from './components'
import {ErrorNotice} from './EntityTable'

export function SheetLookup({projectId,groupId}:{projectId:string;groupId?:string}){
  const [term,setTerm]=useState(''),[page,setPage]=useState(1),[sheet,setSheet]=useState<Row|null>(null)
  const params=new URLSearchParams({q:term,page:String(page)})
  if(groupId)params.set('group_id',groupId)
  const result=useResource<{items:Row[];total:number}>(term?`/projects/${projectId}/scanned-sheets?${params}`:null,{items:[],total:0})
  return <Card title="答题卡查询"><Space direction="vertical" style={{width:'100%'}}>
    <Input.Search className="list-search" placeholder="输入姓名或准考证号" aria-label="搜索已入库答卷" maxLength={100} allowClear enterButton="查询" onSearch={value=>{setPage(1);setTerm(value.trim());setSheet(null)}}/>
    <ErrorNotice error={result.error} retry={result.reload}/>
    {term&&<Table rowKey="id" query="" loading={result.loading} dataSource={result.data.items} totalRows={result.data.total}
      pagination={{current:page,pageSize:20,total:result.data.total,showSizeChanger:false,onChange:setPage}} locale={{emptyText:'未找到匹配的已入库答卷'}}
      columns={[{title:'姓名',dataIndex:'name'},{title:'准考证号',dataIndex:'candidate_number'},{title:'科目',dataIndex:'subject'},{title:'题卡',dataIndex:'card'},
      {title:'操作',render:(_,row)=><Button type="link" onClick={()=>setSheet(row)}>查看答卷</Button>}]}/>}
  </Space><Modal title={sheet&&`${sheet.name} · ${sheet.candidate_number} · ${sheet.subject}`} width={900} open={!!sheet} onCancel={()=>setSheet(null)} footer={null}>
    {sheet?.pages.length?<Tabs key={sheet.id} items={sheet.pages.map((p:Row)=>({key:p.id,label:p.side==='back'?'背面':'正面',children:<AssetImage src={p.image_url}/>}))}/>:<Empty description="暂无扫描图像"/>}
  </Modal></Card>
}
