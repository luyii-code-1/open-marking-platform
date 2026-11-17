import {AutoComplete,Form,Input,Typography} from 'antd'
import {Button} from './Button'
import {Brand} from './Brand'
export function ScanConnection({servers,server,busy,offline,onConnect,onOffline}:{servers:string[];server:string;busy:boolean;offline:boolean;onConnect:(values:{server_url:string;pairing_code?:string})=>void;onOffline:()=>void}){
 return <section className="scan-connection"><div className="scan-connection-card"><Brand/><h1>连接扫描服务器</h1><Typography.Paragraph type="secondary">连接后选择考试项目，开始扫描。</Typography.Paragraph><Form layout="vertical" initialValues={{server_url:server}} onFinish={onConnect}>
 <Form.Item label="服务器地址" name="server_url" rules={[{required:true,message:'请选择或输入服务器地址'}]}><AutoComplete options={servers.map(value=>({value}))} placeholder="选择服务器或输入 HTTPS 地址" filterOption={(input,option)=>String(option?.value||'').toLowerCase().includes(input.toLowerCase())}/></Form.Item>
 <Form.Item label="配对码（首次连接时填写）" name="pairing_code"><Input autoComplete="one-time-code" placeholder="在管理后台的扫描台生成" maxLength={14}/></Form.Item>
 <Button type="primary" htmlType="submit" block loading={busy}>连接并选择项目</Button>
 {offline&&<Button block disabled={busy} onClick={onOffline} style={{marginTop:12}}>使用已下载项目</Button>}
 </Form></div></section>
}
