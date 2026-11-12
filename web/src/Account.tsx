import { useState } from 'react'
import { App, Card, Form, Input, Modal, Space, Table, Typography } from 'antd'
import { Button } from './Button'
import { send, useResource, type Row, type User } from './api'
import { registerPasskey } from './passkeys'
import { useAction } from './useAction'
import { InstallApplication } from './PwaStatus'

export function Account({user,onProfile,onLogout}:{user:User;onProfile:(user:User)=>void;onLogout:()=>void}) {
  const [password,setPassword]=useState(''),[codes,setCodes]=useState<string[]>([])
  const passkeys=useResource<Row[]>('/auth/passkeys',[]),profileAction=useAction(),passwordAction=useAction(),action=useAction(),{message}=App.useApp()
  async function act(key:string,callback:()=>Promise<void>) {
    const owner=key==='profile'?profileAction:key==='password'?passwordAction:action
    await owner.run(key,async()=>{try{await callback()}catch(e){message.error((e as Error).message)}})
  }
  return <div className="account-grid">
    <Card title="个人资料"><Form layout="vertical" disabled={profileAction.busy||passwordAction.busy} initialValues={{name:user.name}} onFinish={values=>act('profile',async()=>{const current=await send<User>('/auth/profile',values,'PUT');onProfile(current);message.success('姓名已更新')})}>
      <Form.Item name="name" label="姓名" rules={[{required:true}]}><Input maxLength={100}/></Form.Item>
      <Button htmlType="submit" loading={profileAction.pending==='profile'}>保存资料</Button>
    </Form></Card>
    <Card title="账号安全"><Form layout="vertical" disabled={passwordAction.busy||action.busy} onFinish={values=>act('password',async()=>{await send('/auth/password',values);message.success('密码已修改，请重新登录');onLogout()})}>
      <Form.Item name="password" label="当前密码" rules={[{required:true}]}><Input.Password autoComplete="current-password"/></Form.Item>
      <Form.Item name="new_password" label="新密码" rules={[{required:true,min:10}]}><Input.Password autoComplete="new-password"/></Form.Item>
      <Button htmlType="submit" loading={passwordAction.pending==='password'}>修改密码并退出旧会话</Button>
    </Form></Card>
    <Card title="通行密钥与恢复码">
      <Typography.Paragraph>使用设备上的通行密钥登录。恢复码用于“忘记密码”中的密码重置，每个恢复码仅可使用一次。</Typography.Paragraph>
      <Input.Password placeholder="输入当前密码以管理密钥和恢复码" disabled={action.busy||passwordAction.busy} value={password} onChange={e=>setPassword(e.target.value)} style={{maxWidth:400,marginBottom:12}}/>
      <Space wrap style={{marginBottom:12}}>
        <Button disabled={action.busy||passwordAction.busy} loading={action.pending==='passkey'} onClick={()=>act('passkey',async()=>{await registerPasskey(password,'我的通行密钥');await passkeys.reload();message.success('通行密钥已添加')})}>添加通行密钥</Button>
        <Button disabled={action.busy||passwordAction.busy} loading={action.pending==='recovery'} onClick={()=>Modal.confirm({title:'重新生成恢复码？',content:'此前的恢复码将全部失效。',onOk:()=>act('recovery',async()=>{const response=await send<{codes:string[]}>('/auth/recovery-codes',{password});setCodes(response.codes)})})}>生成恢复码</Button>
      </Space>
      <Table rowKey="id" dataSource={passkeys.data} loading={passkeys.loading} columns={[
        {title:'名称',dataIndex:'name'},
        {title:'创建时间',dataIndex:'created_at',render:value=>new Date(value*1000).toLocaleString()},
        {title:'操作',width:100,render:(_,row)=><Button danger disabled={action.busy||passwordAction.busy} loading={action.pending===`revoke:${row.id}`} onClick={()=>act(`revoke:${row.id}`,async()=>{await send(`/auth/passkeys/${row.id}/revoke`,{password});await passkeys.reload();message.success('密钥已撤销')})}>撤销</Button>},
      ]}/>
    </Card>
    <Card title="应用"><InstallApplication/></Card>
    <Modal title="保存恢复码" open={!!codes.length} onCancel={()=>setCodes([])} footer={<Button onClick={()=>setCodes([])}>已保存，关闭</Button>}>
      <Typography.Paragraph>这些恢复码只在此时展示，请保存到你可以安全取用的位置。</Typography.Paragraph><Input.TextArea readOnly rows={8} value={codes.join('\n')}/>
    </Modal>
  </div>
}
