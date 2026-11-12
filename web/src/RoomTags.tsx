import { Button } from './Button'
import { useState } from 'react'
import { App, Card, Form, Input, Modal, Select, Space, Table, Tag } from 'antd'
import { send, useResource, type Row } from './api'
import { ErrorNotice } from './EntityTable'

export function RoomTagBadges({tags}:{tags?:Row[]}) {return <Space size={[0,4]} wrap>{(tags||[]).map(t=><Tag key={t.id}>{t.name}</Tag>)}</Space>}

export function RoomTagPicker({projectId,groupId,value,onChange,multiple=false}:{projectId?:string;groupId?:string;value?:any;onChange?:(value:any)=>void;multiple?:boolean}) {
  const groups=useResource<Row[]>(groupId?'/groups':null,[]),subjects=useResource<Row[]>(groupId?'/subjects':null,[])
  const subject=subjects.data.find(s=>s.id===groups.data.find(g=>g.id===groupId)?.subject_id)
  const scope=projectId||subject?.project_id
  const projects=useResource<Row[]>(!scope&&!groupId?'/projects':null,[])
  const tags=useResource<Row[]>(groupId&&!scope?null:`/room-tags${scope?'?project_id='+encodeURIComponent(scope):''}`,[])
  return <Select mode={multiple?'multiple':undefined} allowClear showSearch optionFilterProp="label" style={{minWidth:200,maxWidth:'100%'}} placeholder={multiple?'选择考场标签':'全部考场标签'} value={value||undefined} loading={tags.loading} onChange={onChange} options={tags.data.filter(t=>!multiple||!t.archived||(value||[]).includes(t.id)).map(t=>({value:t.id,label:scope?t.name:`${projects.data.find(p=>p.id===t.project_id)?.name||''} / ${t.name}`}))}/>
}

export function RoomTagManager({projectId}:{projectId:string}) {
  const tags=useResource<Row[]>('/room-tags?project_id='+projectId,[]),[name,setName]=useState(''),[selected,setSelected]=useState<Row|null>(null),[newName,setNewName]=useState(''),[busy,setBusy]=useState(false),{message}=App.useApp()
  async function add(){if(!name.trim())return;setBusy(true);try{await send(`/projects/${projectId}/room-tags`,{name});setName('');await tags.reload()}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  async function update(row:Row,body:object){try{await send(`/room-tags/${row.id}`,body,'PUT');await tags.reload();setSelected(null)}catch(e){message.error((e as Error).message)}}
  return <Card title="考场标签"><ErrorNotice error={tags.error} retry={tags.reload}/><Space direction="vertical" size={24} style={{width:'100%',maxWidth:720}}><Form layout="inline" onFinish={add}><Form.Item><Input value={name} maxLength={60} onChange={e=>setName(e.target.value)} placeholder="例如：第一考场"/></Form.Item><Form.Item><Button type="primary" htmlType="submit" loading={busy}>添加标签</Button></Form.Item></Form><Table rowKey="id" dataSource={tags.data} loading={tags.loading} pagination={{defaultPageSize:10}} columns={[{title:'名称',dataIndex:'name'},{title:'状态',render:(_,row)=>row.archived?'已停用':'使用中'},{title:'操作',render:(_,row)=><Space><Button onClick={()=>{setSelected(row);setNewName(row.name)}}>修改名称</Button><Button onClick={()=>update(row,{archived:!row.archived})}>{row.archived?'启用':'停用'}</Button></Space>}]}/></Space><Modal title="修改标签名称" open={!!selected} onCancel={()=>setSelected(null)} onOk={()=>selected&&update(selected,{name:newName})}><Input value={newName} maxLength={60} onChange={e=>setNewName(e.target.value)}/></Modal></Card>
}
