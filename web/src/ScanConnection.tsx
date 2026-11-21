import {useEffect,useState} from 'react'
import {Checkbox,Collapse,Form,Input,Radio,Tag,Typography} from 'antd'
import {Button} from './Button'
import {Brand} from './Brand'

type ConnectionValues={server_url:string;pairing_code?:string;set_default?:boolean}
type Props={
  servers:string[];server:string;defaultServer?:string;cachedServers:string[];busy:boolean
  onConnect:(values:ConnectionValues)=>void;onOffline:(server:string)=>void;onDefault:(server:string)=>void
}
function serverName(value:string){
  try{return new URL(value).host}catch{return value}
}
export function ScanConnection({servers,server,defaultServer,cachedServers,busy,onConnect,onOffline,onDefault}:Props){
  const [form]=Form.useForm<ConnectionValues>()
  const [adding,setAdding]=useState(!servers.length)
  const selected=Form.useWatch('server_url',form)??defaultServer??server
  useEffect(()=>{
    if(!form.isFieldsTouched())form.setFieldsValue({server_url:defaultServer||server})
  },[defaultServer,server,form])
  function choose(value:string){
    setAdding(false);form.setFieldsValue({server_url:value,pairing_code:'',set_default:false})
  }
  return <section className="scan-connection"><div className="scan-connection-card">
    <Brand/><h1>选择服务器</h1><Typography.Paragraph type="secondary">连接学校的服务器，再选择要扫描的考试。</Typography.Paragraph>
    <Form form={form} layout="vertical" initialValues={{server_url:defaultServer||server,set_default:!defaultServer}} onFinish={onConnect}>
      {!!servers.length&&<div className="scan-server-list">
        <Radio.Group value={adding?undefined:selected} disabled={busy} onChange={e=>choose(e.target.value)} aria-label="已保存的服务器">
          {servers.map(value=><div key={value} className={'scan-server-row '+(!adding&&selected===value?'is-selected':'')}>
            <Radio value={value}><strong>{serverName(value)}</strong><span>{value.replace(/\/api\/v1\/$/,'')}</span></Radio>
            {value===defaultServer?<Tag color="blue">默认</Tag>:<Button type="link" size="small" disabled={busy} onClick={()=>{choose(value);onDefault(value)}}>设为默认</Button>}
          </div>)}
        </Radio.Group>
        <Button disabled={busy} onClick={()=>{setAdding(true);form.setFieldsValue({server_url:'',pairing_code:'',set_default:!defaultServer})}}>添加服务器</Button>
      </div>}
      <Form.Item hidden={!adding&&!!servers.length} label="服务器地址" name="server_url" rules={[{required:true,message:'请选择或输入服务器地址'}]}>
        <Input disabled={busy} placeholder="请输入管理员提供的 HTTPS 地址" autoComplete="url"/>
      </Form.Item>
      {adding&&<Form.Item name="set_default" valuePropName="checked"><Checkbox disabled={busy}>设为默认服务器，下次优先显示</Checkbox></Form.Item>}
      <Collapse className="scan-pairing" defaultActiveKey={!servers.length?['pairing']:[]} items={[{key:'pairing',label:'首次连接：填写配对码',children:<>
        <Typography.Paragraph type="secondary">请向管理员获取配对码。已连接过的设备可直接连接。</Typography.Paragraph>
        <Form.Item name="pairing_code" label="配对码"><Input disabled={busy} autoComplete="one-time-code" placeholder="输入管理员提供的配对码" maxLength={14}/></Form.Item>
      </>}]} />
      <Button size="large" type="primary" htmlType="submit" block loading={busy} disabled={!selected}>连接服务器</Button>
      {cachedServers.includes(selected)&&<Button block disabled={busy} onClick={()=>onOffline(selected)}>离线使用已下载的考试</Button>}
    </Form>
  </div></section>
}
