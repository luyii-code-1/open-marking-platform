import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, App, Drawer, Empty, Progress, Space, Tag, Typography } from 'antd'
import { BellOutlined, CloseOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { ErrorNotice } from './ErrorNotice'
import { jobDetailText, jobKindLabel, jobStatusColor, jobStatusLabel } from './jobDisplay'
import { request, send, watchChanges, type Row } from './api'
import { serviceIsSlow, setServiceSlow } from './networkPolicy'

type WorkspaceActivity = { exams: Row[]; events: Row[]; jobs: Row[] }
type NotificationsContextValue = {
  slow: boolean
  jobs: Row[]
  templateNotices: Row[]
  exams: Row[]
  events: Row[]
  activityLoaded: boolean
  activityLoading: boolean
  activityError: string
  canViewActivity: boolean
  open: boolean
  setOpen: (open: boolean) => void
  reloadActivity: () => Promise<void>
}

const DISMISSED_KEY = 'omp-dismissed-notifications'

function readDismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((v: unknown): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function saveDismissed(keys: string[]) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys.slice(-200)))
  } catch {}
}

function notificationKey(job: Row) {
  return `${job.id}:${job.status}:${job.attempts ?? 0}`
}

function jobTargetHref(job: Row) {
  if (!job.project_id) return '#/dashboard'
  if (['archive-project', 'preview-release', 'release-project', 'restore-archive'].includes(job.kind)) {
    return `#/exams/${encodeURIComponent(job.project_id)}/archives`
  }
  return `#/exams/${encodeURIComponent(job.project_id)}`
}

function formatJobTime(timestamp?: number) {
  if (!timestamp) return ''
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return new Date(timestamp * 1000).toLocaleString()
}

const fallbackContext: NotificationsContextValue = {
  slow: false,
  jobs: [],
  templateNotices: [],
  exams: [],
  events: [],
  activityLoaded: false,
  activityLoading: false,
  activityError: '',
  canViewActivity: false,
  open: false,
  setOpen: () => {},
  reloadActivity: async () => {},
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

export function useWorkspaceNotifications(): NotificationsContextValue {
  return useContext(NotificationsContext) ?? fallbackContext
}

export type NotificationsDrawerProps = {
  open: boolean
  setOpen: (open: boolean) => void
  slow: boolean
  templateNotices: Row[]
  activityLoading: boolean
  reloadActivity: () => Promise<void>
}

export function WorkspaceNotificationsProvider({ isAdmin, offline = false, renderDrawer, children }: { isAdmin: boolean; offline?: boolean; renderDrawer?: (props: NotificationsDrawerProps) => ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [slow, setSlow] = useState(false)
  const [jobs, setJobs] = useState<Row[]>([])
  const [templateNotices, setTemplateNotices] = useState<Row[]>([])
  const [exams, setExams] = useState<Row[]>([])
  const [events, setEvents] = useState<Row[]>([])
  const [dismissed, setDismissed] = useState<string[]>(readDismissed)
  const [retryingId, setRetryingId] = useState('')
  const [activityLoaded, setActivityLoaded] = useState(false)
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityError, setActivityError] = useState('')
  const { notification, message } = App.useApp()
  const mounted = useRef(true)
  const lastNotice = useRef(0)

  const loadTemplateNotices = useCallback(async () => {
    if (offline) return
    try {
      const items = await request<Row[]>('/teacher-templates/notifications')
      if (mounted.current && Array.isArray(items)) setTemplateNotices(items)
    } catch {
      /* Ignore offline or transient errors. */
    }
  }, [offline])

  const loadActivity = useCallback(async () => {
    if (offline) return
    void loadTemplateNotices()
    if (!isAdmin) return
    setActivityLoading(true)
    setActivityError('')
    try {
      const value = await request<WorkspaceActivity>('/workspace/activity')
      if (!mounted.current) return
      setJobs(value.jobs || [])
      setExams(value.exams || [])
      setEvents(value.events || [])
      setActivityLoaded(true)
    } catch (e) {
      if (mounted.current) setActivityError(e instanceof Error ? e.message : '工作区状态加载失败')
    } finally {
      if (mounted.current) setActivityLoading(false)
    }
  }, [isAdmin, offline, loadTemplateNotices])

  useEffect(() => watchChanges(roots => {
    if (!offline && (!roots || roots.includes('teacher-templates'))) void loadTemplateNotices()
  }), [offline, loadTemplateNotices])

  useEffect(() => {
    mounted.current = true
    if (!isAdmin || offline) {
      setJobs([])
      setExams([])
      setEvents([])
      setActivityLoaded(false)
      setActivityLoading(false)
      setActivityError('')
    }
    if (offline) {
      setSlow(false)
      setTemplateNotices([])
      return () => {
        mounted.current = false
        notification.destroy('service-slow')
      }
    }
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    async function tick() {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        try {
          const status = await request<{ state: string }>('/system/service-status')
          if (stopped) return
          const isSlow = status.state === 'slow'
          setSlow(isSlow)
          setServiceSlow(isSlow)
          if (isSlow && Date.now() - lastNotice.current > 300000) {
            lastNotice.current = Date.now()
            notification.warning({
              key: 'service-slow',
              message: '服务器响应较慢',
              description: '请求会自动降低频率并重试，请保留当前页面。',
              duration: 8,
            })
          }
          await loadTemplateNotices()
          if (isAdmin) await loadActivity()
        } catch {
          /* Connectivity state is handled by the review workspace. */
        }
      }
      if (!stopped) {
        timer = setTimeout(tick, document.visibilityState === 'visible' ? (serviceIsSlow() ? 60000 : 30000) : 90000)
      }
    }
    void tick()
    return () => {
      mounted.current = false
      stopped = true
      clearTimeout(timer)
      notification.destroy('service-slow')
    }
  }, [isAdmin, offline, loadActivity, loadTemplateNotices, notification])

  const dismissedSet = useMemo(() => new Set(dismissed), [dismissed])
  const visibleJobs = useMemo(
    () =>
      jobs
        .filter(job => !dismissedSet.has(notificationKey(job)))
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0)),
    [jobs, dismissedSet],
  )
  const examNames = useMemo(() => new Map(exams.map(e => [e.id, e.name])), [exams])

  const dismissOne = (job: Row) => {
    const key = notificationKey(job)
    setDismissed(current => {
      if (current.includes(key)) return current
      const next = [...current, key]
      saveDismissed(next)
      return next
    })
  }

  const dismissAll = () => {
    setDismissed(current => {
      const next = [...new Set([...current, ...visibleJobs.map(notificationKey)])]
      saveDismissed(next)
      return next
    })
  }

  const retryJob = async (job: Row) => {
    if (retryingId) return
    setRetryingId(job.id)
    try {
      await send(`/jobs/${job.id}/retry`)
      message.success('已重新提交后台任务')
      await loadActivity()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '重试失败')
    } finally {
      setRetryingId('')
    }
  }

  const count = visibleJobs.length + templateNotices.length + (slow ? 1 : 0)
  return (
    <NotificationsContext.Provider
      value={{
        slow,
        jobs: visibleJobs,
        templateNotices,
        exams,
        events,
        activityLoaded,
        activityLoading,
        activityError,
        canViewActivity: isAdmin,
        open,
        setOpen,
        reloadActivity: loadActivity,
      }}
    >
      {children}
      {renderDrawer ? renderDrawer({ open, setOpen, slow, templateNotices, activityLoading, reloadActivity: loadActivity }) : (
      <Drawer
        title={`重要通知${count > 0 ? `（${count}）` : ''}`}
        open={open}
        onClose={() => setOpen(false)}
        width={460}
        extra={
          <Space size={4}>
            {visibleJobs.length > 0 && (
              <Button size="small" type="text" onClick={dismissAll}>
                清空全部
              </Button>
            )}
            <Button size="small" icon={<ReloadOutlined />} loading={activityLoading} onClick={() => void loadActivity()}>
              刷新
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {slow && <Alert type="warning" showIcon message="服务器响应较慢" description="正在自动降低状态查询频率，请稍候。" />}
          {isAdmin && <ErrorNotice error={activityError} retry={loadActivity} />}

          {templateNotices.length > 0 && (
            <div className="notification-card-list">
              {templateNotices.map(item => (
                <article key={`tpl-${item.id}`} className="notification-card is-running">
                  <div className="notification-card-head">
                    <Space size={6} wrap>
                      <Tag color={item.kind === 'assigned_template' ? 'blue' : 'orange'} style={{ marginInlineEnd: 0 }}>
                        {item.kind === 'assigned_template' ? (item.status === 'rejected' ? '退回修改' : '制卡任务') : '待审核'}
                      </Tag>
                      <strong className="notification-card-title">{item.title}</strong>
                    </Space>
                    {item.created_at && <span className="notification-card-time">{formatJobTime(item.created_at)}</span>}
                  </div>
                  {item.scope && <div className="notification-card-scope">{item.scope}</div>}
                  {item.detail && (
                    <Typography.Paragraph className="notification-card-detail" type="secondary" style={{ marginBottom: 0 }}>
                      {item.detail}
                    </Typography.Paragraph>
                  )}
                  <div className="notification-card-actions">
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => {
                        setOpen(false)
                        window.location.hash = item.href
                      }}
                    >
                      {item.action_label || '一键进入制卡'}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {visibleJobs.length > 0 ? (
            <div className="notification-card-list">
              {visibleJobs.map(job => {
                const detail = jobDetailText(job)
                const projectName = job.project_id ? examNames.get(job.project_id) : ''
                const percent =
                  job.status === 'running' && job.progress_total
                    ? Math.round((100 * (job.progress_current || 0)) / job.progress_total)
                    : null
                return (
                  <article key={job.id} className={`notification-card is-${job.status || 'pending'}`}>
                    <div className="notification-card-head">
                      <Space size={6} wrap>
                        <Tag color={jobStatusColor(job.status)} style={{ marginInlineEnd: 0 }}>
                          {jobStatusLabel(job.status)}
                        </Tag>
                        <strong className="notification-card-title">{jobKindLabel(job.kind)}</strong>
                      </Space>
                      <Space size={4}>
                        {job.created_at && <span className="notification-card-time">{formatJobTime(job.created_at)}</span>}
                        <Button
                          type="text"
                          size="small"
                          className="notification-card-close"
                          icon={<CloseOutlined />}
                          aria-label={`删除${jobKindLabel(job.kind)}通知`}
                          onClick={() => dismissOne(job)}
                        />
                      </Space>
                    </div>
                    {projectName && <div className="notification-card-scope">考试项目：{projectName}</div>}
                    {detail && (
                      <Typography.Paragraph
                        className="notification-card-detail"
                        type={job.status === 'failed' ? 'danger' : 'secondary'}
                        style={{ marginBottom: 0 }}
                      >
                        {detail}
                      </Typography.Paragraph>
                    )}
                    {percent !== null && <Progress percent={percent} size="small" status="active" style={{ margin: 0 }} />}
                    <div className="notification-card-actions">
                      <a href={jobTargetHref(job)} className="notification-card-link" onClick={() => setOpen(false)}>
                        <span>前往查看</span>
                        <RightOutlined />
                      </a>
                      {job.status === 'failed' && !job.cancelled_by_deletion && (
                        <Button
                          size="small"
                          loading={retryingId === job.id}
                          disabled={!!retryingId && retryingId !== job.id}
                          onClick={() => void retryJob(job)}
                        >
                          重试任务
                        </Button>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            !activityLoading && templateNotices.length === 0 && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={isAdmin ? '暂无待处理通知' : slow ? '当前仅服务慢响应提醒' : '服务连接正常，暂无待处理通知'}
              />
            )
          )}
        </Space>
      </Drawer>
      )}
      <span className="sr-only" aria-live="polite" data-notification-count={count} />
    </NotificationsContext.Provider>
  )
}

export function WorkspaceNotificationButton({ compact = false, onlyWhenActive = false }: { compact?: boolean; onlyWhenActive?: boolean }) {
  const { slow, jobs, templateNotices, setOpen } = useWorkspaceNotifications()
  const count = jobs.length + templateNotices.length + (slow ? 1 : 0)
  if (onlyWhenActive && count === 0) return null
  return (
    <Button
      size={compact ? 'small' : 'middle'}
      className={count > 0 ? 'topbar-notify-btn has-count' : 'topbar-notify-btn'}
      icon={<BellOutlined />}
      aria-label={count > 0 ? `通知（${count} 条）` : '通知'}
      onClick={() => setOpen(true)}
    >
      <span>{compact && slow ? '服务较慢' : '通知'}</span>
      {count > 0 && <span className="topbar-notify-count">{count > 99 ? '99+' : count}</span>}
    </Button>
  )
}
