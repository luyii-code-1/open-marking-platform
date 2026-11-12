import { useState } from 'react'
import { Alert, Card, Input, InputNumber, Modal, Radio, Space, Table, Tag, Typography } from 'antd'
import { Button } from './Button'
import { useResource,type Row } from './api'

type Filters={actor:string;object_id:string;kind:string;status:number|null}
const empty:Filters={actor:'',object_id:'',kind:'',status:null}
export function AuditLog(){
  const [view,setView]=useState('audit'),[draft,setDraft]=useState<Filters>(empty),[applied,setApplied]=useState<Filters>(empty),[before,setBefore]=useState<number|undefined>(),[history,setHistory]=useState<number[]>([]),[detail,setDetail]=useState<Row|null>(null)
  const query=new URLSearchParams({limit:'50',...(before?{before:String(before)}:{}),...(applied.actor?{actor:applied.actor.trim()}:{}),...(applied.object_id?{object_id:applied.object_id.trim()}:{}),...(view==='audit'&&applied.kind?{kind:applied.kind.trim()}:{}),...(view==='requests'&&applied.status?{status:String(applied.status)}:{})})
  const resource=useResource<{items:Row[];next_before:number|null;writer_errors?:number}>(`/system/${view}?${query}`,{items:[],next_before:null},{live:false})
  function resetPage(){setBefore(undefined);setHistory([])}
  const actor={title:'操作人',dataIndex:'actor_name',render:(value:string,row:Row)=>value||row.actor||'系统 / 未登录'}
  const columns=view==='audit'?[{title:'时间',dataIndex:'created'},actor,{title:'操作',dataIndex:'action'},{title:'类型',dataIndex:'kind'},{title:'记录编号',dataIndex:'object_id',ellipsis:true},{title:'内容',render:(_:unknown,row:Row)=><Button onClick={()=>setDetail(row)}>查看快照</Button>}]:[{title:'时间',dataIndex:'created'},actor,{title:'方法',dataIndex:'method'},{title:'接口',dataIndex:'route'},{title:'状态',dataIndex:'status',render:(value:number)=><Tag color={value>=400?'red':'green'}>{value}</Tag>},{title:'处理耗时ms',dataIndex:'duration_ms'},{title:'来源',dataIndex:'peer'}]
  return <Card title="操作与访问日志" extra={<Button onClick={resource.reload}>刷新</Button>}>
    <Space direction="vertical" style={{width:'100%'}} size="middle">
      <Radio.Group value={view} onChange={e=>{setView(e.target.value);resetPage()}} options={[{label:'业务审计',value:'audit'},{label:'访问与失败请求',value:'requests'}]}/>
      <Space wrap><Input aria-label="按操作人编号筛选" placeholder="操作人UUID" value={draft.actor} style={{width:220}} onChange={e=>setDraft(v=>({...v,actor:e.target.value}))}/><Input aria-label="按记录编号筛选" placeholder="记录UUID" value={draft.object_id} style={{width:220}} onChange={e=>setDraft(v=>({...v,object_id:e.target.value}))}/>{view==='audit'?<Input aria-label="按业务类型筛选" placeholder="类型，如 tasks / pages" value={draft.kind} style={{width:200}} onChange={e=>setDraft(v=>({...v,kind:e.target.value}))}/>:<InputNumber aria-label="按HTTP状态筛选" placeholder="HTTP状态，如403" min={100} max={599} value={draft.status} onChange={status=>setDraft(v=>({...v,status}))}/>}<Button onClick={()=>{setApplied({...draft});resetPage()}}>筛选</Button><Button onClick={()=>{setDraft(empty);setApplied(empty);resetPage()}}>清除筛选</Button></Space>
      {resource.error&&<Alert type="error" message={resource.error}/>}
      {!!resource.data.writer_errors&&<Alert type="warning" message={`累计${resource.data.writer_errors}次访问日志写入失败，请检查服务器日志。`}/>}
      <Table rowKey="id" loading={resource.loading} dataSource={resource.data.items} columns={columns} pagination={false} scroll={{x:'max-content'}}/>
      <Space><Button disabled={!history.length} onClick={()=>{const pages=[...history],previous=pages.pop();setHistory(pages);setBefore(previous||undefined)}}>较新记录</Button><Button disabled={!resource.data.next_before} onClick={()=>{setHistory(v=>[...v,before||0]);setBefore(resource.data.next_before||undefined)}}>更早记录</Button><Typography.Text type="secondary">每次显示50条</Typography.Text></Space>
    </Space>
    <Modal title="业务操作快照" open={!!detail} onCancel={()=>setDetail(null)} footer={<Button onClick={()=>setDetail(null)}>关闭</Button>}><Typography.Paragraph>记录：{detail?.object_id} · 操作：{detail?.action}</Typography.Paragraph><pre style={{whiteSpace:'pre-wrap',wordBreak:'break-word',maxHeight:'60vh',overflow:'auto'}}>{JSON.stringify(detail?.body,null,2)}</pre></Modal>
  </Card>
}
