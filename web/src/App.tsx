import { Button } from './Button'
import { Brand } from './Brand'
import { ScannerDesk } from './ScannerDesk'
import { useEffect, useState } from 'react'
import { Alert, Avatar, Card, Empty, Layout, Menu, Select, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { ScanOutlined, ApartmentOutlined, AuditOutlined, BookOutlined, FileSearchOutlined, LogoutOutlined, MenuOutlined, ReadOutlined, SettingOutlined, TeamOutlined } from '@ant-design/icons'
import { ApiError, currentToken, request, send, setToken, useResource, type User } from './api'
import { DataManagement, Exceptions, Results, Settings } from './Management'
import { Exams } from './Exams'
import { useNavigation, confirmLeaving } from './useNavigation'
import { Marking } from './Marking'
import { Account } from './Account'
import { PwaStatus } from './PwaStatus'
import { RealtimeStatus } from './RealtimeStatus'
import { Login, type Portal } from './Login'
import { ArchiveManager } from './ArchiveManager'
import { ReviewWorkspace } from './ReviewWorkspace'
import { cachedReviewUser, rememberReviewUser, settleReviewWrites } from './reviewStore'

const { Text, Title } = Typography
export function App() {
  const [user, setUser] = useState<User | null>(null), [checking, setChecking] = useState(true), [mobile, setMobile] = useState<'auto' | 'desktop' | 'mobile'>('auto'), [collapsed, setCollapsed] = useState(false), [portal,setPortal] = useState<Portal>(()=>sessionStorage.getItem('omp-portal')==='marking'?'marking':'admin')
  const [offlineAccess,setOfflineAccess]=useState(false)
  const { location, navigate } = useNavigation()
  function endSession(){setToken('');sessionStorage.removeItem('omp-review-user');setUser(null);setOfflineAccess(false)}
  function acceptUser(person:User){setUser(person);setOfflineAccess(false);void rememberReviewUser(person).catch(()=>{})}
  const setPage = (page: string) => navigate('#/' + page)
  useEffect(() => {let active=true;void (async()=>{
    try{const person=await request<User>('/auth/me',{signal:AbortSignal.timeout(8000)});if(active)acceptUser(person)}
    catch(error){
      if(error instanceof ApiError&&[401,403].includes(error.status)){if(active)endSession()}
      else if(currentToken()){
        const id=sessionStorage.getItem('omp-review-user')
        const cached=id?await cachedReviewUser(id).catch(()=>undefined):undefined
        if(active&&cached){setUser(cached);setOfflineAccess(true);navigate('#/marking',true)}
      }
    }finally{if(active)setChecking(false)}
  })();return()=>{active=false}}, [])
  useEffect(()=>{if(user && !offlineAccess && location.page==='login'){const next:Portal=location.section==='admin'&&['admin','manager'].includes(user.role)?'admin':'marking';setPortal(next);sessionStorage.setItem('omp-portal',next);navigate(next==='admin'?'#/scanner':'#/marking',true)}},[user,offlineAccess,location.page,location.section])
  if (checking) return <div className="screen-center"><Spin size="large" /></div>
  if (!user) return <Login portal={location.page==='login' && (location.section==='admin'||location.section==='marking')?location.section:undefined} onPortal={value=>navigate(value?'#/login/'+value:'#/')} onLogin={(person,selected)=>{setPortal(selected);sessionStorage.setItem('omp-portal',selected);acceptUser(person);navigate(selected==='admin'?'#/scanner':'#/marking',true)}} />
  const admin = ['admin','manager'].includes(user.role), management = admin && portal === 'admin'&&!offlineAccess
  const page = offlineAccess?'marking':location.page==='settings'&&user.role==='manager'?'scanner':management || ['dashboard','marking','results','account'].includes(location.page) ? location.page : 'dashboard'
  const items = [
    { key: 'dashboard', icon: <ApartmentOutlined />, label: '工作概览' },
    { type: 'group' as const, key: 'work', label: '考试工作', children: [
      ...(management ? [{key:'scanner',icon:<ScanOutlined/>,label:'扫描台'},{ key: 'exams', icon: <BookOutlined />, label: '考试项目' }] : []),
      { key: 'marking', icon: <AuditOutlined />, label: '阅卷中心' },
      ...(management ? [{ key: 'exceptions', icon: <FileSearchOutlined />, label: '异常总览' }] : []),
      { key: 'results', icon: <ReadOutlined />, label: '成绩总览' },
    ] },
    ...(management ? [{ type: 'group' as const, key: 'management', label: '基础管理', children: [
      { key: 'people', icon: <TeamOutlined />, label: '人员与班级' },
      { key: 'archives', icon: <BookOutlined />, label: '归档文件' },
      ...(user.role==='admin'?[{ key: 'settings', icon: <SettingOutlined />, label: '系统设置' }]:[]),
    ] }] : []),
    { key: 'account', icon: <SettingOutlined />, label: '个人账号' },
  ]
  const title = items.flatMap(i => 'children' in i ? i.children || [] : [i]).find(i => i.key === page)?.label || '工作概览'
  return <ReviewWorkspace key={user.id} user={user} offline={offlineAccess} onVerified={acceptUser} onLoginRequired={endSession}><Layout className={`app-shell mode-${mobile}`}>
    <Layout.Sider width={200} collapsedWidth={64} collapsed={collapsed} className="sidebar" breakpoint="lg" onBreakpoint={broken => setCollapsed(broken)}>
      <Brand compact={collapsed} />
      <Menu theme="light" mode="inline" items={items} selectedKeys={[page]} onClick={({ key }) => setPage(key)} />
    </Layout.Sider>
    <Layout>
      <Layout.Header className="topbar"><Space className="topbar-left"><Button type="text" aria-label={collapsed?'展开导航':'收起导航'} icon={<MenuOutlined />} onClick={() => setCollapsed(!collapsed)} /><span className="breadcrumb">{management ? '管理后台' : '阅卷台'} <span>/</span> {title}</span></Space><Space size={8} className="topbar-actions"><Select aria-label="显示模式" style={{width:88}} size="small" value={mobile} onChange={value => setMobile(value)} options={[{ label: '自适应', value: 'auto' }, { label: '电脑', value: 'desktop' }, { label: '手机', value: 'mobile' }]} /><PwaStatus/><RealtimeStatus user={user} onProfile={setUser} onExpired={endSession}/>{admin && <Button type="text" onClick={()=>{if(!confirmLeaving())return;const next:Portal=management?'marking':'admin';setPortal(next);sessionStorage.setItem('omp-portal',next);navigate(next==='admin'?'#/scanner':'#/marking')}}>{management?'进入阅卷台':'进入管理后台'}</Button>}<Avatar size="small">{user.name.slice(0, 1)}</Avatar><Text className="account-name" ellipsis>{user.name}</Text><Button type="text" icon={<LogoutOutlined />} onClick={async () => { if(!confirmLeaving())return; await settleReviewWrites();await send('/auth/logout').catch(()=>{});endSession() }}>退出</Button></Space></Layout.Header>
      <Layout.Content className="page-content"><div className="page-heading" hidden={page === 'exams' && !!location.projectId}><div><Title level={2}>{title}</Title></div><Tag className="account-tag">{user.role==='admin'?'系统管理员':user.role==='manager'?'管理教师':'阅卷教师'} · {user.username}</Tag></div>
        {page === 'dashboard' && <Dashboard onNavigate={setPage} admin={management} />}
        {page === 'exams' && <Exams location={location} navigate={navigate} />}
        {page === 'marking' && <Marking admin={management} />}
        {page === 'exceptions' && <Exceptions />}
        {page === 'results' && <Results admin={management} />}
        {page === 'archives' && <ArchiveManager/>}
        {page === 'people' && <DataManagement systemAdmin={user.role==='admin'}/>}
        {page === 'settings' && user.role==='admin' && <Settings />}
        {page === 'scanner' && management && <ScannerDesk/>}
        {page === 'account' && <Account user={user} onProfile={setUser} onLogout={endSession}/>}
      </Layout.Content>
    </Layout>
  </Layout></ReviewWorkspace>
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
