import { useEffect, useState } from 'react'
import { Alert, Avatar, Card, Empty, Layout, Menu, Select, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { Button } from './Button'
import { ApartmentOutlined, AuditOutlined, BookOutlined, FileSearchOutlined, LogoutOutlined, ReadOutlined, SettingOutlined, TeamOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import { request, send, setToken, useResource, type User } from './api'
import { DataManagement, Exceptions, Results, Settings } from './Management'
import { Exams } from './Exams'
import { useNavigation, confirmLeaving } from './useNavigation'
import { Marking } from './Marking'
import { Account } from './Account'
import { PwaStatus } from './PwaStatus'
import { RealtimeStatus } from './RealtimeStatus'
import { Login, type Portal } from './Login'
import { ArchiveManager } from './ArchiveManager'
import { Brand } from './Brand'

const { Text, Title } = Typography
export function App() {
  const [user, setUser] = useState<User | null>(null), [checking, setChecking] = useState(true), [mobile, setMobile] = useState<'auto' | 'desktop' | 'mobile'>('auto'), [collapsed, setCollapsed] = useState(false), [portal,setPortal] = useState<Portal>(()=>sessionStorage.getItem('omp-portal')==='marking'?'marking':'admin')
  const { location, navigate } = useNavigation()
  const setPage = (page: string) => navigate('#/' + page)
  useEffect(() => { request<User>('/auth/me').then(setUser).catch(() => setToken('')).finally(() => setChecking(false)) }, [])
  useEffect(()=>{if(user && location.page==='login'){const next:Portal=location.section==='admin'&&user.role==='admin'?'admin':'marking';setPortal(next);sessionStorage.setItem('omp-portal',next);navigate(next==='admin'?'#/exams':'#/marking',true)}},[user,location.page,location.section])
  if (checking) return <div className="screen-center"><Spin size="large" /></div>
  if (!user) return <Login portal={location.page==='login' && (location.section==='admin'||location.section==='marking')?location.section:undefined} onPortal={value=>navigate(value?'#/login/'+value:'#/')} onLogin={(person,selected)=>{setPortal(selected);sessionStorage.setItem('omp-portal',selected);setUser(person);navigate(selected==='admin'?'#/exams':'#/marking',true)}} />
  const admin = user.role === 'admin', management = admin && portal === 'admin'
  const page = management || ['dashboard','marking','results','account'].includes(location.page) ? location.page : 'dashboard'
  const items = [
    { key: 'dashboard', icon: <ApartmentOutlined />, label: '工作概览' },
    { type: 'group' as const, key: 'work', label: '考试工作', children: [
      ...(management ? [{ key: 'exams', icon: <BookOutlined />, label: '考试项目' }] : []),
      { key: 'marking', icon: <AuditOutlined />, label: '阅卷中心' },
      ...(management ? [{ key: 'exceptions', icon: <FileSearchOutlined />, label: '异常总览' }] : []),
      { key: 'results', icon: <ReadOutlined />, label: '成绩总览' },
    ] },
    ...(management ? [{ type: 'group' as const, key: 'management', label: '基础管理', children: [
      { key: 'people', icon: <TeamOutlined />, label: '人员与班级' },
      { key: 'archives', icon: <BookOutlined />, label: '归档文件' },
      { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
    ] }] : []),
    { key: 'account', icon: <SettingOutlined />, label: '个人账号' },
  ]
  const title = items.flatMap(i => 'children' in i ? i.children || [] : [i]).find(i => i.key === page)?.label || '工作概览'
  return <Layout className={`app-shell mode-${mobile}`}>
    <Layout.Sider width={200} collapsedWidth={64} collapsed={collapsed} className="sidebar" breakpoint="lg" onBreakpoint={broken => setCollapsed(broken)}>
      <Brand compact={collapsed} />
      <Menu theme="light" mode="inline" items={items} selectedKeys={[page]} onClick={({ key }) => setPage(key)} />
    </Layout.Sider>
    <Layout>
      <Layout.Header className="topbar"><Space className="topbar-left"><Button type="text" aria-label={collapsed?'展开导航':'收起导航'} icon={collapsed?<MenuUnfoldOutlined />:<MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} /><span className="breadcrumb">{management ? '管理后台' : '阅卷台'} <span>/</span> {title}</span></Space><Space size={8} className="topbar-actions"><Select aria-label="显示模式" style={{width:88}} size="small" value={mobile} onChange={value => setMobile(value)} options={[{ label: '自适应', value: 'auto' }, { label: '电脑', value: 'desktop' }, { label: '手机', value: 'mobile' }]} /><PwaStatus/><RealtimeStatus user={user} onProfile={setUser} onExpired={()=>{setToken('');setUser(null)}}/>{admin && <Button type="text" onClick={()=>{if(!confirmLeaving())return;const next:Portal=management?'marking':'admin';setPortal(next);sessionStorage.setItem('omp-portal',next);navigate(next==='admin'?'#/exams':'#/marking')}}>{management?'进入阅卷台':'进入管理后台'}</Button>}<Avatar size="small">{user.name.slice(0, 1)}</Avatar><Text className="account-name" ellipsis>{user.name}</Text><Button type="text" icon={<LogoutOutlined />} onClick={async () => { if(!confirmLeaving())return; await send('/auth/logout').catch(()=>{}); setToken(''); setUser(null) }}>退出</Button></Space></Layout.Header>
      <Layout.Content className="page-content"><div className="page-heading" hidden={page === 'exams' && !!location.projectId}><div><Title level={2}>{title}</Title></div><Tag className="account-tag">{user.role === 'admin' ? '管理员' : '阅卷教师'} · {user.username}</Tag></div>
        {page === 'dashboard' && <Dashboard onNavigate={setPage} admin={management} />}
        {page === 'exams' && <Exams location={location} navigate={navigate} />}
        {page === 'marking' && <Marking admin={management} />}
        {page === 'exceptions' && <Exceptions />}
        {page === 'results' && <Results admin={management} />}
        {page === 'archives' && <ArchiveManager/>}
        {page === 'people' && <DataManagement />}
        {page === 'settings' && <Settings />}
        {page === 'account' && <Account user={user} onProfile={setUser} onLogout={()=>{setToken('');setUser(null)}}/>}
      </Layout.Content>
    </Layout>
  </Layout>
}
function Dashboard({ onNavigate, admin }: { onNavigate: (value: string) => void; admin: boolean }) {
  const resource = useResource<Record<string, number>>('/dashboard', {})
  const shortcuts = admin
    ? [['exams', '考试项目'], ['marking', '阅卷中心'], ['exceptions', '异常总览'], ['results', '成绩总览']]
    : [['marking', '阅卷中心'], ['results', '成绩与分析']]
  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    {resource.error && <Alert type="error" showIcon message={resource.error} action={<Button onClick={resource.reload}>重试</Button>} />}
    <div className="stat-grid">{[['projects', '考试项目'], ['groups', '题卡组'], ['students', '学生'], ['pending_tasks', '待评作答'], ['exceptions', '待处理异常']].map(([key, label]) => <Card key={key}><Statistic loading={resource.loading} title={label} value={resource.data[key] ?? '—'} /></Card>)}</div>
    <Card title="快捷操作"><div className="workflow-grid">{shortcuts.map(([key, label]) => <button className="workflow-item" key={key} onClick={() => onNavigate(key)}><strong>{label}</strong></button>)}</div></Card>
    {!resource.loading && !Object.keys(resource.data).length && !resource.error && <Empty description="尚无工作数据" />}
  </Space>
}
