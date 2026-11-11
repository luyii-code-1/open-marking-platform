import { useEffect, useState } from 'react'
import { Alert, App as AntApp, Avatar, Button, Card, Divider, Empty, Form, Input, Layout, Menu, Radio, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { ApartmentOutlined, AuditOutlined, BookOutlined, FileSearchOutlined, LogoutOutlined, MenuOutlined, ReadOutlined, ScanOutlined, SettingOutlined, TeamOutlined } from '@ant-design/icons'
import { request, send, setToken, useResource, type User } from './api'
import { DataManagement, Exams, Exceptions, Results, Scans, Settings } from './Management'
import { TemplateEditor } from './TemplateEditor'
import { Marking } from './Marking'
import { Account } from './Account'
import { PwaStatus } from './PwaStatus'
import { RealtimeStatus } from './RealtimeStatus'
import { loginPasskey } from './passkeys'

const { Text, Title } = Typography
export function App() {
  const [user, setUser] = useState<User | null>(null), [checking, setChecking] = useState(true), [page, setPage] = useState('dashboard'), [mobile, setMobile] = useState<'auto' | 'desktop' | 'mobile'>('auto'), [collapsed, setCollapsed] = useState(false)
  useEffect(() => { request<User>('/auth/me').then(setUser).catch(() => setToken('')).finally(() => setChecking(false)) }, [])
  if (checking) return <div className="screen-center"><Spin size="large" /></div>
  if (!user) return <Login onLogin={setUser} />
  const admin = user.role === 'admin'
  const items = [
    { key: 'dashboard', icon: <ApartmentOutlined />, label: '工作概览' },
    ...(admin ? [{ key: 'exams', icon: <BookOutlined />, label: '考试项目' }, { key: 'templates', icon: <ReadOutlined />, label: '题卡设计' }, { key: 'scans', icon: <ScanOutlined />, label: '扫描批次' }] : []),
    { key: 'marking', icon: <AuditOutlined />, label: '阅卷中心' },
    {key:'account',icon:<SettingOutlined/>,label:'个人账号'},
    ...(admin ? [{ key: 'exceptions', icon: <FileSearchOutlined />, label: '异常中心' }] : []),
    { key: 'results', icon: <ReadOutlined />, label: '成绩与分析' },
    ...(admin ? [{ key: 'people', icon: <TeamOutlined />, label: '人员与班级' }, { key: 'settings', icon: <SettingOutlined />, label: '系统设置' }] : []),
  ]
  const title = items.find(i => i.key === page)?.label || '工作概览'
  return <Layout className={`app-shell mode-${mobile}`}>
    <Layout.Sider width={230} collapsedWidth={72} collapsed={collapsed} className="sidebar" breakpoint="lg" onBreakpoint={broken => setCollapsed(broken)}>
      <div className="brand"><span className="brand-symbol">M</span>{!collapsed && <span>Open Marking<small>开放阅卷平台</small></span>}</div>
      <Menu theme="light" mode="inline" items={items} selectedKeys={[page]} onClick={({ key }) => setPage(key)} />
      {!collapsed && <div className="sidebar-footer"><Tag color="green">{admin ? '管理工作台' : '教师工作台'}</Tag><Text type="secondary">让每一份作答得到准确评阅</Text></div>}
    </Layout.Sider>
    <Layout>
      <Layout.Header className="topbar"><Space><Button type="text" aria-label="展开导航" icon={<MenuOutlined />} onClick={() => setCollapsed(!collapsed)} /><span className="breadcrumb">工作空间 <span>/</span> {title}</span></Space><Space><Radio.Group size="small" value={mobile} onChange={e => setMobile(e.target.value)} options={[{ label: '自适应', value: 'auto' }, { label: '电脑', value: 'desktop' }, { label: '手机', value: 'mobile' }]} /><PwaStatus/><RealtimeStatus user={user} onProfile={setUser} onExpired={()=>{setToken('');setUser(null)}}/><Avatar size="small">{user.name.slice(0, 1)}</Avatar><Text>{user.name}</Text><Button type="text" icon={<LogoutOutlined />} onClick={async () => { await send('/auth/logout').catch(()=>{}); setToken(''); setUser(null) }}>退出</Button></Space></Layout.Header>
      <Layout.Content className="page-content"><div className="page-heading"><div><Text className="eyebrow">OPEN MARKING PLATFORM</Text><Title level={2}>{title}</Title></div><Tag className="account-tag">{user.role === 'admin' ? '管理员' : '阅卷教师'} · {user.username}</Tag></div>
        {page === 'dashboard' && <Dashboard onNavigate={setPage} admin={admin} />}
        {page === 'exams' && <Exams />}
        {page === 'templates' && <TemplateEditor />}
        {page === 'scans' && <Scans />}
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
  return <div className="login-screen"><div className="login-intro"><span className="brand-symbol">M</span><p className="eyebrow">OPEN MARKING PLATFORM</p><h1>从一张答题卡，<br />到一场完整考试。</h1><p>制卡、扫描、协同阅卷与成绩分析，<br />在同一个工作空间完成。</p><div className="login-grid"><span>01 / 制作题卡</span><span>02 / 扫描入库</span><span>03 / 协同评阅</span><span>04 / 成绩发布</span></div></div><Card className="login-card"><PwaStatus/><Title level={3}>{bootstrap ? '创建首位管理员' : '登录工作空间'}</Title><Text type="secondary">{bootstrap ? '仅在全新部署时使用，创建后进入管理工作台。' : '使用管理员分发的账号进入平台。'}</Text><Divider />{error && <Alert type="error" showIcon message={error} style={{ marginBottom: 20 }} />}<Form layout="vertical" onFinish={submit} requiredMark={false}>{!bootstrap&&<Form.Item label="登录方式"><Radio.Group value={mode} onChange={e=>setMode(e.target.value)} options={[{label:"密码",value:"password"},{label:"恢复码",value:"recovery"},{label:"通行密钥",value:"passkey"}]}/></Form.Item>}<Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}><Input size="large" autoComplete="username" /></Form.Item>{bootstrap && <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}><Input size="large" /></Form.Item>}<Form.Item name="password" hidden={!bootstrap&&mode==='passkey'} label={!bootstrap&&mode==='recovery'?'恢复码':'密码'} rules={[{ required: bootstrap||mode!=='passkey', message: '请输入密码或恢复码' }, ...(bootstrap ? [{ min: 10, message: '至少 10 个字符' }] : [])]}><Input.Password size="large" autoComplete={bootstrap ? 'new-password' : 'current-password'} /></Form.Item><Button block size="large" type="primary" htmlType="submit" loading={loading}>{bootstrap ? '创建并登录' : '登录'}</Button></Form><Button block type="link" onClick={() => { setBootstrap(!bootstrap); setError('') }}>{bootstrap ? '返回登录' : '首次部署 · 创建管理员'}</Button></Card></div>
}
function Dashboard({ onNavigate, admin }: { onNavigate: (value: string) => void; admin: boolean }) {
  const resource = useResource<Record<string, number>>('/dashboard', {})
  return <Space direction="vertical" size="large" style={{ width: '100%' }}>{resource.error && <Alert type="error" showIcon message={resource.error} action={<Button onClick={resource.reload}>重试</Button>} />}<div className="stat-grid">{[['projects', '考试项目'], ['groups', '题卡组'], ['students', '学生'], ['pending_tasks', '待评作答'], ['exceptions', '待处理异常']].map(([key, label]) => <Card key={key}><Statistic loading={resource.loading} title={label} value={resource.data[key] ?? '—'} /></Card>)}</div><Card className="welcome-card"><Text className="eyebrow">有序推进每一场考试</Text><Title level={3}>选择工作环节，开始今天的评阅。</Title><Text type="secondary">成绩发布前，先完成作答评阅并核对异常事项。</Text><div className="workflow-grid">{(admin ? [['exams', '01', '考试与题卡', '按项目、科目和题卡组组织考试'], ['scans', '02', '扫描与入库', '查看采集页面，核对正反面配对'], ['marking', '03', '任务与评阅', '分配题目，完成单评或双评'], ['results', '04', '成绩与发布', '查看统计、导出并发布成绩']] : [['marking', '01', '开始阅卷', '进入分配给你的题目'], ['results', '02', '查看成绩', '分析所授班级的考试表现']]).map(([key, number, label, detail]) => <button className="workflow-item" key={key} onClick={() => onNavigate(key)}><span>{number}</span><strong>{label}</strong><small>{detail}</small></button>)}</div></Card>{!resource.loading && !Object.keys(resource.data).length && !resource.error && <Empty description="尚无工作数据" />}</Space>
}
