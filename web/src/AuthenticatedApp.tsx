import { useState } from 'react'
import { Alert, App as AntApp, Avatar, ConfigProvider, Layout, Menu, Space, Tag, Typography } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ScanOutlined, ApartmentOutlined, AuditOutlined, BookOutlined, FileSearchOutlined, LogoutOutlined, ReadOutlined, SettingOutlined, TeamOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { Brand } from './Brand'
import { request, type User } from './api'
import { confirmLeaving, type useNavigation } from './useNavigation'
import { guardView, markingPath } from './examNavigation'
import { ReviewWorkspace } from './ReviewWorkspace'
import { RealtimeStatus } from './RealtimeStatus'
import { SessionActivity } from './SessionActivity'
import { settleReviewWrites } from './reviewStore'
import type { Portal } from './Login'
import type { ProjectFilter } from './reviewProjects'
import { uiTheme } from './uiTheme'
import { loadPage } from './loadPage'
import './styles.css'

const { Text, Title } = Typography
const HttpGuard = loadPage(() => import('./HttpGuard'))
const Dashboard = loadPage(() => import('./Dashboard').then(module => ({ default: module.Dashboard })))
const SubjectCatalog = loadPage(() => import('./Electives').then(module => ({ default: module.SubjectCatalog })))
const ElectiveManagement = loadPage(() => import('./Electives').then(module => ({ default: module.ElectiveManagement })))
const Exams = loadPage(() => import('./Exams').then(module => ({ default: module.Exams })))
const Marking = loadPage(() => import('./Marking').then(module => ({ default: module.Marking })))
const ReviewTasks = loadPage(() => import('./ReviewTasks').then(module => ({ default: module.ReviewTasks })))
const Exceptions = loadPage(() => import('./Exceptions').then(module => ({ default: module.Exceptions })))
const Results = loadPage(() => import('./Results').then(module => ({ default: module.Results })))
const Conversions = loadPage(() => import('./Conversions').then(module => ({ default: module.Conversions })))
const ArchiveManager = loadPage(() => import('./ArchiveManager').then(module => ({ default: module.ArchiveManager })))
const Personnel = loadPage(() => import('./Personnel').then(module => ({ default: module.Personnel })))
const Settings = loadPage(() => import('./Management').then(module => ({ default: module.Settings })))
const ScannerDesk = loadPage(() => import('./ScannerDesk').then(module => ({ default: module.ScannerDesk })))
const Account = loadPage(() => import('./Account').then(module => ({ default: module.Account })))

type Props = ReturnType<typeof useNavigation> & {
  user: User; authToken: string; offlineAccess: boolean; management: boolean; page: string
  setPortal: (portal: Portal) => void; acceptUser: (user: User) => void; endSession: () => void
}

export default function AuthenticatedApp(props: Props) {
  return <ConfigProvider locale={zhCN} theme={uiTheme}><AntApp><Workspace {...props}/></AntApp></ConfigProvider>
}

function Workspace({ user, authToken, offlineAccess, management, page, location, navigate, setPortal, acceptUser, endSession }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [reviewFilter, setReviewFilter] = useState<ProjectFilter>('in_progress')
  const setPage = (page: string) => navigate('#/' + page)
  if (location.page === 'http-guard') {
    if (user.role !== 'admin' || offlineAccess) return <main className="screen-center"><Alert type="warning" showIcon message="仅系统管理员可访问 HTTP 防护工作台" action={<Button onClick={() => setPage(management ? 'scanner' : 'marking')}>返回工作台</Button>} /></main>
    return <><SessionActivity token={authToken}/><RealtimeStatus key={authToken} user={user} onProfile={acceptUser} onExpired={endSession}/>
        <HttpGuard view={guardView(location.section)} onView={view => navigate('#/http-guard/' + view)} onExit={() => setPage('scanner')} account={user.name} />
    </>
  }
  const items = [
    { key: 'dashboard', icon: <ApartmentOutlined />, label: '工作概览' },
    { type: 'group' as const, key: 'work', label: '考试工作', children: [
      ...(management ? [{key:'scanner',icon:<ScanOutlined/>,label:'扫描台'},{ key: 'exams', icon: <BookOutlined />, label: '考试项目' },{key:'subject-catalog',icon:<BookOutlined/>,label:'科目管理'},{key:'electives',icon:<TeamOutlined/>,label:'选科管理'}] : []),
      ...(!management ? [{ key: 'marking', icon: <AuditOutlined />, label: '阅卷中心' }] : []),
      ...(management ? [{ key: 'exceptions', icon: <FileSearchOutlined />, label: '异常总览' }] : []),
      { key: 'results', icon: <ReadOutlined />, label: management?'成绩总览':'成绩分析' },
      ...(management && user.role==='admin' ? [{key:'conversions',icon:<ReadOutlined/>,label:'赋分方案'}] : []),
    ] },
    ...(management ? [{ type: 'group' as const, key: 'management', label: '基础管理', children: [
      { key: 'people', icon: <TeamOutlined />, label: '人员与班级' },
      { key: 'archives', icon: <BookOutlined />, label: '归档文件' },
      ...(user.role==='admin'?[{ key: 'http-guard', icon: <AuditOutlined />, label: 'HTTP 防护' },{ key: 'settings', icon: <SettingOutlined />, label: '系统设置' }]:[]),
    ] }] : []),
    { key: 'account', icon: <SettingOutlined />, label: '个人账号' },
  ]
  const title = items.flatMap(i => 'children' in i ? i.children || [] : [i]).find(i => i.key === page)?.label || '工作概览'
  return <><SessionActivity token={authToken}/><RealtimeStatus key={authToken} user={user} onProfile={acceptUser} onExpired={endSession}/><ReviewWorkspace key={`${user.id}:${authToken}`} user={user} offline={offlineAccess} onVerified={acceptUser} onLoginRequired={endSession}>{page === 'marking' && location.templateId && location.questionId ? <main className="review-fullscreen"><Marking key={`${location.templateId}:${location.questionId}`} admin={false} initialProjectId={location.projectId} initialTemplateId={location.templateId} initialQuestionId={location.questionId} onExit={id => navigate(markingPath(id||location.projectId))} /></main> : page==='exams'&&location.groupId&&location.section==='template' ? <main className="template-fullscreen"><Exams location={location} navigate={navigate}/></main> : <Layout className="app-shell">
    <Layout.Sider width={200} collapsedWidth={64} collapsed={collapsed} className="sidebar" breakpoint="lg" onBreakpoint={broken => setCollapsed(broken)}>
      <Brand compact={collapsed} />
      <Menu theme="light" mode="inline" items={items} selectedKeys={[page]} onClick={({ key }) => setPage(key)} />
    </Layout.Sider>
    <Layout>
      <Layout.Header className="topbar"><Space className="topbar-left"><Button type="text" aria-label={collapsed?'展开导航':'收起导航'} icon={collapsed?<MenuUnfoldOutlined />:<MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} /><span className="breadcrumb">{management ? '管理后台' : '阅卷台'} <span>/</span> {title}</span></Space><Space size={8} className="topbar-actions">{user.role==='manager' && <Button type="text" onClick={()=>{if(!confirmLeaving())return;const next:Portal=management?'marking':'admin';setPortal(next);sessionStorage.setItem('omp-portal',next);navigate(next==='admin'?'#/scanner':'#/marking')}}>{management?'进入阅卷台':'进入管理后台'}</Button>}<Avatar size="small">{user.name.slice(0, 1)}</Avatar><Text className="account-name" ellipsis>{user.name}</Text><Button type="text" icon={<LogoutOutlined />} onClick={async () => { if(!confirmLeaving())return; const signedToken=authToken;await settleReviewWrites();await request('/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+signedToken}}).catch(()=>{});endSession() }}>退出</Button></Space></Layout.Header>
      <Layout.Content className={page==='marking'?'page-content marking-content':'page-content'}><div className="page-heading" hidden={page==='marking'||(page === 'exams' && !!location.projectId)}><div><Title level={2}>{title}</Title></div><Tag className="account-tag">{user.role==='admin'?'系统管理员':user.role==='manager'?'管理教师':'阅卷教师'} · {user.username}</Tag></div>
        {page === 'dashboard' && <Dashboard onNavigate={setPage} admin={management} />}
        {page === 'subject-catalog'&&management&&<SubjectCatalog/>}
        {page === 'electives'&&management&&<ElectiveManagement/>}
        {page === 'exams' && <Exams location={location} navigate={navigate} />}
        {page === 'marking' && <ReviewTasks projectId={location.projectId} filter={reviewFilter} onFilter={setReviewFilter}
          onProject={id=>navigate(markingPath(id))} onOpen={(tid,qid)=>navigate(markingPath(location.projectId,tid,qid))}/>}
        {page === 'exceptions' && <Exceptions />}
        {page === 'results' && <Results admin={management} />}
        {page === 'conversions' && management && user.role==='admin' && <Conversions/>}
        {page === 'archives' && <ArchiveManager/>}
        {page === 'people' && <Personnel systemAdmin={user.role==='admin'} tab={location.section||'users'} onTab={key=>navigate('#/people/'+key)}/>}
        {page === 'settings' && user.role==='admin' && <Settings tab={location.section||'login'} onTab={key=>navigate('#/settings/'+key)} />}
        {page === 'scanner' && management && <ScannerDesk systemAdmin={user.role==='admin'}/>}
        {page === 'account' && <Account user={user} onProfile={acceptUser} onLogout={endSession}/>}
      </Layout.Content>
    </Layout>
  </Layout>}</ReviewWorkspace></>
}
