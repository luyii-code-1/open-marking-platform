import { useEffect, useState } from 'react'
import { App as AntApp, ConfigProvider, Tag } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ArrowLeftOutlined, AuditOutlined, DesktopOutlined, LogoutOutlined, ReloadOutlined, UserOutlined } from '@ant-design/icons'
import { request, useResource, watchChanges, type User } from './api'
import { markingPath } from './examNavigation'
import type { Portal } from './Login'
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
import './mobile-teacher.css'

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
  return (
    <ConfigProvider locale={zhCN} theme={getUiTheme(resolved)}>
      <AntApp>
        <MobileWorkspace {...props} />
      </AntApp>
    </ConfigProvider>
  )
}

function MobileWorkspace({ user, authToken, offlineAccess, page, location, navigate, setPortal, acceptUser, endSession, onSwitchPlatform }: Props) {
  const [filter, setFilter] = useState<ProjectFilter>('in_progress')
  const isFullscreenMarking = page === 'marking' && !!location.templateId && !!location.questionId

  return (
    <>
      <SessionActivity token={authToken} />
      <RealtimeStatus key={authToken} user={user} onProfile={acceptUser} onExpired={endSession} />
      <ReviewWorkspace key={`${user.id}:${authToken}`} user={user} offline={offlineAccess} onVerified={acceptUser} onLoginRequired={endSession}>
        {isFullscreenMarking ? (
          <MobileMarking
            key={`${location.templateId}:${location.questionId}`}
            initialProjectId={location.projectId}
            initialTemplateId={location.templateId!}
            initialQuestionId={location.questionId!}
            onBack={projectId => navigate(markingPath(projectId || location.projectId))}
            onSwitchDesktop={() => onSwitchPlatform('desktop')}
          />
        ) : (
          <div className="m-shell">
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
            ) : page === 'dashboard' || page === 'marking' ? (
              <MobileHome
                projectId={location.projectId}
                filter={filter}
                onFilter={setFilter}
                onProject={id => navigate(markingPath(id))}
                onOpen={(projectId, templateId, questionId) => navigate(markingPath(projectId, templateId, questionId))}
                onSwitchDesktop={() => onSwitchPlatform('desktop')}
              />
            ) : (
              <MobileDesktopHandoff
                page={page}
                onSwitchDesktop={() => onSwitchPlatform('desktop')}
                onBackHome={() => navigate('#/marking')}
              />
            )}

            <nav className="m-bottom-nav" aria-label="手机教师端导航">
              <button
                type="button"
                aria-current={page === 'dashboard' || page === 'marking' ? 'page' : undefined}
                onClick={() => navigate('#/marking')}
              >
                <AuditOutlined />
                <span>我的阅卷</span>
              </button>
              <button
                type="button"
                aria-current={page === 'account' ? 'page' : undefined}
                onClick={() => navigate('#/account')}
              >
                <UserOutlined />
                <span>个人账号</span>
              </button>
            </nav>
          </div>
        )}
      </ReviewWorkspace>
    </>
  )
}

function StatusTag({ value }: { value: string }) {
  if (value === 'cached') return <Tag style={{ margin: 0 }}>本机缓存</Tag>
  if (value === 'pending_review') return <Tag color="warning" style={{ margin: 0 }}>等待审查</Tag>
  return value === 'completed' ? <Tag style={{ margin: 0 }}>已结束</Tag> : <Tag color="processing" style={{ margin: 0 }}>进行中</Tag>
}

function MobileHome({
  projectId,
  filter,
  onFilter,
  onProject,
  onOpen,
  onSwitchDesktop,
}: {
  projectId?: string
  filter: ProjectFilter
  onFilter: (filter: ProjectFilter) => void
  onProject: (id?: string) => void
  onOpen: (projectId: string | undefined, templateId: string, questionId: string) => void
  onSwitchDesktop: () => void
}) {
  const workspace = useReviewWorkspace()
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
      />
    )
  }

  // Resolve best "继续阅卷" target: local draft > remembered task > first assigned question
  const localDraft = workspace.records.find(r => r.status === 'draft' && hasUnsentReview(r))
    || workspace.records.find(r => r.status === 'draft')
  const remembered = readMobileTask(workspace.user.id)
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
  const visible = projects.filter(p => filter === 'all' || (filter === 'in_progress' ? isInProgress(p) : p.exam_status === filter))
  const pendingLocalCount = workspace.records.filter(r => r.operation).length

  return (
    <main className="m-page">
      <header className="m-home-head">
        <div>
          <small>教师工作台</small>
          <h1>我的阅卷</h1>
        </div>
        <div className="m-head-actions">
          {!workspace.offline && (
            <button type="button" className="m-icon-btn" aria-label="刷新任务" disabled={catalog.loading} onClick={() => void catalog.reload()}>
              <ReloadOutlined spin={catalog.loading} />
            </button>
          )}
          <button type="button" className="m-icon-btn" onClick={onSwitchDesktop}>
            <DesktopOutlined />
            <span>桌面版</span>
          </button>
        </div>
      </header>

      {workspace.offline && <div className="m-banner info">当前处于离线模式，仅展示本机已缓存的阅卷任务。</div>}
      {pendingLocalCount > 0 && <div className="m-banner warn">本机有 {pendingLocalCount} 份评分待确认或补传，联网后将自动同步。</div>}
      {catalog.error && <div className="m-banner error" role="alert">{catalog.error}</div>}

      {resumeTarget && (
        <section className="m-resume-card" aria-label="继续阅卷">
          <small>{resumeTarget.badge}</small>
          <h2>{resumeTarget.title}</h2>
          <p className="m-resume-meta">{resumeTarget.subtitle}</p>
          <button
            type="button"
            className="m-primary-btn"
            onClick={() => onOpen(resumeTarget.projectId, resumeTarget.templateId, resumeTarget.questionId)}
          >
            继续阅卷 <span aria-hidden="true">→</span>
          </button>
        </section>
      )}

      <section className="m-section" aria-label="分配的考试">
        <div className="m-section-head">
          <h3>{filter === 'in_progress' ? '进行中的考试' : filter === 'completed' ? '已结束的考试' : '全部考试'}</h3>
        </div>

        <div className="m-filter-pills" role="group" aria-label="按考试状态筛选">
          <button type="button" className="m-filter-pill" aria-pressed={filter === 'in_progress'} onClick={() => onFilter('in_progress')}>
            进行中 ({counts.in_progress})
          </button>
          <button type="button" className="m-filter-pill" aria-pressed={filter === 'completed'} onClick={() => onFilter('completed')}>
            已结束 ({counts.completed})
          </button>
          <button type="button" className="m-filter-pill" aria-pressed={filter === 'all'} onClick={() => onFilter('all')}>
            全部 ({counts.all})
          </button>
        </div>

        {visible.length === 0 ? (
          <div className="m-empty">
            <span>
              {projects.length
                ? '此状态下暂无考试'
                : workspace.offline
                  ? '本机暂无缓存的阅卷任务，联网后可在阅卷中心领取。'
                  : !catalog.loaded
                    ? '正在加载阅卷考试…'
                    : '暂无分配给你的阅卷考试，请联系管理员在题卡的「阅卷分配」中添加。'}
            </span>
            {projects.length > 0 && filter !== 'all' && (
              <button type="button" className="m-secondary-btn" onClick={() => onFilter('all')}>查看全部考试</button>
            )}
          </div>
        ) : (
          <div className="m-list">
            {visible.map(p => (
              <button key={p.id} type="button" className="m-list-item" onClick={() => onProject(p.id)}>
                <div className="m-list-main">
                  <div className="m-list-title">
                    <span>{p.name}</span>
                    <StatusTag value={p.exam_status} />
                  </div>
                  <span className="m-list-sub">
                    {p.subjects.length ? `${p.subjects.join('、')} · ` : ''}{p.question_count} 道分配题目
                  </span>
                </div>
                <span className="m-chevron" aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
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
}: {
  projectId: string
  project?: ReviewProject
  cached?: Map<string, AssignedQuestion>
  catalogPending: boolean
  catalogError: string
  onBack: () => void
  onOpen: (templateId: string, questionId: string) => void
}) {
  const workspace = useReviewWorkspace()
  const path = workspace.offline || projectId === localProjectId
    ? null
    : '/review-task-progress?project_id=' + encodeURIComponent(projectId)
  const progress = useMobileReviewList<AssignedQuestion>(path, progressChanges, 15000)
  const rows = projectQuestions(progress.data, cached)
  const pendingArbitration = rows.reduce((sum, row) => sum + (row.arbitration_pending || 0), 0)

  return (
    <main className="m-page">
      <header className="m-subbar">
        <button type="button" className="m-subbar-back" aria-label="返回考试列表" onClick={onBack}>
          <ArrowLeftOutlined />
        </button>
        <div className="m-subbar-title">
          <strong>{project?.name || '考试阅卷任务'}</strong>
          <small>{rows.length} 道分配题目</small>
        </div>
        {path && (
          <button type="button" className="m-icon-btn" aria-label="刷新进度" disabled={progress.loading} onClick={() => void progress.reload()}>
            <ReloadOutlined spin={progress.loading} />
          </button>
        )}
      </header>

      {(progress.error || catalogError) && <div className="m-banner error" role="alert">{progress.error || catalogError}</div>}
      {pendingArbitration > 0 && <div className="m-banner warn">本场有 {pendingArbitration} 份答卷待你仲裁，请优先处理。</div>}

      {catalogPending || (!progress.loaded && progress.loading) ? (
        <div className="m-empty">正在加载分配题目…</div>
      ) : rows.length === 0 ? (
        <div className="m-empty">本场暂无分配给你的阅卷题目</div>
      ) : (
        rows.map(row => {
          const total = (row.ordinary_total || 0) + (row.arbitration_total || 0)
          const done = (row.ordinary_completed || 0) + (row.arbitration_completed || 0)
          const percent = total ? Math.round((done / total) * 100) : 0
          const cardSubtitle = [row.grade_name, row.card_name && row.card_name !== 'Default' ? row.card_name : row.template_name].filter(Boolean).join(' · ')
          const actionLabel = row.published ? '查看记录' : row.arbitration_pending ? '进入仲裁' : row.cached ? '继续阅卷' : row.ordinary_pending ? '进入阅卷' : row.reopened ? '复核回评' : '历史与回评'

          return (
            <button key={questionKey(row)} type="button" className="m-question-card" onClick={() => onOpen(row.template_id, row.question_id)}>
              <div className="m-question-top">
                <div className="m-list-main">
                  <div className="m-list-title">
                    <span>{row.subject_name ? `${row.subject_name} · ` : ''}第 {row.question_label} 题</span>
                    <Tag style={{ margin: 0 }}>{row.points} 分</Tag>
                    <Tag style={{ margin: 0 }}>{row.review_mode === 'double' ? '双评' : '单评'}</Tag>
                    {row.published && <Tag color="red" style={{ margin: 0 }}>已锁定</Tag>}
                    {!row.published && row.reopened && <Tag color="blue" style={{ margin: 0 }}>复核中</Tag>}
                    {!!row.arbitration_pending && <Tag color="orange" style={{ margin: 0 }}>待仲裁 {row.arbitration_pending}</Tag>}
                  </div>
                  <span className="m-list-sub">{cardSubtitle}</span>
                </div>
                <span className="m-link-btn" style={{ padding: 0 }}>{actionLabel} ›</span>
              </div>
              <div className="m-question-progress">
                <span>
                  {row.ordinary_total === undefined
                    ? '本机已缓存'
                    : `已评 ${done} / ${total}${row.arbitration_total ? `（含仲裁 ${row.arbitration_completed || 0}/${row.arbitration_total}）` : ''}`}
                </span>
                {row.ordinary_total !== undefined && (
                  <div className="m-progress-track" aria-hidden="true">
                    <div className="m-progress-fill" style={{ width: `${percent}%` }} />
                  </div>
                )}
              </div>
            </button>
          )
        })
      )}
    </main>
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
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    if (!confirmLeaving() || loggingOut) return
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
    <main className="m-page">
      <header className="m-home-head">
        <div>
          <small>教师工作台</small>
          <h1>个人账号</h1>
        </div>
      </header>

      <section className="m-card">
        <div className="m-profile-row">
          <div className="m-avatar" aria-hidden="true">{user.name.slice(0, 1)}</div>
          <div className="m-list-main">
            <div className="m-list-title">
              <span>{user.name}</span>
              <Tag style={{ margin: 0 }}>{user.role === 'manager' ? '管理教师' : '阅卷教师'}</Tag>
            </div>
            <span className="m-list-sub">账号：{user.username}</span>
          </div>
        </div>
      </section>

      <section className="m-card">
        <strong>外观主题</strong>
        <div className="m-theme-group" role="group" aria-label="选择主题模式">
          {(['light', 'dark', 'system'] as ThemeMode[]).map(value => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>
              {THEME_MODE_LABELS[value]}
            </button>
          ))}
        </div>
      </section>

      <section className="m-card">
        <strong>工作区切换</strong>
        <button type="button" className="m-secondary-btn" onClick={onSwitchDesktop}>
          <DesktopOutlined /> 切换为桌面版界面
        </button>
        {user.role === 'manager' && (
          <button type="button" className="m-secondary-btn" onClick={onEnterManagement}>
            进入管理后台（桌面版）
          </button>
        )}
        <button type="button" className="m-secondary-btn" style={{ color: 'var(--m-danger)' }} disabled={loggingOut} onClick={() => void handleLogout()}>
          <LogoutOutlined /> {loggingOut ? '正在退出…' : '退出登录'}
        </button>
      </section>
    </main>
  )
}

const DESKTOP_PAGE_LABELS: Record<string, string> = {
  results: '成绩总览',
  lesson: '讲评试卷',
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
    <main className="m-page" style={{ justifyContent: 'center' }}>
      <section className="m-card" style={{ textAlign: 'center', alignItems: 'center', padding: 24 }}>
        <strong style={{ fontSize: 18 }}>{label}</strong>
        <p className="m-list-sub" style={{ margin: 0 }}>
          手机端首版聚焦在线阅卷与回评。你可以在桌面版继续打开当前页面，或返回手机端我的阅卷。
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', marginTop: 8 }}>
          <button type="button" className="m-primary-btn" onClick={onSwitchDesktop}>
            <DesktopOutlined /> 在桌面版打开「{label}」
          </button>
          <button type="button" className="m-secondary-btn" onClick={onBackHome}>
            返回我的阅卷
          </button>
        </div>
      </section>
    </main>
  )
}
