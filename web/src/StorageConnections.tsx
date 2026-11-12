import { useEffect, useState } from 'react'
import { Alert, App, Card, Collapse, Drawer, Form, Input, Select, Space, Switch, Table, Tag, Typography, Popconfirm } from 'antd'
import { Button } from './Button'
import { announceChanges, send, useResource, type Row } from './api'
import { ErrorNotice } from './EntityTable'

const { Text } = Typography
const defaults={kind:'s3',prefix:'omp',region:'us-east-1',addressing:'path',media_enabled:false}

function ProbeResult({value}:{value:Row|null}) {
  if(!value)return null
  const passed=value.object_io==='passed'
  return <Alert showIcon type={passed?'success':'error'} message={passed?'读写及删除测试通过':`连接测试失败：${value.stage||'请求'}（${value.error_type||'请检查配置'}）`} description={<Space direction="vertical">{value.media==='passed'&&<span>媒体裁切测试通过</span>}{value.media==='unavailable'&&<span>{value.media_message}</span>}{value.test_object_deleted===false&&<span>测试对象未清理：{value.cleanup_key}</span>}</Space>}/>
}

export function StorageConnections() {
  const resource=useResource<Row[]>('/storage-connections',[]),[open,setOpen]=useState(false),[editing,setEditing]=useState<Row|null>(null),[busy,setBusy]=useState(''),[result,setResult]=useState<Row|null>(null),[form]=Form.useForm()
  const {message}=App.useApp()
  function edit(row:Row|null){setEditing(row);setResult(null);form.resetFields();form.setFieldsValue({...defaults,...row,access_key:'',secret_key:''});setOpen(true)}
  async function save(){try{const value=await form.validateFields();setBusy('save');await send(editing?`/storage-connections/${editing.id}`:'/storage-connections',value,editing?'PUT':'POST');setOpen(false);form.resetFields();await resource.reload();message.success('存储连接已保存')}catch(e){if(e instanceof Error)message.error(e.message)}finally{setBusy('')}}
  async function test(media=false){try{const value=await form.validateFields();setBusy(media?'media':'test');setResult(await send('/storage-connections/test',{...value,id:editing?.id,test_media:media}))}catch(e){if(e instanceof Error)message.error(e.message)}finally{setBusy('')}}
  async function savedTest(row:Row){setBusy(row.id);try{await send(`/storage-connections/${row.id}/test`,{media:row.media_enabled});await resource.reload()}catch(e){message.error((e as Error).message)}finally{setBusy('')}}
  return <Space direction="vertical" size={24} style={{width:'100%'}}>
    <ErrorNotice error={resource.error} retry={resource.reload}/>
    <Card title="存储连接" extra={<Button type="primary" onClick={()=>edit(null)}>添加连接</Button>}>
      <Table rowKey="id" loading={resource.loading} dataSource={resource.data} pagination={{defaultPageSize:10}} columns={[
        {title:'连接',render:(_,row)=><Space direction="vertical" size={0}><Text>{row.name}</Text><Text type="secondary">{row.bucket}</Text></Space>},
        {title:'考试项目',dataIndex:'project_count'},
        {title:'媒体处理',render:(_,row)=><Tag>{row.media_enabled?'已开启':'关闭'}</Tag>},
        {title:'最近测试',render:(_,row)=>row.last_test?<Space direction="vertical" size={0}><Tag color={row.last_test.object_io==='passed'?'green':'red'}>{row.last_test.object_io==='passed'?'连接通过':'连接失败'}</Tag>{row.last_test.media==='unavailable'&&<Text type="warning">媒体未就绪</Text>}{row.last_test.media==='passed'&&<Text type="secondary">媒体通过</Text>}</Space>:<Text type="secondary">未测试</Text>},
        {title:'操作',render:(_,row)=><Space wrap><Button onClick={()=>edit(row)}>编辑</Button><Button loading={busy===row.id} disabled={!!busy&&busy!==row.id} onClick={()=>savedTest(row)}>测试</Button><Popconfirm title="删除此存储连接？" onConfirm={async()=>{try{await send(`/storage-connections/${row.id}`,undefined,'DELETE');await resource.reload()}catch(e){message.error((e as Error).message)}}}><Button type="text" disabled={!!row.project_count}>删除</Button></Popconfirm></Space>},
      ]}/>
    </Card>
    <Drawer title={editing?'编辑存储连接':'添加存储连接'} width={560} open={open} onClose={()=>{if(!busy){setOpen(false);form.resetFields();setResult(null)}}} extra={<Button type="primary" loading={busy==='save'} disabled={!!busy&&busy!=='save'} onClick={save}>保存</Button>}>
      <Form form={form} layout="vertical" initialValues={defaults} autoComplete="off">
        <Form.Item name="name" label="连接名称" rules={[{required:true}]}><Input maxLength={100}/></Form.Item>
        <Form.Item name="kind" label="服务类型"><Select options={[{value:'s3',label:'S3 / MinIO'},{value:'ros',label:'雨云 ROS'}]}/></Form.Item>
        <Form.Item name="endpoint" label="API端点" rules={[{required:true}]}><Input placeholder="https://s3.example.com"/></Form.Item>
        <Form.Item name="bucket" label="存储桶" rules={[{required:true}]}><Input/></Form.Item>
        <Form.Item name="access_key" label="Access Key" rules={[{required:!editing}]}><Input.Password autoComplete="new-password" placeholder={editing?'留空保留原值':undefined}/></Form.Item>
        <Form.Item name="secret_key" label="Secret Key" rules={[{required:!editing}]}><Input.Password autoComplete="new-password" placeholder={editing?'留空保留原值':undefined}/></Form.Item>
        <Collapse items={[
          {key:'advanced',label:'对象路径与区域',children:<><Form.Item name="prefix" label="对象前缀"><Input/></Form.Item><Form.Item name="region" label="区域"><Input/></Form.Item><Form.Item name="addressing" label="寻址方式"><Select options={[{value:'path',label:'路径式'},{value:'virtual',label:'虚拟主机式'}]}/></Form.Item></>},
          {key:'media',label:'媒体处理（Beta）',children:<><Form.Item name="media_enabled" label="启用媒体处理" valuePropName="checked"><Switch/></Form.Item><Form.Item name="media_url" label="存储桶媒体访问地址"><Input placeholder="https://bucket.s3.example.com"/></Form.Item><Text type="secondary">服务器转发题图；媒体处理不可用时自动使用本地裁切。</Text><div style={{marginTop:20}}><Button loading={busy==='media'} disabled={!!busy&&busy!=='media'} onClick={()=>test(true)}>测试媒体裁切</Button></div></>},
        ]}/>
        <Space direction="vertical" size={24} style={{width:'100%',marginTop:24}}><Button loading={busy==='test'} disabled={!!busy&&busy!=='test'} onClick={()=>test()}>测试读写与删除</Button><ProbeResult value={result}/></Space>
      </Form>
    </Drawer>
  </Space>
}

export function ProjectStorage({project,onSaved}:{project:Row;onSaved:()=>Promise<void>}) {
  const connections=useResource<Row[]>('/storage-connections/choices',[]),[selected,setSelected]=useState<string|undefined>(),[saving,setSaving]=useState(false)
  const {message}=App.useApp()
  useEffect(()=>setSelected(project.storage_connection_id||undefined),[project.id,project.storage_connection_id])
  async function save(){setSaving(true);try{await send(`/projects/${project.id}/storage`,{connection_id:selected||null},'PUT');announceChanges(['projects']);await onSaved();message.success('项目存储已更新')}catch(e){message.error((e as Error).message)}finally{setSaving(false)}}
  return <Card title="扫描文件存储"><ErrorNotice error={connections.error} retry={connections.reload}/><Space direction="vertical" size={24} style={{width:'100%',maxWidth:520}}><div><Text>存储连接</Text><Select style={{width:'100%',marginTop:8}} value={selected} allowClear placeholder="服务器默认存储" loading={connections.loading} onChange={setSelected} options={connections.data.map(row=>({value:row.id,label:`${row.name} · ${row.bucket}`}))}/></div><Text type="secondary">新同步的文件使用所选连接，已有远端文件保留原存储归属。连接在系统设置中维护。</Text><Button type="primary" loading={saving} onClick={save}>保存</Button></Space></Card>
}
