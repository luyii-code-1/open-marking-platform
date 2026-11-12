import { useAction } from './useAction'
import { Button } from './Button'
import { useEffect, useState } from 'react'
import { Alert, App, Card, Descriptions, Modal, Space, Table, Tag, Typography } from 'antd'
import { request, send, useResource, type Row } from './api'
import { ErrorNotice } from './EntityTable'
import { Scans } from './Management'

export function ScannerDesk() {
  const release=useResource<any>('/scanner/distribution',null),devices=useResource<Row[]>('/scanner/my-devices',[]),[pair,setPair]=useState<any>(null),[paired,setPaired]=useState<any>(null),{message}=App.useApp()
  const action=useAction()
  useEffect(()=>{
    if(!pair||paired)return
    const timer=setInterval(async()=>{try{const next=await request<any>('/scanner/pairings/'+pair.id);if(next.status==='paired'){setPaired(next.device);void devices.reload()}else if(next.status!=='waiting'){setPair(null);message.info(next.status==='expired'?'配对码已过期，请重新生成':'配对已取消')}}catch(e){message.error((e as Error).message);setPair(null)}},2000)
    return()=>clearInterval(timer)
  },[pair,paired])
  async function create(){await action.run('pair',async()=>{try{setPaired(null);setPair(await send('/scanner/pairings'))}catch(e){message.error((e as Error).message)}})}
  async function getPackage(){await action.run('download',async()=>{try{const value=await send<{url:string}>('/scanner/download-link');const a=document.createElement('a');a.href=value.url;a.rel='noreferrer';a.click()}catch(e){message.error((e as Error).message)}})}
  const uri=pair?'omp-scanner://connect?'+new URLSearchParams({server:window.location.origin,code:pair.code}):''
  return <Space direction="vertical" size={16} style={{width:'100%'}}>
    <ErrorNotice error={release.error||devices.error} retry={()=>{void release.reload();void devices.reload()}}/>
    <Card title="扫描客户端"><Space direction="vertical" size={24} style={{width:'100%',maxWidth:680}}><Typography.Text>安装Windows扫描客户端后，将本机连接到当前服务器。</Typography.Text><Space wrap size={16}><Button type="primary" disabled={!release.data?.available||action.busy} loading={action.pending==='download'} onClick={getPackage}>下载Windows安装包{release.data?.available?` · ${Math.round(release.data.size/1024/1024)} MB`:''}</Button><Button onClick={create} disabled={action.busy} loading={action.pending==='pair'}>连接本机扫描端</Button></Space>{release.data&&!release.data.available&&<Typography.Text type="secondary">安装包尚未发布，请联系系统管理员。</Typography.Text>}</Space></Card>
    <Card title="已授权设备"><Table rowKey="id" dataSource={devices.data} pagination={{defaultPageSize:10}} columns={[{title:'设备',dataIndex:'label'},{title:'授权',render:(_,row)=><Tag color={row.revoked?'default':'green'}>{row.revoked?'已停用':'已授权'}</Tag>},{title:'最近连接',render:(_,row)=>row.last_authenticated_at?new Date(row.last_authenticated_at*1000).toLocaleString():'—'}]}/></Card>
    <Scans/>
    <Modal title="连接扫描客户端" open={!!pair} onCancel={()=>{setPair(null);setPaired(null)}} footer={paired?<Button type="primary" onClick={()=>setPair(null)}>完成</Button>:null}>
      {paired?<Alert type="success" showIcon message={`已连接：${paired.label}`}/>:<Space direction="vertical" size={24} style={{width:'100%'}}><Typography.Text>将客户端绑定到 {pair?.owner_name}，配对码10分钟内有效。</Typography.Text><Button type="primary" href={uri}>唤起扫描客户端</Button><Descriptions column={1} items={[{key:'server',label:'服务器',children:<Typography.Text copyable>{window.location.origin}</Typography.Text>},{key:'code',label:'手动配对码',children:<Typography.Text code copyable>{pair?.code}</Typography.Text>}]}/><Typography.Text type="secondary">未能唤起时，请打开客户端，在连接设置中填写服务器和配对码。</Typography.Text></Space>}
    </Modal>
  </Space>
}
