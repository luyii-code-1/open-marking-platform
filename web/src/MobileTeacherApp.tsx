import { useEffect, useState } from 'react'
import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  Button,
  CapsuleTabs,
  ConfigProvider as AdmConfigProvider,
  Dialog,
  Empty,
  ErrorBlock,
  List,
  NavBar,
  NoticeBar,
  Popup,
  ProgressBar,
  SafeArea,
  SearchBar,
  Selector,
  Space,
  TabBar,
  Tag,
} from 'antd-mobile'
import admZhCN from 'antd-mobile/es/locales/zh-CN'
import { AuditOutlined, DesktopOutlined, LogoutOutlined, ReadOutlined, ReloadOutlined, UserOutlined } from '@ant-design/icons'
import { request, useResource, watchChanges, type User } from './api'
import { lessonPath, markingPath } from './examNavigation'
import { loadPage } from './loadPage'
import type { Portal } from './Login'
import { questionLabel } from './mergeQuestions'
import { MobileMarking } from './MobileMarking'
import { readMobileTask, type Platform } from './mobilePlatform'
import { RealtimeStatus } from './RealtimeStatus'
import { localProjectId, projectQuestions, questionKey, withCachedProjects, type AssignedQuestion, type ProjectFilter, type ReviewProject } from './reviewProjects'
import { hasUnsentReview, settleReviewWrites } from './reviewStore'
import { ReviewWorkspace, useReviewWorkspace } from './ReviewWorkspace'
import { SessionActivity } from './SessionActivity'
import { THEME_MODE_LABELS, useThemeMode, type ThemeMode } from './themeMode'
import { getUiTheme } from './uiTheme'
import { confirmLeaving, type useNavigation } from './useNavigation'
import { WorkspaceNotificationButton, WorkspaceNotificationsProvider, useWorkspaceNotifications } from './WorkspaceNotifications'
import './mobile-teacher.css'
import './mobile-adm.css'

const MobilePaperLesson = loadPage(() => import('./MobilePaperLesson'))
const MobileClassResults = loadPage(() => import('./MobileClassResults'))

type Props = ReturnType<typeof useNavigation> & {
  user: User
  authToken: string
  offlineAccess: boolean
  page: string
  setPortal: (portal: Portal) => void
  acceptUser: (user: User) => void
  endSession: () => void
  onSwitchPlatform: (platform: Platform) => void
}

const catalogChanges = ['projects', 'subjects', 'groups', 'templates', 'assignments', 'results']
const progressChanges = [...catalogChanges, 'tasks', 'review-results', 'submissions']

function useMobileReviewList<T>(path: string | null, changes: string[], interval: number) {
  const resource = useResource<T[]>(path, [], { live: false })
  const { reload } = resource
  useEffect(() => {
    if (!path) return
    const refresh = () => {
      if (document.visibilityState !== 'hidden' && navigator.onLine) void reload()
    }
    const timer = window.setInterval(refresh, interval)
    const unwatch = watchChanges(roots => {
      if (!roots || roots.some(root => changes.includes(root))) refresh()
    })
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      unwatch()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [path, reload, changes, interval])
  return resource
}

export default function MobileTeacherApp(props: Props) {
  const { resolved } = useThemeMode()
  const { user, authToken, offlineAccess, acceptUser, endSession } = props

  // Scope Ant Design Mobile theme tokens & dark mode to mobile session only; clean up on unmount.
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('omp-mobile-adm')
    root.setAttribute('data-prefers-color-scheme', resolved)
    return () => {
      root.classList.remove('omp-mobile-adm')
      root.removeAttribute('data-prefers-color-scheme')
    }
  }, [resolved])

  return (
    <AdmConfigProvider locale={admZhCN}>
      <ConfigProvider locale={zhCN} theme={getUiTheme(resolved)}>
        <AntApp>
          <WorkspaceNotificationsProvider
            isAdmin={false}
            offline={offlineAccess}
            renderDrawer={({ open, setOpen, slow, templateNotices, activityLoading, reloadActivity }) => (
              <Popup
                visible={open}
                onMaskClick={() => setOpen(false)}
                position="bottom"
                bodyStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '76dvh', display: 'flex', flexDirection: 'column' }}
              >
                <div className="m-adm-popup-head">
                  <strong>重要通知{templateNotices.length + (slow ? 1 : 0) > 0 ? `（${templateNotices.length + (slow ? 1 : 0)}）` : ''}</strong>
                  <Space style={{ '--gap': '8px' }}>
                    <Button size="mini" fill="outline" loading={activityLoading} onClick={() => void reloadActivity()}>刷新</Button>
                    <Button size="mini" fill="none" onClick={() => setOpen(false)}>关闭</Button>
                  </Space>
                </div>
                <div className="m-adm-popup-body">
                  {slow && <NoticeBar color="alert" wrap content="服务器响应较慢：正在自动降低状态查询频率，请稍候。" />}
                  {templateNotices.length > 0 ? (
                    <List>
                      {templateNotices.map(item => (
                        <List.Item
                          key={`tpl-${item.id}`}
                          title={
                            <div className="m-adm-tag-row">
                              <Tag color={item.kind === 'assigned_template' ? 'primary' : 'warning'}>
                                {item.kind === 'assigned_template' ? (item.status === 'rejected' ? '退回修改' : '制卡任务') : '待审核'}
                              </Tag>
                              <strong>{item.title}</strong>
                            </div>
                          }
                          description={[item.scope, item.detail].filter(Boolean).join(' · ')}
                          extra={
                            <Button
                              size="mini"
                              color="primary"
                              onClick={() => {
                                setOpen(false)
                                window.location.hash = item.href
                              }}
                            >
                              {item.action_label || '前往处理'}
                            </Button>
                          }
                        />
                      ))}
                    </List>
                  ) : (
                    <Empty description={slow ? '当前仅服务慢响应提醒' : '服务连接正常，暂无待处理通知'} />
                  )}
                </div>
              </Popup>
            )}
          >
            <SessionActivity token={authToken} />
            <RealtimeStatus key={authToken} user={user} onProfile={acceptUser} onExpired={endSession} />
            <ReviewWorkspace
              key={`${user.id}:${authToken}`}
              user={user}
              offline={offlineAccess}
              onVerified={acceptUser}
              onLoginRequired={endSession}
              renderQueueOverlay={({ open, setOpen, pending, failed, status, error, retry, exportRecords, forget }) => (
                <Popup
                  visible={open}
                  onMaskClick={() => setOpen(false)}
                  position="bottom"
                  bodyStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '78dvh', display: 'flex', flexDirection: 'column' }}
                >
                  <div className="m-adm-popup-head">
                    <strong>本地待传评分（{pending.length}）</strong>
                    <Space style={{ '--gap': '8px' }}>
                      {failed.length > 0 && <Button size="mini" color="primary" onClick={() => void retry()}>重试上传</Button>}
                      <Button size="mini" fill="outline" onClick={exportRecords}>导出</Button>
                      <Button size="mini" fill="none" onClick={() => setOpen(false)}>关闭</Button>
                    </Space>
                  </div>
                  <div className="m-adm-popup-body">
                    {error && <NoticeBar color="error" wrap content={`本地保存不可用：${error}`} />}
                    {status.message && <NoticeBar color="alert" wrap content={status.message} />}
                    {pending.length === 0 ? (
                      <Empty description="当前无本地待传评分" />
                    ) : (
                      <List>
                        {pending.map(r => (
                          <List.Item
                            key={r.key}
                            title={`${r.template.name} · 第 ${questionLabel(r.question)} 题 · ${r.operation?.score ?? '—'} 分`}
                            description={r.error || (r.status === 'failed' ? '上传失败，可重试' : '等待服务器确认')}
                            extra={
                              r.status === 'conflict' ? (
                                <Button
                                  size="mini"
                                  color="danger"
                                  fill="outline"
                                  onClick={async () => {
                                    const ok = await Dialog.confirm({
                                      title: '移除本地冲突记录',
                                      content: '确认已核对或导出这份记录？仅移除本地记录，服务器评分保持当前结果。',
                                      confirmText: '移除',
                                      cancelText: '取消',
                                    })
                                    if (ok) await forget(r.owner, r.task.id)
                                  }}
                                >
                                  移除
                                </Button>
                              ) : (
                                <Tag color={r.status === 'failed' ? 'danger' : 'warning'}>
                                  {r.status === 'failed' ? '待重试' : '待确认'}
                                </Tag>
                              )
                            }
                          />
                        ))}
                      </List>
                    )}
                  </div>
                </Popup>
              )}
            >
              <MobileWorkspace {...props} />
            </ReviewWorkspace>
          </WorkspaceNotificationsProvider>
        </AntApp>
      </ConfigProvider>
    </AdmConfigProvider>
  )
}

function MobileWorkspace({ user, authToken, page, location, navigate, setPortal, endSession, onSwitchPlatform }: Props) {
  const [filter, setFilter] = useState<ProjectFilter>('in_progress')
  const { offline } = useReviewWorkspace()
  const isLessonSection = location.page === 'lesson' || location.page === 'results'
  const isFullscreenMarking = page === 'marking' && !!location.templateId && !!location.questionId

  useEffect(() => {
    if (offline && isLessonSection) navigate(markingPath(), true)
  }, [offline, isLessonSection, navigate])

  if (isFullscreenMarking) {
    return (
      <MobileMarking
        key={`${location.templateId}:${location.questionId}`}
        initialProjectId={location.projectId}
        initialTemplateId={location.templateId!}
        initialQuestionId={location.questionId!}
        onBack={projectId => navigate(markingPath(projectId || location.projectId))}
        onSwitchDesktop={() => onSwitchPlatform('desktop')}
      />
    )
  }

  const activeTab = page === 'account' ? 'account' : isLessonSection && !offline ? 'lesson' : 'marking'

  return (
    <div className="m-adm-shell">
      {page === 'account' ? (
        <MobileAccount
          user={user}
          authToken={authToken}
          onSwitchDesktop={() => onSwitchPlatform('desktop')}
          onEnterManagement={() => {
            if (!confirmLeaving()) return
            setPortal('admin')
            sessionStorage.setItem('omp-portal', 'admin')
            onSwitchPlatform('desktop')
            navigate('#/dashboard')
          }}
          onLogout={endSession}
        />
      ) : page === 'lesson' && !offline ? (
        <MobilePaperLesson
          initial={location.lessonScope ?? {}}
          backLabel={location.reviewProject ? '返回考试' : undefined}
          onBack={location.reviewProject ? () => navigate(markingPath(location.reviewProject)) : undefined}
          onOpenResults={() => navigate('#/results')}
          onScopeChange={scope => navigate(lessonPath(scope, location.reviewProject), true)}
        />
      ) : page === 'results' && !offline ? (
        <MobileClassResults location={location} navigate={navigate} onSwitchDesktop={() => onSwitchPlatform('desktop')} />
      ) : page === 'dashboard' || page === 'marking' || (isLessonSection && offline) ? (
        <MobileHome
          projectId={location.projectId}
          filter={filter}
          onFilter={setFilter}
          onProject={id => navigate(markingPath(id))}
          onOpen={(projectId, templateId, questionId) => navigate(markingPath(projectId, templateId, questionId))}
          onLesson={project => navigate(lessonPath({ project }, project))}
          onSwitchDesktop={() => onSwitchPlatform('desktop')}
        />
      ) : (
        <MobileDesktopHandoff
          page={page}
          onSwitchDesktop={() => onSwitchPlatform('desktop')}
          onBackHome={() => navigate('#/marking')}
        />
      )}

      <div className="m-adm-tabbar-wrap">
        <TabBar
          activeKey={activeTab}
          onChange={key => {
            if (key === 'marking') navigate('#/marking')
            else if (key === 'lesson') navigate(lessonPath())
            else if (key === 'account') navigate('#/account')
          }}
        >
          <TabBar.Item key="marking" icon={<AuditOutlined />} title="我的阅卷" />
          {!offline && <TabBar.Item key="lesson" icon={<ReadOutlined />} title="试卷讲评" />}
          <TabBar.Item key="account" icon={<UserOutlined />} title="我的" />
        </TabBar>
        <SafeArea position="bottom" />
      </div>
    </div>
  )
}

function StatusTag({ value }: { value: string }) {
  if (value === 'cached') return <Tag fill="outline">本机缓存</Tag>
  if (value === 'pending_review') return <Tag color="warning">等待审查</Tag>
  return value === 'completed' ? <Tag fill="outline">已结束</Tag> : <Tag color="primary">进行中</Tag>
}

function MobileHome({
  projectId,
  filter,
  onFilter,
  onProject,
  onOpen,
  onLesson,
  onSwitchDesktop,
}: {
  projectId?: string
  filter: ProjectFilter
  onFilter: (filter: ProjectFilter) => void
  onProject: (id?: string) => void
  onOpen: (projectId: string | undefined, templateId: string, questionId: string) => void
  onLesson: (project?: string) => void
  onSwitchDesktop: () => void
}) {
  const workspace = useReviewWorkspace()
  const [search, setSearch] = useState('')
  const catalog = useMobileReviewList<ReviewProject>(workspace.offline ? null : '/review-projects', catalogChanges, 60000)
  const { projects, cached } = withCachedProjects(catalog.data, workspace.records)
  const currentProject = projects.find(p => p.id === projectId)
  const isInProgress = (p: ReviewProject & { recently_completed?: boolean }) =>
    p.exam_status === 'in_progress' || p.exam_status === 'cached' || p.exam_status === 'pending_review' || (p.exam_status === 'completed' && !!p.recently_completed)
  const inProgressProjects = projects.filter(isInProgress)
  const firstActiveProject = inProgressProjects[0]
  const firstActivePath = !projectId && !workspace.offline && firstActiveProject && firstActiveProject.id !== localProjectId
    ? '/review-task-progress?project_id=' + encodeURIComponent(firstActiveProject.id)
    : null
  const firstProjectTasks = useMobileReviewList<AssignedQuestion>(firstActivePath, progressChanges, 30000)

  if (projectId) {
    return (
      <MobileProjectQuestions
        key={projectId}
        projectId={projectId}
        project={currentProject}
        cached={cached.get(projectId)}
        catalogPending={!workspace.offline && !catalog.loaded}
        catalogError={catalog.error}
        onBack={() => onProject()}
        onOpen={(templateId, questionId) => onOpen(projectId, templateId, questionId)}
        onLesson={() => onLesson(projectId)}
      />
    )
  }

  const localDraft = workspace.records.find(r => r.status === 'draft' && hasUnsentReview(r))
    || workspace.records.find(r => r.status === 'draft')
  const rawRemembered = readMobileTask(workspace.user.id)
  const rememberedValid = !!rawRemembered && (
    workspace.records.some(r => r.template.id === rawRemembered.templateId && r.question.id === rawRemembered.questionId)
    || workspace.offline
    || !catalog.loaded
    || projects.some(p => p.template_ids.includes(rawRemembered.templateId))
  )
  const remembered = rememberedValid ? rawRemembered : null
  const fallbackQuestion = projectQuestions(firstProjectTasks.data, firstActiveProject ? cached.get(firstActiveProject.id) : undefined)
    .find(q => !q.published)

  const resumeTarget = localDraft
    ? {
      badge: hasUnsentReview(localDraft) ? '本地待续任务' : '当前任务',
      title: `${localDraft.template.subject_name ? localDraft.template.subject_name + ' · ' : ''}第 ${localDraft.question.number} 题`,
      subtitle: localDraft.template.project_name || localDraft.template.name,
      projectId: localDraft.template.project_id,
      templateId: localDraft.template.id,
      questionId: localDraft.question.id,
    }
    : remembered
      ? {
        badge: '上次阅卷',
        title: `${remembered.subjectName ? remembered.subjectName + ' · ' : ''}${remembered.questionLabel ? `第 ${remembered.questionLabel} 题` : remembered.templateName || '继续任务'}`,
        subtitle: remembered.projectName || remembered.templateName || '点击继续评阅',
        projectId: remembered.projectId,
        templateId: remembered.templateId,
        questionId: remembered.questionId,
      }
      : fallbackQuestion && firstActiveProject
        ? {
          badge: fallbackQuestion.arbitration_pending ? '待仲裁任务' : '当前任务',
          title: `${fallbackQuestion.subject_name ? fallbackQuestion.subject_name + ' · ' : ''}第 ${fallbackQuestion.question_label} 题`,
          subtitle: firstActiveProject.name,
          projectId: firstActiveProject.id,
          templateId: fallbackQuestion.template_id,
          questionId: fallbackQuestion.question_id,
        }
        : null

  const counts = {
    in_progress: inProgressProjects.length,
    completed: projects.filter(p => p.exam_status === 'completed').length,
    all: projects.length,
  }
  const term = search.trim().toLocaleLowerCase()
  const visible = projects
    .filter(p => filter === 'all' || (filter === 'in_progress' ? isInProgress(p) : p.exam_status === filter))
    .filter(p => !term || `${p.name} ${p.subjects.join(' ')}`.toLocaleLowerCase().includes(term))

  return (
    <>
      <div className="m-adm-header-sticky">
        <NavBar
          back={null}
          right={
            <div className="m-adm-nav-right">
              {!workspace.offline && <WorkspaceNotificationButton compact />}
              {!workspace.offline && (
                <button type="button" className="m-adm-nav-btn" aria-label="刷新任务" disabled={catalog.loading} onClick={() => void catalog.reload()}>
                  <ReloadOutlined spin={catalog.loading} />
                </button>
              )}
              <button type="button" className="m-adm-nav-btn" aria-label="切换桌面版" onClick={onSwitchDesktop}>
                <DesktopOutlined />
              </button>
            </div>
          }
        >
          我的阅卷
        </NavBar>
      </div>

      <main className="m-adm-body">
        {workspace.offline && <NoticeBar color="info" wrap content="当前处于离线模式，仅展示本机已缓存的阅卷任务。" />}
        {workspace.pendingCount > 0 && (
          <NoticeBar
            color="alert"
            wrap
            content={`本机有 ${workspace.pendingCount} 份评分待确认或补传，联网后自动同步。`}
            extra={<Button size="mini" fill="outline" onClick={workspace.openQueueModal}>查看记录</Button>}
          />
        )}
        {catalog.error && (
          <ErrorBlock status="default" title="考试列表加载失败" description={catalog.error}>
            <Button size="small" color="primary" onClick={() => void catalog.reload()}>重试</Button>
          </ErrorBlock>
        )}

        {resumeTarget && (
          <section className="m-adm-resume" aria-label="继续阅卷">
            <span className="m-adm-resume-badge">{resumeTarget.badge}</span>
            <h2 className="m-adm-resume-title">{resumeTarget.title}</h2>
            <p className="m-adm-resume-sub">{resumeTarget.subtitle}</p>
            <Button
              block
              color="primary"
              size="large"
              onClick={() => onOpen(resumeTarget.projectId, resumeTarget.templateId, resumeTarget.questionId)}
            >
              继续阅卷
            </Button>
          </section>
        )}

        <CapsuleTabs activeKey={filter} onChange={key => onFilter(key as ProjectFilter)}>
          <CapsuleTabs.Tab title={`进行中 (${counts.in_progress})`} key="in_progress" />
          <CapsuleTabs.Tab title={`已结束 (${counts.completed})`} key="completed" />
          <CapsuleTabs.Tab title={`全部 (${counts.all})`} key="all" />
        </CapsuleTabs>

        {projects.length > 0 && (
          <SearchBar placeholder="搜索考试名称或科目" value={search} onChange={setSearch} />
        )}

        {visible.length === 0 ? (
          <Empty
            description={
              term
                ? '没有匹配的考试项目'
                : projects.length
                  ? '此状态下暂无考试'
                  : workspace.offline
                    ? '本机暂无缓存的阅卷任务，联网后可在阅卷中心领取。'
                    : !catalog.loaded
                      ? '正在加载阅卷考试…'
                      : '暂无分配给你的阅卷考试，请联系管理员在题卡的「阅卷分配」中添加。'
            }
          />
        ) : (
          <List mode="card" header="分配的考试">
            {visible.map(p => (
              <List.Item
                key={p.id}
                title={p.name}
                description={
                  <>
                    {p.subjects.length ? `${p.subjects.join('、')} · ` : ''}{p.question_count} 道分配题目
                    {p.created_at ? ` · ${new Date(p.created_at * 1000).toLocaleString()}` : ''}
                  </>
                }
                extra={<StatusTag value={p.exam_status} />}
                arrow
                onClick={() => onProject(p.id)}
              />
            ))}
          </List>
        )}
      </main>
    </>
  )
}

function MobileProjectQuestions({
  projectId,
  project,
  cached,
  catalogPending,
  catalogError,
  onBack,
  onOpen,
  onLesson,
}: {
  projectId: string
  project?: ReviewProject
  cached?: Map<string, AssignedQuestion>
  catalogPending: boolean
  catalogError: string
  onBack: () => void
  onOpen: (templateId: string, questionId: string) => void
  onLesson: () => void
}) {
  const workspace = useReviewWorkspace()
  const path = workspace.offline || projectId === localProjectId
    ? null
    : '/review-task-progress?project_id=' + encodeURIComponent(projectId)
  const progress = useMobileReviewList<AssignedQuestion>(path, progressChanges, 15000)
  const rows = projectQuestions(progress.data, cached)
  const pendingArbitration = rows.reduce((sum, row) => sum + (row.arbitration_pending || 0), 0)

  return (
    <>
      <div className="m-adm-header-sticky">
        <NavBar
          back="考试"
          onBack={onBack}
          right={
            path ? (
              <button type="button" className="m-adm-nav-btn" aria-label="刷新进度" disabled={progress.loading} onClick={() => void progress.reload()}>
                <ReloadOutlined spin={progress.loading} />
              </button>
            ) : null
          }
        >
          {project?.name || '考试阅卷任务'}
        </NavBar>
      </div>

      <main className="m-adm-body">
        {(progress.error || catalogError) && (
          <ErrorBlock status="default" title="题目任务加载失败" description={progress.error || catalogError}>
            {path && <Button size="small" color="primary" onClick={() => void progress.reload()}>重试</Button>}
          </ErrorBlock>
        )}
        {pendingArbitration > 0 && <NoticeBar color="alert" wrap content={`本场有 ${pendingArbitration} 份答卷待你仲裁，请优先处理。`} />}

        {!workspace.offline && project && project.id !== localProjectId && (
          <List mode="card">
            <List.Item prefix={<ReadOutlined />} title="本场试卷讲评" extra="查看统计" arrow onClick={onLesson} />
          </List>
        )}

        {catalogPending || (!progress.loaded && progress.loading) ? (
          <Empty description="正在加载分配题目…" />
        ) : rows.length === 0 ? (
          <Empty description="本场暂无分配给你的阅卷题目" />
        ) : (
          <List mode="card" header={`已分配题目（${rows.length} 道）`}>
            {rows.map(row => {
              const total = (row.ordinary_total || 0) + (row.arbitration_total || 0)
              const done = (row.ordinary_completed || 0) + (row.arbitration_completed || 0)
              const percent = total ? Math.round((done / total) * 100) : 0
              const cardSubtitle = [row.grade_name, row.card_name && row.card_name !== 'Default' ? row.card_name : row.template_name].filter(Boolean).join(' · ')
              const actionLabel = row.published ? '查看记录' : row.arbitration_pending ? '进入仲裁' : row.cached ? '继续阅卷' : row.ordinary_pending ? '进入阅卷' : row.reopened ? '复核回评' : '历史与回评'

              return (
                <List.Item
                  key={questionKey(row)}
                  onClick={() => onOpen(row.template_id, row.question_id)}
                  arrow
                  extra={<span style={{ fontSize: 13, color: 'var(--adm-color-primary)', fontWeight: 500 }}>{actionLabel}</span>}
                  title={
                    <div className="m-adm-tag-row">
                      <strong>{row.subject_name ? `${row.subject_name} · ` : ''}第 {row.question_label} 题</strong>
                      <Tag fill="outline">{row.points} 分</Tag>
                      <Tag fill="outline">{row.review_mode === 'double' ? '双评' : '单评'}</Tag>
                      {row.published && <Tag color="danger">已锁定</Tag>}
                      {!row.published && row.reopened && <Tag color="primary">复核中</Tag>}
                      {!!row.arbitration_pending && <Tag color="warning">待仲裁 {row.arbitration_pending}</Tag>}
                    </div>
                  }
                  description={
                    <div className="m-adm-progress-meta">
                      <span>{cardSubtitle}</span>
                      <span>
                        {row.ordinary_total === undefined
                          ? '本机已缓存'
                          : `阅卷 ${row.ordinary_completed || 0} / ${row.ordinary_total} · 仲裁 ${row.arbitration_completed || 0} / ${row.arbitration_total || 0}`}
                      </span>
                      {row.ordinary_total !== undefined && <ProgressBar percent={percent} />}
                    </div>
                  }
                />
              )
            })}
          </List>
        )}
      </main>
    </>
  )
}

function MobileAccount({
  user,
  authToken,
  onSwitchDesktop,
  onEnterManagement,
  onLogout,
}: {
  user: User
  authToken: string
  onSwitchDesktop: () => void
  onEnterManagement: () => void
  onLogout: () => void
}) {
  const { mode, setMode } = useThemeMode()
  const workspace = useReviewWorkspace()
  const notifications = useWorkspaceNotifications()
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    if (!confirmLeaving() || loggingOut) return
    const ok = await Dialog.confirm({ content: '确认退出当前账号？', confirmText: '退出登录', cancelText: '取消' })
    if (!ok) return
    setLoggingOut(true)
    try {
      await settleReviewWrites()
      await request('/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + authToken } }).catch(() => {})
      onLogout()
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <>
      <div className="m-adm-header-sticky">
        <NavBar back={null}>我的</NavBar>
      </div>

      <main className="m-adm-body">
        <List mode="card" header="账号信息">
          <List.Item
            prefix={<div className="m-avatar" aria-hidden="true">{user.name.slice(0, 1)}</div>}
            title={
              <div className="m-adm-tag-row">
                <strong>{user.name}</strong>
                <Tag color="primary" fill="outline">{user.role === 'manager' ? '管理教师' : '阅卷教师'}</Tag>
              </div>
            }
            description={`账号：${user.username}`}
          />
        </List>

        <List mode="card" header="外观主题">
          <List.Item>
            <Selector
              columns={3}
              value={[mode]}
              options={(['light', 'dark', 'system'] as ThemeMode[]).map(value => ({ label: THEME_MODE_LABELS[value], value }))}
              onChange={arr => arr[0] && setMode(arr[0] as ThemeMode)}
            />
          </List.Item>
        </List>

        <List mode="card" header="工作区与数据">
          {workspace.pendingCount > 0 && (
            <List.Item title="本地待传评分" extra={<Tag color="warning">{workspace.pendingCount} 份</Tag>} arrow onClick={workspace.openQueueModal} />
          )}
          {!workspace.offline && (
            <List.Item title="重要通知" extra={notifications.templateNotices.length + (notifications.slow ? 1 : 0) || '查看'} arrow onClick={() => notifications.setOpen(true)} />
          )}
          <List.Item prefix={<DesktopOutlined />} title="切换为桌面版界面" arrow onClick={onSwitchDesktop} />
          {user.role === 'manager' && (
            <List.Item title="进入管理后台（桌面版）" arrow onClick={onEnterManagement} />
          )}
        </List>

        <Button
          block
          color="danger"
          fill="outline"
          size="large"
          loading={loggingOut}
          onClick={() => void handleLogout()}
        >
          <LogoutOutlined /> 退出登录
        </Button>
      </main>
    </>
  )
}

const DESKTOP_PAGE_LABELS: Record<string, string> = {
  'teacher-templates': '制卡中心',
}

function MobileDesktopHandoff({
  page,
  onSwitchDesktop,
  onBackHome,
}: {
  page: string
  onSwitchDesktop: () => void
  onBackHome: () => void
}) {
  const label = DESKTOP_PAGE_LABELS[page] || '当前页面'
  return (
    <>
      <div className="m-adm-header-sticky">
        <NavBar back="返回" onBack={onBackHome}>{label}</NavBar>
      </div>
      <main className="m-adm-body" style={{ justifyContent: 'center' }}>
        <Empty description={`「${label}」请在桌面版打开`} />
        <Button block color="primary" size="large" onClick={onSwitchDesktop}>
          <DesktopOutlined /> 在桌面版打开「{label}」
        </Button>
        <Button block fill="outline" onClick={onBackHome}>返回我的阅卷</Button>
      </main>
    </>
  )
}
