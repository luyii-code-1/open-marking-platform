import { useEffect, useState } from 'react'
import { Alert, App, Card, Form, Input, Divider, Typography } from 'antd'
import { Button } from './Button'
import { ArrowLeftOutlined, KeyOutlined, AuditOutlined, SettingOutlined } from '@ant-design/icons'
import { ApiError, request, send, setToken, type User,type AuthSession } from './api'
import { loginPasskey } from './passkeys'
import { Brand } from './Brand'

export type Portal = 'marking' | 'admin'
const { Title, Paragraph } = Typography
export function Login({ portal, onPortal, onLogin }: { portal?: Portal; onPortal: (portal?: Portal) => void; onLogin: (user: User, portal: Portal) => void }) {
  const [mode, setMode] = useState<'password' | 'passkey' | 'forgot' | 'bootstrap'>('password'), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [loginForm] = Form.useForm(), [resetForm] = Form.useForm(), [bootstrapForm] = Form.useForm(), { message } = App.useApp()
  useEffect(() => { setMode('password'); setError('') }, [portal])
  const [canCreate, setCanCreate] = useState(false)
  useEffect(() => {
    setCanCreate(false)
    if (portal !== 'admin') return
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const state = await request<{available:boolean}>('/auth/bootstrap-status', {cache:'no-store', signal:controller.signal})
        if (!controller.signal.aborted) {
          setCanCreate(state.available)
          if (!state.available) setMode(current => current === 'bootstrap' ? 'password' : current)
        }
      } catch { if (!controller.signal.aborted) setCanCreate(false) }
    }
    void refresh()
    window.addEventListener('focus',refresh)
    return () => { controller.abort(); window.removeEventListener('focus',refresh) }
  }, [portal])
  async function login(values: Record<string, string>) {
    if (!portal) return
    setLoading(true); setError('')
    try {
      if (mode === 'bootstrap') {
        await send('/auth/bootstrap', values)
        setCanCreate(false); setMode('password')
        loginForm.setFieldsValue({username:values.username})
      }
      const result = mode === 'passkey' ? await loginPasskey(values.username, portal) : await send<AuthSession&{token:string}>('/auth/login', { username: values.username, password: values.password, portal })
      setToken(result.token,result); onLogin(result.user, portal)
    } catch (e) {
      if (mode === 'bootstrap' && e instanceof ApiError && e.status === 409) { setCanCreate(false); setMode('password') }
      setError((e as Error).message)
    }
    finally { setLoading(false) }
  }
  async function reset(values: Record<string, string>) {
    setLoading(true); setError('')
    try {
      await send('/auth/recovery-reset', { username: values.username, code: values.code.trim(), new_password: values.new_password })
      loginForm.setFieldsValue({ username: values.username, password: '' }); resetForm.resetFields(); setMode('password')
      message.success('密码已重置，请使用新密码登录')
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }
  if (!portal) return <div className="login-screen"><div className="portal-picker"><Brand login /><Title level={2}>登录</Title><div className="portal-grid">
    <Card><AuditOutlined className="portal-icon" /><Title level={3}>阅卷台</Title><Button type="primary" size="large" block onClick={() => onPortal('marking')}>登录阅卷台</Button></Card>
    <Card><SettingOutlined className="portal-icon" /><Title level={3}>管理后台</Title><Button size="large" block onClick={() => onPortal('admin')}>登录管理后台</Button></Card>
  </div></div></div>
  return <div className="login-screen"><Card className="login-card">
    <Button type="text" className="login-back" icon={<ArrowLeftOutlined />} disabled={loading} onClick={() => { if (mode === 'forgot' || mode === 'bootstrap') { setMode('password'); setError('') } else onPortal() }}>{mode === 'forgot' || mode === 'bootstrap' ? '返回登录' : '选择登录入口'}</Button>
    <Brand login />
    <Title level={3}>{mode === 'forgot' ? '重置密码' : mode === 'bootstrap' ? '创建管理员' : portal === 'admin' ? '登录管理后台' : '登录阅卷台'}</Title>
    {error && <Alert type="error" showIcon message={error} className="login-error" />}
    {mode === 'forgot' ? <>
      <Paragraph type="secondary">使用已保存的恢复码设置新密码。恢复码仅可使用一次，重置后原登录会话失效。</Paragraph>
      <Form form={resetForm} layout="vertical" requiredMark={false} onFinish={reset}>
        <Form.Item name="username" label="账号" rules={[{ required: true }]}><Input autoComplete="username" /></Form.Item>
        <Form.Item name="code" label="恢复码" rules={[{ required: true, whitespace: true }]}><Input autoComplete="one-time-code" spellCheck={false} /></Form.Item>
        <Form.Item name="new_password" label="新密码" rules={[{ required: true, min: 10, max: 200, message: '密码需10至200个字符' }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item name="confirm_password" label="确认新密码" dependencies={['new_password']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => !value || getFieldValue('new_password') === value ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')) })]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={loading}>重置密码</Button>
      </Form><Paragraph type="secondary" className="forgot-help">没有可用恢复码时，请联系管理员重置密码。</Paragraph>
    </> : mode === 'bootstrap' ? <>
      <Paragraph type="secondary">仅首次部署可创建管理员。</Paragraph><Form form={bootstrapForm} layout="vertical" requiredMark={false} onFinish={login}>
        <Form.Item name="username" label="账号" rules={[{ required: true }]}><Input autoComplete="username" /></Form.Item>
        <Form.Item name="name" label="姓名" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, min: 10, max: 200, message: '密码需10至200个字符' }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={loading}>创建并登录</Button>
      </Form>
    </> : <>
      <Form form={loginForm} layout="vertical" requiredMark={false} onFinish={login}>
        <Form.Item name="username" label="账号" rules={[{ required: true }]}><Input size="large" autoComplete="username" /></Form.Item>
        {mode === 'password' && <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}><Input.Password size="large" autoComplete="current-password" /></Form.Item>}
        <Button type="primary" htmlType="submit" size="large" block loading={loading}>{mode === 'passkey' ? '使用通行密钥登录' : '登录'}</Button>
      </Form>
      <div className="login-links"><Button type="link" onClick={() => { resetForm.setFieldsValue({ username: loginForm.getFieldValue('username') || '' }); setMode('forgot'); setError('') }}>忘记密码</Button>{portal === 'admin' && canCreate && <Button type="link" onClick={() => { setMode('bootstrap'); setError('') }}>首次部署创建管理员</Button>}</div>
      <Divider plain>其他登录方式</Divider>
      <Button block size="large" disabled={loading} icon={mode==='password'?<KeyOutlined/>:undefined} onClick={()=>{setMode(mode==='password'?'passkey':'password');setError('')}}>{mode==='password'?'使用通行密钥':'使用密码登录'}</Button>
    </>}
  </Card></div>
}
