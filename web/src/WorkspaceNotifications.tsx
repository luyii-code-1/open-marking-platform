import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, App, Badge, Drawer, List, Space, Tag, Typography } from 'antd'
import { BellOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { jobDetailText, jobKindLabel, jobStatusColor, jobStatusLabel } from './jobDisplay'
import { request, type Row } from './api'
import { serviceIsSlow, setServiceSlow } from './networkPolicy'

type WorkspaceActivity = { exams: Row[]; events: Row[]; jobs: Row[] }
type NotificationsContextValue = {
  slow: boolean
  jobs: Row[]
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

const fallbackContext: NotificationsContextValue = {
  slow: false,
  jobs: [],
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

export function WorkspaceNotificationsProvider({ isAdmin, children }: { isAdmin: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [slow, setSlow] = useState(false)
  const [jobs, setJobs] = useState<Row[]>([])
  const [exams, setExams] = useState<Row[]>([])
  const [events, setEvents] = useState<Row[]>([])
  const [activityLoaded, setActivityLoaded] = useState(false)
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityError, setActivityError] = useState('')
  const { notification } = App.useApp()
  const mounted = useRef(true)
  const lastNotice = useRef(0)

  const loadActivity = useCallback(async () => {
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
  }, [isAdmin])

  useEffect(() => {
    mounted.current = true
    if (!isAdmin) {
      setJobs([])
      setExams([])
      setEvents([])
      setActivityLoaded(false)
      setActivityLoading(false)
      setActivityError('')
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
  }, [isAdmin, loadActivity, notification])

  const count = jobs.length + (slow ? 1 : 0)
  return (
    <NotificationsContext.Provider
      value={{
        slow,
        jobs,
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
      <Drawer
        title="重要通知"
        open={open}
        onClose={() => setOpen(false)}
        width={480}
        extra={isAdmin ? <Button size="small" loading={activityLoading} onClick={() => void loadActivity()}>刷新</Button> : undefined}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {slow && <Alert type="warning" showIcon message="服务器响应较慢" description="正在自动降低状态查询频率，请稍候。" />}
          {isAdmin && <ErrorNotice error={activityError} retry={loadActivity} />}
          <List
            loading={isAdmin && activityLoading && !activityLoaded}
            dataSource={jobs}
            locale={{ emptyText: '暂无待处理通知' }}
            renderItem={job => {
              const detail = jobDetailText(job)
              return (
                <List.Item>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space wrap>
                      <Tag color={jobStatusColor(job.status)}>{jobStatusLabel(job.status)}</Tag>
                      <a href={job.project_id ? `#/exams/${job.project_id}` : '#/dashboard'} onClick={() => setOpen(false)}>
                        {jobKindLabel(job.kind)}
                      </a>
                    </Space>
                    {detail && (
                      <Typography.Text type={job.status === 'failed' ? 'danger' : 'secondary'}>
                        {detail}
                      </Typography.Text>
                    )}
                  </Space>
                </List.Item>
              )
            }}
          />
          {!isAdmin && !slow && (
            <Typography.Text type="secondary">服务连接正常，响应慢时将在此处提示。</Typography.Text>
          )}
        </Space>
      </Drawer>
      <span className="sr-only" aria-live="polite" data-notification-count={count} />
    </NotificationsContext.Provider>
  )
}

export function WorkspaceNotificationButton({ compact = false, onlyWhenActive = false }: { compact?: boolean; onlyWhenActive?: boolean }) {
  const { slow, jobs, setOpen } = useWorkspaceNotifications()
  const count = jobs.length + (slow ? 1 : 0)
  if (onlyWhenActive && count === 0) return null
  return (
    <Badge count={count} size="small">
      <Button
        size={compact ? 'small' : undefined}
        icon={<BellOutlined />}
        aria-label={count > 0 ? `通知（${count} 条）` : '通知'}
        onClick={() => setOpen(true)}
      >
        {compact ? (slow ? '服务较慢' : '通知') : '通知'}
      </Button>
    </Badge>
  )
}
