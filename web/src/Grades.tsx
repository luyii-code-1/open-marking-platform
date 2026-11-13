import { useState } from 'react'
import { App, Input, Modal, Space, Tag } from 'antd'
import { Button } from './Button'
import { EntityTable } from './EntityTable'
import { send,useResource,type Row } from './api'

export function Grades(){
  const grades=useResource<Row[]>('/grades',[]),[editing,setEditing]=useState<Row|null>(null),[name,setName]=useState(''),[busy,setBusy]=useState(false),{message}=App.useApp()
  async function update(row:Row,body:object){setBusy(true);try{await send(`/grades/${row.id}`,body,'PUT');await grades.reload();setEditing(null)}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  return <><EntityTable path="/grades" title="年级" resource={grades} fields={[{name:'name',label:'年级名称'}]} columns={[{title:'年级',dataIndex:'name'},{title:'状态',render:(_,row)=><Tag>{row.archived?'已停用':'使用中'}</Tag>},{title:'操作',render:(_,row)=><Space><Button disabled={busy} onClick={()=>{setEditing(row);setName(row.name)}}>修改名称</Button><Button disabled={busy} onClick={()=>update(row,{archived:!row.archived})}>{row.archived?'启用':'停用'}</Button></Space>}]} /><Modal title="修改年级名称" open={!!editing} onCancel={()=>setEditing(null)} confirmLoading={busy} onOk={()=>editing&&update(editing,{name})}><Input value={name} maxLength={60} onChange={event=>setName(event.target.value)}/></Modal></>
}
