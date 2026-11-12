import { useEffect, useState } from 'react'
import { Alert, App as AntApp, Avatar, Button, Card, Divider, Empty, Form, Input, Layout, Menu, Radio, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { ApartmentOutlined, AuditOutlined, BookOutlined, FileSearchOutlined, LogoutOutlined, MenuOutlined, ReadOutlined, ScanOutlined, SettingOutlined, TeamOutlined } from '@ant-design/icons'
import { request, send, setToken, useResource, type User } from './api'
import { DataManagement, Exceptions, Results, Settings } from './Management'
import { Exams } from './Exams'
import { useNavigation, confirmLeaving } from './useNavigation'
import { Marking } from './Marking'
import { Account } from './Account'
import { PwaStatus } from './PwaStatus'
import { RealtimeStatus } from './RealtimeStatus'
import { loginPasskey } from './passkeys'

const { Text, Title } = Typography
export function App() {
  const [user, setUser] = useState<User | null>(null), [checking, setChecking] = useState(true), [mobile, setMobile] = useState<'auto' | 'desktop' | 'mobile'>('auto'), [collapsed, setCollapsed] = useState(false)
  const { location, navigate } = useNavigation()
  const setPage = (page: string) => navigate('#/' + page)
  useEffect(() => { request<User>('/auth/me').then(setUser).catch(() => setToken('')).finally(() => setChecking(false)) }, [])
  if (checking) return <div className="screen-center"><Spin size="large" /></div>
  if (!user) return <Login onLogin={setUser} />
  const admin = user.role === 'admin'
  const page = admin || ['dashboard','marking','results','account'].includes(location.page) ? location.page : 'dashboard'
  const items = [
    { key: 'dashboard', icon: <ApartmentOutlined />, label: '工作概览' },
    { type: 'group' as const, key: 'work', label: '考试工作', children: [
      ...(admin ? [{ key: 'exams', icon: <BookOutlined />, label: '考试项目' }] : []),
      { key: 'marking', icon: <AuditOutlined />, label: '阅卷中心' },
      ...(admin ? [{ key: 'exceptions', icon: <FileSearchOutlined />, label: '异常总览' }] : []),
      { key: 'results', icon: <ReadOutlined />, label: '成绩总览' },
    ] },
    ...(admin ? [{ type: 'group' as const, key: 'management', label: '基础管理', children: [
      { key: 'people', icon: <TeamOutlined />, label: '人员与班级' },
      { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
    ] }] : []),
    { key: 'account', icon: <SettingOutlined />, label: '个人账号' },
  ]
  const title = items.flatMap(i => 'children' in i ? i.children || [] : [i]).find(i => i.key === page)?.label || '工作概览'
  return <Layout className={`app-shell mode-${mobile}`}>
    <Layout.Sider width={230} collapsedWidth={72} collapsed={collapsed} className="sidebar" breakpoint="lg" onBreakpoint={broken => setCollapsed(broken)}>
      <div className="brand"><span className="brand-symbol">M</span>{!collapsed && <span>Open Marking<small>开放阅卷平台</small></span>}</div>
      <Menu theme="light" mode="inline" items={items} selectedKeys={[page]} onClick={({ key }) => setPage(key)} />
    </Layout.Sider>
    <Layout>
      <Layout.Header className="topbar"><Space><Button type="text" aria-label="展开导航" icon={<MenuOutlined />} onClick={() => setCollapsed(!collapsed)} /><span className="breadcrumb">工作空间 <span>/</span> {title}</span></Space><Space><Radio.Group size="small" value={mobile} onChange={e => setMobile(e.target.value)} options={[{ label: '自适应', value: 'auto' }, { label: '电脑', value: 'desktop' }, { label: '手机', value: 'mobile' }]} /><PwaStatus/><RealtimeStatus user={user} onProfile={setUser} onExpired={()=>{setToken('');setUser(null)}}/><Avatar size="small">{user.name.slice(0, 1)}</Avatar><Text>{user.name}</Text><Button type="text" icon={<LogoutOutlined />} onClick={async () => { if(!confirmLeaving())return; await send('/auth/logout').catch(()=>{}); setToken(''); setUser(null) }}>退出</Button></Space></Layout.Header>
      <Layout.Content className="page-content"><div className="page-heading" hidden={page === 'exams' && !!location.projectId}><div><Title level={2}>{title}</Title></div><Tag className="account-tag">{user.role === 'admin' ? '管理员' : '阅卷教师'} · {user.username}</Tag></div>
        {page === 'dashboard' && <Dashboard onNavigate={setPage} admin={admin} />}
        {page === 'exams' && <Exams location={location} navigate={navigate} />}
        {page === 'marking' && <Marking admin={admin} />}
        {page === 'exceptions' && <Exceptions />}
        {page === 'results' && <Results admin={admin} />}
        {page === 'people' && <DataManagement />}
        {page === 'settings' && <Settings />}
        {page === 'account' && <Account user={user} onProfile={setUser} onLogout={()=>{setToken('');setUser(null)}}/>}
      </Layout.Content>
    </Layout>
  </Layout>
}
function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [mode,setMode]=useState<'password'|'recovery'|'passkey'>('password'); const [bootstrap, setBootstrap] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('')
  async function submit(values: Record<string, string>) {
    setLoading(true); setError('')
    try { if (bootstrap) await send('/auth/bootstrap', values); const result = !bootstrap&&mode==='passkey'?await loginPasskey(values.username):!bootstrap&&mode==='recovery'?await send<{token:string;user:User}>('/auth/recovery-login',{username:values.username,code:values.password}):await send<{ token: string; user: User }>('/auth/login', { username: values.username, password: values.password }); setToken(result.token); onLogin(result.user) } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }
  return <div className="login-screen"><Card className="login-card"><PwaStatus/><Title level={3}>{bootstrap ? '创建管理员' : '登录'}</Title>{bootstrap && <Text type="secondary">仅首次部署可创建管理员。</Text>}<Divider />{error && <Alert type="error" showIcon message={error} style={{ marginBottom: 20 }} />}<Form layout="vertical" onFinish={submit} requiredMark={false}>{!bootstrap&&<Form.Item label="登录方式"><Radio.Group value={mode} onChange={e=>setMode(e.target.value)} options={[{label:"密码",value:"password"},{label:"恢复码",value:"recovery"},{label:"通行密钥",value:"passkey"}]}/></Form.Item>}<Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}><Input size="large" autoComplete="username" /></Form.Item>{bootstrap && <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}><Input size="large" /></Form.Item>}<Form.Item name="password" hidden={!bootstrap&&mode==='passkey'} label={!bootstrap&&mode==='recovery'?'恢复码':'密码'} rules={[{ required: bootstrap||mode!=='passkey', message: '请输入密码或恢复码' }, ...(bootstrap ? [{ min: 10, message: '至少 10 个字符' }] : [])]}><Input.Password size="large" autoComplete={bootstrap ? 'new-password' : 'current-password'} /></Form.Item><Button block size="large" type="primary" htmlType="submit" loading={loading}>{bootstrap ? '创建并登录' : '登录'}</Button></Form><Button block type="link" onClick={() => { setBootstrap(!bootstrap); setError('') }}>{bootstrap ? '返回登录' : '首次部署 · 创建管理员'}</Button></Card></div>
}
function Dashboard({ onNavigate, admin }: { onNavigate: (value: string) => void; admin: boolean }) {
  const resource = useResource<Record<string, number>>('/dashboard', {})
  const shortcuts = admin
    ? [['exams', '考试项目'], ['marking', '阅卷中心'], ['exceptions', '异常总览'], ['results', '成绩总览']]
    : [['marking', '阅卷中心'], ['results', '成绩与分析']]
  return <Space direction="vertical" size={32} style={{ width: '100%' }}>
    {resource.error && <Alert type="error" showIcon message={resource.error} action={<Button onClick={resource.reload}>重试</Button>} />}
    <div className="stat-grid">{[['projects', '考试项目'], ['groups', '题卡组'], ['students', '学生'], ['pending_tasks', '待评作答'], ['exceptions', '待处理异常']].map(([key, label]) => <Card key={key}><Statistic loading={resource.loading} title={label} value={resource.data[key] ?? '—'} /></Card>)}</div>
    <Card title="快捷操作"><div className="workflow-grid">{shortcuts.map(([key, label]) => <button className="workflow-item" key={key} onClick={() => onNavigate(key)}><strong>{label}</strong></button>)}</div></Card>
    {!resource.loading && !Object.keys(resource.data).length && !resource.error && <Empty description="尚无工作数据" />}
  </Space>
}
