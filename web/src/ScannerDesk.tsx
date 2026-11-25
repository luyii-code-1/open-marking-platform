import { useAction } from './useAction'
import { Button } from './Button'
import { useEffect, useState } from 'react'
import { Alert, App, Card, Descriptions, Input, Modal, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { request, send, useResource, type Row } from './api'
import { ErrorNotice } from './EntityTable'
import { Scans } from './Management'

export function ScannerDesk({systemAdmin=false}:{systemAdmin?:boolean}={}) {
  const release=useResource<any>('/scanner/distribution',null),electron=useResource<any>('/scanner/distribution?variant=electron',null)
  const devices=useResource<Row[]>(systemAdmin?'/scanner/devices':'/scanner/my-devices',[])
  const users=useResource<Row[]>(systemAdmin?'/users':null,[])
  const [pair,setPair]=useState<any>(null),[paired,setPaired]=useState<any>(null)
  const [revoking,setRevoking]=useState<Row|null>(null),[revokeReason,setRevokeReason]=useState('')
  const {message}=App.useApp()
  const action=useAction()
  useEffect(()=>{
    if(!pair||paired)return
    const timer=setInterval(async()=>{try{const next=await request<any>('/scanner/pairings/'+pair.id);if(next.status==='paired'){setPaired(next.device);void devices.reload()}else if(next.status!=='waiting'){setPair(null);message.info(next.status==='expired'?'配对码已过期，请重新生成':'配对已取消')}}catch(e){message.error((e as Error).message);setPair(null)}},2000)
    return()=>clearInterval(timer)
  },[pair,paired])
  async function create(){await action.run('pair',async()=>{try{setPaired(null);setPair(await send('/scanner/pairings'))}catch(e){message.error((e as Error).message)}})}
  async function getPackage(variant:'webview2'|'electron'='webview2'){await action.run('download:'+variant,async()=>{try{const value=await send<{url:string}>('/scanner/download-link',{variant});const a=document.createElement('a');a.href=value.url;a.rel='noreferrer';a.click()}catch(e){message.error((e as Error).message)}})}
  async function confirmRevoke(){
    if(!revoking)return
    await action.run('revoke:'+revoking.id,async()=>{
      try{
        await send(`/scanner/devices/${revoking.id}/revoke`,{reason:revokeReason.trim()||'操作员在扫描台取消授权'})
        setRevoking(null);setRevokeReason('')
        await devices.reload()
        message.success('已取消该机器的扫描授权')
      }catch(e){message.error((e as Error).message)}
    })
  }
  const ownerActive=(device:Row)=>{
    if(!systemAdmin)return !device.revoked
    const owner=users.data.find(u=>u.id===device.owner_id)
    return !device.revoked&&(!users.loaded||owner?.role==='admin'||owner?.role==='manager')
  }
  const uri=pair?'omp-scanner://connect?'+new URLSearchParams({server:window.location.origin,code:pair.code}):''
  return <Space direction="vertical" size={16} style={{width:'100%'}}>
    <ErrorNotice error={release.error||electron.error||devices.error||users.error} retry={()=>{void release.reload();void electron.reload();void devices.reload();if(systemAdmin)void users.reload()}}/>
    <Card title="扫描客户端"><Space direction="vertical" size={24} style={{width:'100%',maxWidth:680}}><Typography.Text>安装Windows扫描客户端后，将本机连接到当前服务器。</Typography.Text><Space wrap size={16}><Button type="primary" disabled={!release.data?.available||action.busy} loading={action.pending==='download:webview2'} onClick={()=>getPackage()}>下载Windows安装包{release.data?.available?` · ${Math.round(release.data.size/1024/1024)} MB`:''}</Button><Button disabled={!electron.data?.available||action.busy} loading={action.pending==='download:electron'} onClick={()=>getPackage('electron')}>下载Electron兼容版{electron.data?.available?` · ${Math.round(electron.data.size/1024/1024)} MB`:''}</Button><Button onClick={create} disabled={action.busy} loading={action.pending==='pair'}>连接本机扫描端</Button></Space><Typography.Text type="secondary">Electron兼容版自带浏览器内核，可用于未安装WebView2的电脑。两种客户端使用相同的扫描与配对流程。</Typography.Text>{release.data&&!release.data.available&&<Typography.Text type="secondary">安装包尚未发布，请联系系统管理员。</Typography.Text>}</Space></Card>
    <Card title="已授权设备" extra={<Space>{systemAdmin&&<Button href="#/settings/devices">管理全部扫描设备</Button>}<Button onClick={devices.reload} loading={devices.loading}>刷新</Button></Space>}><Table rowKey="id" dataSource={devices.data} loading={devices.loading} locale={{emptyText:'尚未连接扫描客户端，可点击上方“连接本机扫描端”配对'}} pagination={{defaultPageSize:50}} columns={[
      {title:'设备',dataIndex:'label'},
      ...(systemAdmin?[{title:'授权账号',dataIndex:'owner_id',render:(id:string)=>users.data.find(u=>u.id===id)?.name||'已失效'}]:[]),
      {title:'授权',render:(_:unknown,row:Row)=><Tag color={ownerActive(row)?'green':'default'}>{ownerActive(row)?'已授权':'已停用'}</Tag>},
      {title:'最近连接',render:(_:unknown,row:Row)=>row.last_authenticated_at?new Date(row.last_authenticated_at*1000).toLocaleString():'—'},
      {title:'操作',className:'row-actions',render:(_:unknown,row:Row)=>ownerActive(row)?<Button danger disabled={action.busy} onClick={()=>{setRevoking(row);setRevokeReason('')}}>取消授权</Button>:<Typography.Text type="secondary">已取消</Typography.Text>},
    ]}/></Card>
    <Scans/>
    <Modal title="取消授权扫描机器" open={!!revoking} onCancel={()=>{if(!action.busy){setRevoking(null);setRevokeReason('')}}} onOk={confirmRevoke} okText="确认取消授权" okButtonProps={{danger:true}} confirmLoading={!!revoking&&action.pending==='revoke:'+revoking.id}>
      <Space direction="vertical" size={12} style={{width:'100%'}}>
        <Typography.Paragraph style={{marginBottom:0}}>确认取消「{revoking?.label}」的扫描授权？取消后该机器的连接令牌会立即失效，无法继续上传或拉取项目配置；本机尚未上传的扫描文件仍保留在客户端队列中。</Typography.Paragraph>
        <Input.TextArea rows={2} maxLength={200} value={revokeReason} onChange={e=>setRevokeReason(e.target.value)} placeholder="取消授权原因（选填，默认记录为操作员在扫描台取消授权）"/>
      </Space>
    </Modal>
    <Modal title="连接扫描客户端" open={!!pair} onCancel={()=>{setPair(null);setPaired(null)}} footer={paired?<Button type="primary" onClick={()=>setPair(null)}>完成</Button>:null}>
      {paired?<Alert type="success" showIcon message={`已连接：${paired.label}`}/>:<Space direction="vertical" size={24} style={{width:'100%'}}><Typography.Text>将客户端绑定到 {pair?.owner_name}，配对码10分钟内有效。</Typography.Text><Button type="primary" href={uri}>唤起扫描客户端</Button><Descriptions column={1} items={[{key:'server',label:'服务器',children:<Typography.Text copyable>{window.location.origin}</Typography.Text>},{key:'code',label:'手动配对码',children:<Typography.Text code copyable>{pair?.code}</Typography.Text>}]}/><Typography.Text type="secondary">未能唤起时，请打开客户端，在连接设置中填写服务器和配对码。</Typography.Text></Space>}
    </Modal>
  </Space>
}
