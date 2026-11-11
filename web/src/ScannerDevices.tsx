import { useState } from 'react'
import { Alert,App,Button,Card,Input,Modal,Select,Space,Table,Tag,Typography } from 'antd'
import { send,useResource,type Row } from './api'

export function ScannerDevices() {
  const devices=useResource<Row[]>('/scanner/devices',[]),users=useResource<Row[]>('/users',[]),batches=useResource<Row[]>('/scan-batches',[])
  const [selected,setSelected]=useState<Row|null>(null),[mode,setMode]=useState('status'),[reason,setReason]=useState(''),[password,setPassword]=useState(''),[ids,setIds]=useState<string[]>([]),[busy,setBusy]=useState(false),{message}=App.useApp()
  const enabled=(device:Row)=>!device.revoked&&users.data.find(u=>u.id===device.owner_id)?.role==='admin'
  function open(device:Row,operation:string){setSelected(device);setMode(operation);setReason('');setPassword('');setIds([])}
  async function save(){
    if(!selected||!reason.trim()){message.warning('请填写操作原因');return}
    setBusy(true)
    try{if(mode==='migrate')await send(`/scanner/devices/${selected.id}/adopt-batches`,{batch_ids:ids,migrate_revoked:true,reason});else await send(`/scanner/devices/${selected.id}/status`,{enabled:!enabled(selected),reason,password});setSelected(null);await devices.reload();await batches.reload();message.success('设备授权已更新')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}
  }
  const candidates=batches.data.filter(b=>b.status!=='paired'&&b.scanner_device_id!==selected?.id&&(!b.scanner_device_id||devices.data.some(d=>d.id===b.scanner_device_id&&d.revoked)))
  return <Card title="扫描设备授权" extra={<Button onClick={()=>{void devices.reload();void users.reload();void batches.reload()}}>刷新</Button>}>
    {(devices.error||users.error||batches.error)&&<Alert type="error" message={devices.error||users.error||batches.error}/>}
    <Typography.Paragraph type="secondary">扫描端首次使用管理员账号注册，之后可选择“已注册设备连接”。设备密钥保存在Windows用户密钥库，设备令牌仅用于扫描。停用立即阻断连接，重新启用后需重新验证设备密钥。</Typography.Paragraph>
    <Table rowKey="id" dataSource={devices.data} loading={devices.loading||users.loading} scroll={{x:'max-content'}} columns={[{title:'设备',dataIndex:'label'},{title:'授权管理员',dataIndex:'owner_id',render:id=>users.data.find(u=>u.id===id)?.name||'已失效'},{title:'状态',render:(_,row)=><Tag color={enabled(row)?'green':'red'}>{enabled(row)?'已启用':'已停用'}</Tag>},{title:'最近连接',dataIndex:'last_authenticated_at',render:value=>value?new Date(value*1000).toLocaleString():'—'},{title:'公钥指纹',dataIndex:'fingerprint',render:value=><Typography.Text copyable ellipsis style={{maxWidth:220}}>{value}</Typography.Text>},{title:'操作',render:(_,row)=><Space wrap><Button disabled={users.loading} danger={enabled(row)} onClick={()=>open(row,'status')}>{enabled(row)?'停用':'重新启用'}</Button><Button disabled={!enabled(row)} onClick={()=>open(row,'migrate')}>迁移待扫批次</Button></Space>}]} />
    <Modal title={mode==='migrate'?'迁移待扫批次':selected&&enabled(selected)?'停用扫描设备':'重新启用扫描设备'} open={!!selected} onCancel={()=>setSelected(null)} onOk={save} confirmLoading={busy} okButtonProps={{disabled:mode==='migrate'&&!ids.length}}>
      {mode==='migrate'?<><Typography.Paragraph>仅可迁入未绑定设备的批次，或已停用旧设备的批次。原始扫描文件、捕获编号和操作历史保留。</Typography.Paragraph><Select mode="multiple" style={{width:'100%'}} value={ids} onChange={setIds} placeholder="选择待迁移批次" options={candidates.map(b=>({label:`${b.room||'未记考场'} · ${b.id.slice(0,8)} · ${b.status}`,value:b.id}))}/></>:selected&&!enabled(selected)?<><Typography.Paragraph>确认该设备仍在你控制下。重新启用会重新授权原设备密钥，旧连接令牌保持失效。</Typography.Paragraph><Input.Password value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" placeholder="验证当前管理员密码"/></>:<Typography.Paragraph>设备将不能继续上传，新收到的本地扫描页仍保留在设备队列中。</Typography.Paragraph>}
      <Input.TextArea rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="填写授权或迁移原因" style={{marginTop:12}}/>
    </Modal>
  </Card>
}
