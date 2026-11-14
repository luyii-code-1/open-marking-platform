import {RoomBatch} from './RoomBatch'
import {DeleteRecord} from './DeleteRecord'
import { useEffect,useState } from 'react'
import { App,Card,Form,Input,InputNumber,Modal,Select,Space,Tag,Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { send,useResource,type Row } from './api'
import { ErrorNotice } from './EntityTable'

export function RoomTagBadges({tags}:{tags?:Row[]}){return <Space size={[0,4]} wrap>{(tags||[]).map(t=><Tag key={t.id}>{t.label||[t.grade_name,t.name].filter(Boolean).join('－')}</Tag>)}</Space>}

export function RoomTagPicker({projectId,groupId,value,onChange,multiple=false}:{projectId?:string;groupId?:string;value?:any;onChange?:(value:any)=>void;multiple?:boolean}){
  const groups=useResource<Row[]>(groupId?'/groups':null,[]),subjects=useResource<Row[]>(groupId?'/subjects':null,[])
  const group=groups.data.find(g=>g.id===groupId),subject=subjects.data.find(s=>s.id===group?.subject_id),scope=projectId||subject?.project_id
  const projects=useResource<Row[]>(!scope&&!groupId?'/projects':null,[])
  const params=new URLSearchParams({...scope?{project_id:scope}:{},...group?.grade_id?{group_id:group.id}:{}})
  const tags=useResource<Row[]>(groupId&&!scope?null:`/room-tags?${params}`,[]),single=multiple&&!!group?.grade_id
  return <Select mode={multiple&&!single?'multiple':undefined} allowClear showSearch optionFilterProp="label" style={{minWidth:200,maxWidth:'100%'}} placeholder={multiple?'选择年级－考场':'全部考场'} value={single?value?.[0]:value||undefined} loading={tags.loading} onChange={v=>onChange?.(single?(v?[v]:[]):v)} options={tags.data.filter(t=>!multiple||!t.archived).map(t=>({value:t.id,label:(scope?'':`${projects.data.find(p=>p.id===t.project_id)?.name||''} / `)+(t.label||t.name)}))}/>
}

export function RoomTagManager({projectId,groupId}:{projectId:string;groupId?:string}){
  const tags=useResource<Row[]>(`/room-tags?project_id=${projectId}${groupId?'&group_id='+groupId:''}`,[]),groups=useResource<Row[]>('/groups',[]),subjects=useResource<Row[]>('/subjects',[]),grades=useResource<Row[]>('/grades',[])
  const [open,setOpen]=useState(false),[selected,setSelected]=useState<Row|null>(null),[busy,setBusy]=useState(false),[form]=Form.useForm(),{message}=App.useApp()
  const groupIds=new Set(subjects.data.filter(s=>s.project_id===projectId).map(s=>s.id)),available=groups.data.filter(g=>groupIds.has(g.subject_id)&&g.grade_id&&(!groupId||g.id===groupId))
  const chosenId=Form.useWatch('group_id',form),chosen=groups.data.find(g=>g.id===chosenId)
  useEffect(()=>{if(open)form.setFieldsValue(selected||{group_id:groupId,name:'',expected_students:0})},[open,selected,groupId,form])
  async function save(body:object){setBusy(true);try{await send(selected?`/room-tags/${selected.id}`:`/projects/${projectId}/room-tags`,body,selected?'PUT':'POST');await tags.reload();setOpen(false)}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  async function archive(row:Row){setBusy(true);try{await send(`/room-tags/${row.id}`,{archived:!row.archived},'PUT');await tags.reload()}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  return <Card title="考场设置" extra={<Space><RoomBatch projectId={projectId} groupId={groupId} tags={tags.data} reload={tags.reload} options={available.map(g=>({value:g.id,label:`${subjects.data.find(s=>s.id===g.subject_id)?.name||''} / ${g.name} · ${grades.data.find(x=>x.id===g.grade_id)?.name||''}`}))}/><Button onClick={tags.reload}>刷新进度</Button><Button type="primary" disabled={busy||!available.length} onClick={()=>{setSelected(null);form.resetFields();setOpen(true)}}>添加考场</Button></Space>}>
    <ErrorNotice error={tags.error||groups.error||subjects.error||grades.error} retry={tags.reload}/>
    <Typography.Paragraph type="secondary">每个考场使用一份题卡。同一考场号可用于不同题卡；实考人数按已确认答卷去重统计，待配对与异常页面另行显示。</Typography.Paragraph>
    {!available.length&&<Typography.Paragraph>请先在题卡的“应考名单”中设置所属年级。</Typography.Paragraph>}
    <Table rowKey="id" dataSource={tags.data} loading={tags.loading} pagination={{defaultPageSize:50}} columns={[{title:'年级',render:(_,row)=>row.grade_name||'待归类'},{title:'科目 / 题卡',render:(_,row)=>{const g=groups.data.find(g=>g.id===row.group_id);return g?`${subjects.data.find(s=>s.id===g.subject_id)?.name||''} / ${g.name}`:'历史标签'}},{title:'考场',dataIndex:'name'},{title:'预期',dataIndex:'expected_students',render:v=>v??'—'},{title:'已确认实考',dataIndex:'scanned_students'},{title:'待扫描',dataIndex:'remaining_students',render:(v,row)=>row.over_expected?`超出 ${row.over_expected}`:v??'—'},{title:'待配对 / 异常页',render:(_,row)=>`${row.pending_pages||0} / ${row.exception_pages||0}`},{title:'状态',render:(_,row)=>row.archived?'已停用':'使用中'},{title:'操作',render:(_,row)=><Space><Button disabled={busy} onClick={()=>{setSelected(row);form.resetFields();setOpen(true)}}>编辑</Button><Button disabled={busy} onClick={()=>archive(row)}>{row.archived?'启用':'停用'}</Button><DeleteRecord kind="room-tags" row={row} reload={tags.reload}/></Space>}]} scroll={{x:'max-content'}}/>
    <Modal title={selected?'编辑考场':'添加考场'} open={open} onCancel={()=>setOpen(false)} onOk={()=>form.submit()} confirmLoading={busy} destroyOnHidden><Form form={form} layout="vertical" onFinish={save}>
      <Form.Item label="所属题卡" name="group_id" rules={[{required:true,message:'请选择题卡'}]}><Select disabled={!!selected?.group_id||!!groupId} showSearch optionFilterProp="label" options={available.map(g=>({value:g.id,label:`${subjects.data.find(s=>s.id===g.subject_id)?.name||''} / ${g.name} · ${grades.data.find(x=>x.id===g.grade_id)?.name||''}`}))}/></Form.Item>
      <Form.Item label="年级"><Input readOnly value={grades.data.find(g=>g.id===chosen?.grade_id)?.name||''}/></Form.Item>
      <Form.Item label="考场号 / 名称" name="name" rules={[{required:true,whitespace:true,max:60}]}><Input maxLength={60}/></Form.Item><Form.Item label="预期人数" name="expected_students" rules={[{required:true,type:'integer',min:0,max:100000}]}><InputNumber min={0} max={100000} precision={0}/></Form.Item>
    </Form></Modal>
  </Card>
}
