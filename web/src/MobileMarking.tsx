import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { App } from 'antd'
import {
  ActionSheet,
  Button,
  Dialog,
  Empty,
  ErrorBlock,
  List,
  NavBar,
  NoticeBar,
  Popup,
  ProgressBar,
  Selector,
  Space,
  Stepper,
  Switch,
  Tag,
  TextArea,
} from 'antd-mobile'
import { DesktopOutlined, MoreOutlined, ReloadOutlined } from '@ant-design/icons'
import { ApiError, request, send, useResource, watchChanges, type Row, type Template } from './api'
import { questionLabel } from './mergeQuestions'
import { isMobileWideLayout, rememberMobileTask } from './mobilePlatform'
import {
  beginPinch,
  canZoomIn,
  canZoomOut,
  computeStagePixelWidth,
  isDefaultZoom,
  isValidDoubleTap,
  stepZoom,
  toggleDoubleTapZoom,
  updatePinch,
  type PinchState,
  type TapRecord,
} from './mobileZoom'
import { ReviewImage } from './ReviewImage'
import { loadReviewSheet } from './reviewImages'
import { previousReview, scoreInputError, scorePresets } from './reviewInteraction'
import { cacheReview, enqueueReview, forgetReview, getReview, hasUnsentReview, listReviews, saveReviewDraft, settleReviewWrites, type ReviewRecord } from './reviewStore'
import { useReviewWorkspace } from './ReviewWorkspace'
import { WorkspaceNotificationButton } from './WorkspaceNotifications'
import './mobile-score-layout.css'
import { useAction } from './useAction'
import { useUnsavedChanges } from './useNavigation'

type Props = {
  initialProjectId?: string
  initialTemplateId: string
  initialQuestionId: string
  onBack: (projectId?: string) => void
  onSwitchDesktop: () => void
}

export function MobileMarking({ initialProjectId, initialTemplateId, initialQuestionId, onBack, onSwitchDesktop }: Props) {
  const workspace = useReviewWorkspace()
  const action = useAction()
  const busy = action.busy
  const { message } = App.useApp()

  const templateResource = useResource<Template[]>('/templates', [])
  const templates = [...new Map([
    ...workspace.records.map(r => ({ ...r.template, questions: [r.question] } as Template)),
    ...templateResource.data,
  ].map(t => [t.id, t])).values()]
  const groups = useResource<Row[]>('/groups', [])
  const subjects = useResource<Row[]>('/subjects', [])
  const projects = useResource<Row[]>('/projects', [])

  const [templateId, setTemplateId] = useState(initialTemplateId)
  const [questionId, setQuestionId] = useState(initialQuestionId)
  const [task, setTask] = useState<Row | null>(null)
  const [history, setHistory] = useState<Row[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [regradeStart, setRegradeStart] = useState<Row | null>(null)
  const [regradeReason, setRegradeReason] = useState('')
  const [scoreText, setScoreText] = useState('')
  const [scoreError, setScoreError] = useState('')
  const [step, setStep] = useState(0.5)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [skipWarn, setSkipWarn] = useState(false)
  const [automatic, setAutomatic] = useState(true)
  const [presetsOpen, setPresetsOpen] = useState(true)
  const [osd, setOsd] = useState<{ text: string } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [contrast, setContrast] = useState(1)
  const [count, setCount] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [saveState, setSaveState] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [wide, setWide] = useState(() => isMobileWideLayout(window.innerWidth, window.innerHeight))

  const rootRef = useRef<HTMLDivElement>(null)
  const readingRef = useRef<HTMLDivElement>(null)
  const started = useRef(Date.now())
  const saveVersion = useRef(0)
  const submitted = useRef<ReviewRecord['operation']>(undefined)
  const gradingSeconds = useRef(0)
  const ahead = useRef<{ from: string; work: Promise<ReviewRecord | null> } | null>(null)
  const entered = useRef(false)
  const historyVersion = useRef(0)
  const historyContext = useRef('')
  historyContext.current = `${templateId}:${questionId}`

  // Pinch-to-zoom, single-finger pan, & double-tap tracking
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = useRef<PinchState | null>(null)
  const panStart = useRef<{ id: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null)
  const tapStart = useRef<{ id: number; x: number; y: number; moved: number } | null>(null)
  const lastTap = useRef<TapRecord | null>(null)
  const [pinching, setPinching] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(0)

  const progress = useResource<Row>(
    templateId && questionId ? `/review-progress?template_id=${encodeURIComponent(templateId)}&question_id=${encodeURIComponent(questionId)}` : null,
    {} as Row,
  )

  const value = scoreText.trim() !== '' && Number.isFinite(Number(scoreText)) ? Number(scoreText) : null
  const record = workspace.records.find(r => r.task.id === task?.id)
  const template = templates.find(t => t.id === templateId)
  const question = record?.question || template?.questions.find(q => q.id === questionId)
  const group = groups.data.find(g => g.id === template?.group_id)
  const subject = subjects.data.find(s => s.id === group?.subject_id)
  const project = projects.data.find(p => p.id === subject?.project_id)
  const published = group?.frozen !== undefined ? Boolean(group.frozen) : Boolean((progress.data as Row | undefined)?.published)
  const reopened = !published && Boolean(((group as Row | undefined)?.reopened_at && (group as Row | undefined)?.published_at) || (progress.data as Row | undefined)?.reopened)
  const locked = busy || workspace.updateLocked || !!workspace.storageError
  const editable = record?.status === 'draft' && !locked && !published

  useLayoutEffect(() => {
    const syncViewport = () => {
      const vh = window.visualViewport?.height ?? window.innerHeight
      const vw = window.visualViewport?.width ?? window.innerWidth
      const heightPx = `${Math.max(180, Math.round(vh))}px`
      if (rootRef.current) rootRef.current.style.setProperty('--mobile-vh', heightPx)
      document.documentElement.style.setProperty('--mobile-vh', heightPx)
      setWide(isMobileWideLayout(vw, vh))
    }
    syncViewport()
    window.addEventListener('resize', syncViewport)
    window.addEventListener('orientationchange', syncViewport)
    window.visualViewport?.addEventListener('resize', syncViewport)
    return () => {
      document.documentElement.style.removeProperty('--mobile-vh')
      window.removeEventListener('resize', syncViewport)
      window.removeEventListener('orientationchange', syncViewport)
      window.visualViewport?.removeEventListener('resize', syncViewport)
    }
  }, [])

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'hidden') return
      void workspace.sync()
      if (navigator.onLine && !workspace.offline) {
        void groups.reload()
        if (templateId && questionId) void progress.reload()
      }
    }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('online', resume)
    return () => {
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('online', resume)
    }
  }, [templateId, questionId, workspace.offline, workspace.sync])

  useLayoutEffect(() => {
    const el = readingRef.current
    if (!el) return
    const measure = () => {
      if (el.clientWidth > 0) setViewportWidth(el.clientWidth)
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [task?.id, wide])

  useEffect(() => {
    const el = readingRef.current
    if (!el) return
    const onTouch = (event: TouchEvent) => {
      if (event.touches.length >= 2) event.preventDefault()
    }
    el.addEventListener('touchstart', onTouch, { passive: false })
    el.addEventListener('touchmove', onTouch, { passive: false })
    return () => {
      el.removeEventListener('touchstart', onTouch)
      el.removeEventListener('touchmove', onTouch)
    }
  }, [task?.id])

  useEffect(() => {
    pointers.current.clear()
    pinchStart.current = null
    panStart.current = null
    tapStart.current = null
    setPinching(false)
  }, [wide])

  // Remember last active task only after confirming it is authorized & valid
  useEffect(() => {
    if (!templateId || !questionId || !question) return
    const authorized = !!record || !!task || (templateResource.loaded && !!template && progress.loaded && !progress.error)
    if (!authorized) return
    rememberMobileTask(workspace.user.id, {
      projectId: subject?.project_id || record?.template.project_id || initialProjectId,
      projectName: project?.name || record?.template.project_name,
      subjectName: subject?.name || record?.template.subject_name,
      templateId,
      templateName: template?.name || record?.template.name,
      questionId,
      questionLabel: questionLabel(question),
      points: question.points,
    })
  }, [workspace.user.id, templateId, questionId, question, record, task, templateResource.loaded, template, progress.loaded, progress.error, subject?.project_id, subject?.name, project?.name, initialProjectId])

  const savingDraft = saveState === '正在保存本地草稿' || saveState === '本地保存失败'
  useUnsavedChanges(savingDraft)

  useEffect(() => {
    if (!osd) return
    const timer = setTimeout(() => setOsd(null), 1000)
    return () => clearTimeout(timer)
  }, [osd])

  function showRecord(row: ReviewRecord) {
    ++saveVersion.current
    submitted.current = row.operation
    gradingSeconds.current = 0
    started.current = Date.now()
    setTemplateId(row.template.id)
    setQuestionId(row.question.id)
    setTask(row.task)
    const text = row.draftText ?? String(row.draft ?? '')
    setScoreText(text)
    setScoreError(text ? scoreInputError(text, row.question.points, row.question.step) : '')
    setSaveState('草稿已保存')
    setFeedback('')
    setError('')
    setSkipWarn(false)
    setZoom(1)
    if (readingRef.current) {
      readingRef.current.scrollTop = 0
      readingRef.current.scrollLeft = 0
    }
  }

  function clearTask() {
    ++saveVersion.current
    submitted.current = undefined
    setTask(null)
    setScoreText('')
    setScoreError('')
    setSkipWarn(false)
    setSaveState('')
  }

  async function cacheTask(row: Row) {
    if (!template) throw new Error('题卡配置不可用')
    const selected = template.questions.find(q => q.id === row.question_id)
    if (!selected) throw new Error('题目配置不可用')
    const sheet = await loadReviewSheet(row.id)
    return cacheReview(
      workspace.user.id,
      row,
      {
        id: template.id,
        name: template.name,
        group_id: template.group_id,
        revision: template.revision,
        project_id: subject?.project_id || initialProjectId,
        project_name: project?.name,
        subject_name: subject?.name,
        exam_status: project?.exam_status,
      },
      selected,
      new Blob([]),
      sheet,
    )
  }

  async function openTask(row: Row) {
    showRecord(await cacheTask(row))
  }

  async function availableTask(from?: string, startRegrade = false): Promise<ReviewRecord | null> {
    const local = (await listReviews(workspace.user.id)).filter(r => r.template.id === templateId && r.question.id === questionId)
    const drafts = local.filter(r => r.status === 'draft' && r.task.id !== from && (hasUnsentReview(r) || workspace.offline || r.task.status !== 'claimed' || r.task.expires_at * 1000 > Date.now()))
    const cached = drafts.find(hasUnsentReview) || drafts.at(-1)
    if (!startRegrade && cached && hasUnsentReview(cached)) return cached
    if (workspace.offline || !navigator.onLine) return cached || null
    const held = local.filter(r => r.operation).map(r => r.task.id)
    if (from && !held.includes(from)) held.push(from)
    let row: Row | null
    try {
      row = await send<Row | null>('/tasks/claim', { template_id: templateId, question_id: questionId, pending_task_ids: held })
    } catch (e) {
      if (!startRegrade && cached && (!(e instanceof ApiError) || e.status === 403)) return cached
      throw e
    }
    if (!row || held.includes(row.id)) return null
    const saved = await cacheTask(row)
    if (saved.status !== 'draft') return null
    return row.regrading ? { ...saved, task: { ...saved.task, regrading: true } } : saved
  }

  useEffect(() => {
    if (published || !task || !record || record.status !== 'draft' || !automatic || workspace.offline || workspace.updateLocked || (task.status !== 'claimed' && !task.regrading)) return
    const from = task.id
    const timer = setTimeout(() => {
      const work = availableTask(from)
      ahead.current = { from, work }
      void work.catch(() => { if (ahead.current?.work === work) ahead.current = null })
    }, 0)
    return () => clearTimeout(timer)
  }, [task?.id, record?.status, automatic, workspace.offline, workspace.updateLocked, published])

  async function advance(from?: string, afterSkip = false) {
    const prepared = from && ahead.current?.from === from ? ahead.current.work : null
    ahead.current = null
    const prefetched = prepared && await prepared.catch(() => null)
    if (prefetched) {
      const latest = await getReview(workspace.user.id, prefetched.task.id)
      const arbitrationWaiting = (progress.data.my_arbitration_pending || 0) > 0
      if (
        latest?.status === 'draft'
        && (!arbitrationWaiting || latest.task.review_role === 'arbitration' || hasUnsentReview(latest) || workspace.offline)
        && (latest.task.status !== 'claimed' || latest.task.expires_at * 1000 > Date.now() || workspace.offline || hasUnsentReview(latest))
      ) {
        showRecord(latest)
        return
      }
    }
    const saved = await availableTask(afterSkip ? undefined : from)
    if (saved) showRecord(saved)
    else clearTask()
  }

  async function next() {
    if (!templateId || !questionId || workspace.updateLocked || published) return
    await action.run('claim', async () => {
      setError('')
      try { await advance(task?.id) }
      catch (e) { setError((e as Error).message) }
    })
  }

  useEffect(() => {
    if (!initialTemplateId || !initialQuestionId || !workspace.ready || entered.current) return
    const local = workspace.records.filter(r => r.template.id === initialTemplateId && r.question.id === initialQuestionId)
    const pending = local.find(r => r.operation)
    if (pending) {
      entered.current = true
      showRecord(pending)
      return
    }
    const drafts = local.filter(r => r.status === 'draft')
    const cached = drafts.find(hasUnsentReview) || drafts.at(-1)
    if (cached && (workspace.offline || !navigator.onLine || hasUnsentReview(cached))) {
      entered.current = true
      showRecord(cached)
      return
    }
    if (!template || !question || workspace.offline || workspace.updateLocked || workspace.storageError || !groups.loaded) return
    entered.current = true
    if (published) openHistory()
    else void next()
  }, [initialTemplateId, initialQuestionId, template?.id, question?.id, workspace.ready, workspace.offline, workspace.updateLocked, workspace.storageError, workspace.records, groups.loaded, published])

  function editScore(text: string) {
    if (!task || !editable) return
    const raw = text.trim()
    const score = raw && Number.isFinite(Number(raw)) ? Number(raw) : null
    setScoreText(text)
    setSkipWarn(false)
    setFeedback('')
    setSaveState('正在保存本地草稿')
    setScoreError(raw && question ? scoreInputError(text, question.points, question.step) : '')
    const version = ++saveVersion.current
    void saveReviewDraft(workspace.user.id, task.id, score, text)
      .then(() => { if (version === saveVersion.current) setSaveState('草稿已保存') })
      .catch(e => {
        if (version === saveVersion.current) {
          setSaveState('本地保存失败')
          setError((e as Error).message)
        }
      })
  }

  async function submit() {
    if (!task || !editable || savingDraft || submitted.current || !question) return
    const issue = scoreInputError(scoreText, question.points, question.step)
    if (issue || value === null) {
      setScoreError(issue)
      return
    }
    await action.run('score', async () => {
      setError('')
      setFeedback('')
      try {
        const queued = await enqueueReview(workspace.user.id, task.id, value)
        submitted.current = queued.operation
        gradingSeconds.current = (Date.now() - started.current) / 1000
        setSaveState('')
        setFeedback('评分已保存，等待服务器确认')
        if (navigator.onLine) void workspace.sync()
      } catch (e) {
        setError((e as Error).message)
      }
    })
  }

  useEffect(() => {
    if (!record || record.status !== 'confirmed' || busy) return
    setTask(record.task)
    setScoreText(String(record.task.score ?? ''))
    const operation = submitted.current
    const receipt = record.task.accepted_operation
    if (!operation || receipt?.id !== operation.id || receipt.score !== operation.score) return
    submitted.current = undefined
    const elapsed = gradingSeconds.current
    setCount(n => n + 1)
    setSeconds(n => n + elapsed)
    setOsd({ text: `已确认：${operation.score} 分` })
    setFeedback('服务器已确认')
    void progress.reload()
    if (automatic && !published && !workspace.updateLocked) void next()
  }, [record?.status, record?.task.score_revision, record?.task.accepted_operation?.id, busy])

  async function skip() {
    if (!task || locked || workspace.offline || record?.status !== 'draft') return
    if (value === null && !skipWarn) {
      setSkipWarn(true)
      setFeedback('再次点击「跳过」可跳过当前作答')
      return
    }
    if (value !== null) {
      const ok = await Dialog.confirm({ content: '当前分数尚未提交，确认跳过这份作答？', confirmText: '跳过', cancelText: '取消' })
      if (!ok) return
    }
    await action.run('skip', async () => {
      try {
        await settleReviewWrites()
        if (task.status === 'claimed' || task.regrading) await send(`/tasks/${task.id}/skip`)
        await forgetReview(workspace.user.id, task.id)
        await advance(task.id, true)
      } catch (e) {
        setError((e as Error).message)
      }
    })
  }

  async function loadHistory() {
    const context = historyContext.current
    const version = ++historyVersion.current
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const rows = (await request<Row[]>(`/tasks/history?template_id=${encodeURIComponent(templateId)}&question_id=${encodeURIComponent(questionId)}`)).reverse()
      if (context === historyContext.current && version === historyVersion.current) {
        setHistory(rows)
        return rows
      }
    } catch (e) {
      if (context === historyContext.current && version === historyVersion.current) {
        setHistoryError((e as Error).message)
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) setHistory([])
      }
    } finally {
      if (context === historyContext.current && version === historyVersion.current) setHistoryLoading(false)
    }
  }

  useEffect(() => watchChanges(roots => {
    if (templateId && questionId && historyOpen && !workspace.offline && (!roots || roots.includes('tasks'))) void loadHistory()
  }), [templateId, questionId, historyOpen, workspace.offline])

  useEffect(() => watchChanges(roots => {
    if (!roots || roots.includes('groups') || roots.includes('results')) {
      void groups.reload()
      if (templateId && questionId) void progress.reload()
    }
  }), [templateId, questionId])

  function openHistory() {
    setHistoryOpen(true)
    void loadHistory()
  }

  async function reviewHistory(row: Row) {
    if (published) {
      message.warning('成绩已锁定，不可回评')
      return
    }
    if (record?.status === 'draft' && value !== null && record.task.id !== row.id) {
      const ok = await Dialog.confirm({ content: '当前给分尚未提交，确认先回评历史作答？本地草稿会保留。', confirmText: '去回评', cancelText: '取消' })
      if (!ok) return
    }
    await action.run(`history:${row.id}`, async () => {
      try {
        await openTask(await request<Row>(`/tasks/${row.id}`))
        setHistoryOpen(false)
      } catch (e) {
        setHistoryError((e as Error).message)
      }
    })
  }

  async function previous() {
    if (published) {
      message.warning('成绩已锁定，不可回评上一份')
      return
    }
    if (record?.status === 'draft' && value !== null) {
      const ok = await Dialog.confirm({ content: '当前给分尚未提交，确认回评上一份？本地草稿会保留。', confirmText: '回评上一份', cancelText: '取消' })
      if (!ok) return
    }
    await action.run('previous', async () => {
      try {
        const rows = await loadHistory()
        if (!rows) {
          setHistoryOpen(true)
          return
        }
        const row = previousReview(rows, task?.id)
        if (row) await openTask(await request<Row>(`/tasks/${row.id}`))
        else message.info('已到最早一份评分')
      } catch (e) {
        setError((e as Error).message)
      }
    })
  }

  async function regradeFrom() {
    const reason = regradeReason.trim()
    if (!regradeStart || !reason || published || workspace.offline || locked) return
    await action.run('regrade', async () => {
      try {
        await settleReviewWrites()
        const result = await send<{ queued: number }>(`/tasks/${regradeStart.id}/regrade-from`, { reason })
        setRegradeStart(null)
        setHistoryOpen(false)
        message.success(`已加入 ${result.queued} 份重阅任务`)
        ahead.current = null
        void progress.reload()
        const first = await availableTask(undefined, true)
        if (first) showRecord(first)
      } catch (e) {
        message.error((e as Error).message)
      }
    })
  }

  async function reportCurrent(kind: 'exception' | 'excellent') {
    if (!task || published || workspace.offline || locked) return
    const ok = await Dialog.confirm({
      title: kind === 'exception' ? '报告异常卷' : '标记优秀卷',
      content: '将当前作答交由管理员查看。',
      confirmText: '确认提交',
      cancelText: '取消',
    })
    if (!ok) return
    try {
      await send(`/tasks/${task.id}/report`, { kind, reason: '' })
      message.success('已报告')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  function resetZoomAndScroll() {
    setZoom(1)
    requestAnimationFrame(() => {
      if (readingRef.current) {
        readingRef.current.scrollTop = 0
        readingRef.current.scrollLeft = 0
      }
    })
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const el = readingRef.current
    if (pointers.current.size === 2) {
      panStart.current = null
      tapStart.current = null
      lastTap.current = null
      setPinching(true)
      if (el) {
        const [a, b] = [...pointers.current.values()]
        pinchStart.current = beginPinch(a, b, el.getBoundingClientRect(), el.scrollLeft, el.scrollTop, zoom)
      }
    } else if (pointers.current.size === 1) {
      if (el) {
        panStart.current = { id: e.pointerId, x: e.clientX, y: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop }
      }
      if (e.pointerType === 'touch') {
        tapStart.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
      }
    }
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (tapStart.current && tapStart.current.id === e.pointerId) {
      tapStart.current.moved = Math.max(tapStart.current.moved, Math.hypot(e.clientX - tapStart.current.x, e.clientY - tapStart.current.y))
    }
    const el = readingRef.current
    if (pointers.current.size === 2 && pinchStart.current && el) {
      const [a, b] = [...pointers.current.values()]
      const next = updatePinch(pinchStart.current, a, b, el.getBoundingClientRect())
      setZoom(next.zoom)
      el.scrollLeft = next.scrollLeft
      el.scrollTop = next.scrollTop
    } else if (pointers.current.size === 1 && panStart.current && panStart.current.id === e.pointerId && el) {
      el.scrollLeft = Math.max(0, panStart.current.scrollLeft - (e.clientX - panStart.current.x))
      el.scrollTop = Math.max(0, panStart.current.scrollTop - (e.clientY - panStart.current.y))
    }
  }

  function handlePointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    try { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) {
      pinchStart.current = null
      setPinching(false)
    }
    if (panStart.current?.id === e.pointerId) panStart.current = null
    if (tapStart.current?.id === e.pointerId) tapStart.current = null
    lastTap.current = null
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    try { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) {
      pinchStart.current = null
      setPinching(false)
    }
    if (panStart.current?.id === e.pointerId) panStart.current = null
    if (tapStart.current && tapStart.current.id === e.pointerId) {
      const { moved } = tapStart.current
      tapStart.current = null
      if (pointers.current.size === 0 && e.pointerType === 'touch') {
        const currentTap: TapRecord = { time: Date.now(), x: e.clientX, y: e.clientY }
        if (isValidDoubleTap(lastTap.current, currentTap, moved)) {
          const nextZoom = toggleDoubleTapZoom(zoom)
          if (nextZoom === 1) resetZoomAndScroll()
          else setZoom(nextZoom)
          lastTap.current = null
        } else if (moved <= 12) {
          lastTap.current = currentTap
        } else {
          lastTap.current = null
        }
      }
    }
  }

  async function leave() {
    try {
      await settleReviewWrites()
      onBack(subject?.project_id || record?.template.project_id || initialProjectId)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const subjectName = subject?.name || record?.template.subject_name || ''
  const projectName = project?.name || record?.template.project_name || template?.name || '阅卷任务'
  const qLabel = question ? `第 ${questionLabel(question)} 题` : '阅卷中'
  const heading = subjectName ? `${subjectName} · ${qLabel}` : qLabel
  const myCompleted = progress.data.my_completed ?? 0
  const myTotal = progress.data.my_total ?? 0
  const presets = question ? scorePresets(question.points, Math.max(step, question.step ?? 0.5)).filter(n => !scoreInputError(String(n), question.points, question.step)) : []
  const canSubmit = !!task && editable && !savingDraft && value !== null && !scoreError && !submitted.current
  const queueStatus = record?.status === 'queued' ? '评分已保存，等待服务器确认'
    : record?.status === 'conflict' ? record.error || '评分需要核对'
    : record?.status === 'failed' ? '评分待上传，请重试' : ''
  const roomTagLabels = Array.isArray(task?.room_tags)
    ? task.room_tags.map((t: Row) => t.label || t.name).filter(Boolean)
    : []
  const fullContextLabel = [
    project?.name || record?.template.project_name,
    subject?.name || record?.template.subject_name,
    group?.grade_name || task?.grade_name,
    group?.name && group.name !== 'Default' ? group.name : undefined,
    template?.name || record?.template.name,
  ].filter(Boolean).join(' / ')
  const stageWidthStyle = viewportWidth > 0
    ? { width: `${computeStagePixelWidth(viewportWidth, zoom)}px` }
    : { width: `${Math.round(zoom * 100)}%` }

  const moreActions = [
    { key: 'history', text: published ? '我的评分记录' : '评分历史与回评', disabled: !question || workspace.offline || locked, onClick: openHistory },
    { key: 'progress', text: '任务详情与评阅进度', onClick: () => setProgressOpen(true) },
    { key: 'settings', text: '阅卷设置', onClick: () => setSettingsOpen(true) },
    ...(workspace.pendingCount > 0 ? [{ key: 'queue', text: `本地待传记录（${workspace.pendingCount}）`, onClick: workspace.openQueueModal }] : []),
    ...(task && question && !published && !workspace.offline ? [
      { key: 'exception', text: '报告异常卷', onClick: () => void reportCurrent('exception') },
      { key: 'excellent', text: '标记优秀卷', onClick: () => void reportCurrent('excellent') },
    ] : []),
    { key: 'desktop', text: '切换到桌面版阅卷台', onClick: onSwitchDesktop },
  ]

  return (
    <section ref={rootRef} className={`m-marking${wide ? ' is-landscape' : ''}`} aria-label="手机阅卷工作台">
      <NavBar
        back="返回"
        onBack={() => void leave()}
        right={
          <div className="m-adm-nav-right">
            <WorkspaceNotificationButton compact onlyWhenActive />
            <button type="button" className="m-progress-pill" onClick={() => setProgressOpen(true)} aria-label="查看评阅进度">
              {progress.error ? '进度异常' : <><b>{myCompleted}</b>/{myTotal}</>}
            </button>
            <button type="button" className="m-adm-nav-btn" aria-label="更多操作" onClick={() => setMoreOpen(true)}>
              <MoreOutlined style={{ fontSize: 20 }} />
            </button>
          </div>
        }
      >
        <button type="button" className="m-adm-title-btn" onClick={() => setProgressOpen(true)} aria-label="查看题目上下文与进度">
          <strong>{heading}</strong>
          <small>{projectName}{task?.grade_name ? ` · ${task.grade_name}` : ''}</small>
        </button>
      </NavBar>

      <div className="m-notices">
        {(error || workspace.storageError) && <NoticeBar color="error" wrap content={error || workspace.storageError} />}
        {published && <NoticeBar color="alert" wrap content="成绩已锁定：题卡已发布，仅可查看历史记录，不可改分或回评。" />}
        {reopened && <NoticeBar color="info" wrap content="复核中 · 可回评：当前可继续评分、回评或从指定份起顺序重阅。" />}
        {workspace.offline && <NoticeBar color="info" wrap content="离线评阅：评分保存在本机，联网后自动补传。" />}
        <div ref={workspace.setQueueTarget} className="m-queue-slot" />
      </div>

      {task && question ? (
        <div className="m-work">
          <div className="m-reading-wrap">
            <div
              ref={readingRef}
              className="m-reading"
              aria-label="作答图像区"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            >
              <div className={`m-sheet-stage${pinching ? ' is-pinching' : ''}`} style={stageWidthStyle}>
                {record ? (
                  <ReviewImage sheet={record.sheet} image={record.image} style={{ filter: `contrast(${contrast})` }} />
                ) : (
                  <Empty description="正在准备题图…" />
                )}
              </div>
            </div>
            <div className="m-zoom-bar" role="toolbar" aria-label="题图缩放与显示">
              <button
                type="button"
                aria-label="缩小作答"
                disabled={!canZoomOut(zoom)}
                onClick={() => setZoom(z => stepZoom(z, -1))}
              >
                −
              </button>
              <button
                type="button"
                aria-label="复位适应宽度并回到卷首"
                aria-pressed={isDefaultZoom(zoom)}
                onClick={resetZoomAndScroll}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                aria-label="放大作答"
                disabled={!canZoomIn(zoom)}
                onClick={() => setZoom(z => stepZoom(z, 1))}
              >
                +
              </button>
              <button
                type="button"
                aria-pressed={contrast > 1}
                onClick={() => setContrast(c => (c > 1 ? 1 : 1.45))}
              >
                优化图像
              </button>
            </div>
          </div>

          <aside className="m-deck" aria-label="评分板">
            <div className="m-deck-top">
              <div className="m-deck-badges">
                <span>本题给分</span>
                {question.review_mode === 'double' && <Tag fill="outline">双评</Tag>}
                {task.review_role === 'arbitration' && <Tag color="warning">仲裁</Tag>}
                {task.regrading && <Tag color="warning">重阅</Tag>}
                {published && <Tag color="danger">已锁定</Tag>}
              </div>
              <button
                type="button"
                className="m-link-btn"
                aria-expanded={presetsOpen}
                onClick={() => setPresetsOpen(v => !v)}
              >
                {presetsOpen ? '收起选分' : '展开选分'}
              </button>
            </div>

            {presetsOpen && (
              <div className="m-adm-presets-wrap" aria-label="常用分值">
                <Selector
                  columns={wide ? 2 : 4}
                  disabled={!editable}
                  showCheckMark={false}
                  value={value !== null ? [String(value)] : []}
                  options={presets.map(n => ({ label: String(n), value: String(n) }))}
                  onChange={arr => {
                    if (arr[0] !== undefined) editScore(arr[0])
                  }}
                />
              </div>
            )}

            <div className="m-actions">
              <label className={`m-score-field${scoreError || skipWarn ? ' is-error' : ''}`}>
                <input
                  inputMode="decimal"
                  type="text"
                  autoComplete="off"
                  readOnly={!editable}
                  value={scoreText}
                  aria-label={`给分，满分 ${question.points} 分`}
                  aria-invalid={!!scoreError || skipWarn}
                  onChange={e => editScore(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.repeat) {
                      e.preventDefault()
                      void submit()
                    }
                  }}
                />
                <span>/ {question.points}</span>
              </label>
              <Button
                color="primary"
                size="large"
                className="m-send-btn"
                disabled={!canSubmit || action.pending === 'score'}
                loading={action.pending === 'score'}
                onClick={() => void submit()}
              >
                {automatic ? '提交并下一份' : '提交评分'}
              </Button>
            </div>

            <div className="m-deck-foot">
              <span className={`m-feedback${scoreError || skipWarn ? ' is-error' : ''}`} aria-live="polite">
                {scoreError || queueStatus || feedback || (record?.status === 'draft' ? saveState : '')}
              </span>
              <div className="m-quick-nav">
                <button
                  type="button"
                  disabled={published || locked || workspace.offline || record?.status === 'queued' || record?.status === 'conflict'}
                  onClick={() => void previous()}
                >
                  上一份
                </button>
                <button
                  type="button"
                  disabled={published || locked || (workspace.offline && editable)}
                  onClick={() => void (record?.status === 'draft' ? skip() : next())}
                >
                  {record?.status === 'draft' ? '跳过' : '下一份'}
                </button>
              </div>
            </div>
          </aside>
        </div>
      ) : (
        <div className="m-adm-body" style={{ justifyContent: 'center' }}>
          <Empty
            description={
              published
                ? '成绩已锁定，不可继续评分或回评'
                : busy || templateResource.loading
                  ? '正在加载作答…'
                  : reopened
                    ? '复核中：当前没有待领作答，可从历史进入回评'
                    : '当前没有可领取的作答'
            }
          />
          <Space justify="center" wrap block>
            <Button size="small" disabled={!question || locked || workspace.offline} onClick={openHistory}>
              {published ? '查看记录' : reopened ? '复核回评' : '历史与回评'}
            </Button>
            {!published && (
              <Button size="small" color="primary" disabled={!question || locked || workspace.offline} loading={action.pending === 'claim'} onClick={() => void next()}>
                重新领取
              </Button>
            )}
            <Button size="small" onClick={() => void leave()}>返回列表</Button>
          </Space>
        </div>
      )}

      {osd && <div className="m-osd" role="status">{osd.text}</div>}

      <ActionSheet
        visible={moreOpen}
        closeOnAction
        cancelText="取消"
        actions={moreActions}
        onClose={() => setMoreOpen(false)}
      />

      <Popup
        visible={historyOpen}
        onMaskClick={() => setHistoryOpen(false)}
        position={wide ? 'right' : 'bottom'}
        bodyStyle={
          wide
            ? { width: 'min(420px, 85vw)', height: '100%', maxHeight: 'var(--mobile-vh, 100dvh)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
            : { borderTopLeftRadius: 16, borderTopRightRadius: 16, height: 'min(76dvh, calc(var(--mobile-vh, 100dvh) - 12px))', maxHeight: 'calc(var(--mobile-vh, 100dvh) - 12px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
        }
      >
        <div className="m-adm-popup-head">
          <strong>{published ? '我的评分记录（已锁定）' : reopened ? '历史与回评（复核中）' : '评分历史与回评'}</strong>
          <Space style={{ '--gap': '8px' }}>
            <Button size="mini" fill="outline" loading={historyLoading} disabled={workspace.offline} onClick={() => void loadHistory()}>
              <ReloadOutlined /> 刷新
            </Button>
            <Button size="mini" fill="none" onClick={() => setHistoryOpen(false)}>关闭</Button>
          </Space>
        </div>
        <div className="m-adm-popup-body" style={{ flex: 1 }}>
          {historyError && (
            <ErrorBlock status="default" title="历史评分加载失败" description={historyError}>
              <Button size="small" color="primary" onClick={() => void loadHistory()}>重试</Button>
            </ErrorBlock>
          )}
          {published && <NoticeBar color="alert" wrap content="成绩已锁定：题卡已发布，教师端不可改分或回评。" />}
          {reopened && <NoticeBar color="info" wrap content="复核中 · 可回评：当前可回评历史作答或从指定份起顺序重阅。" />}
          {historyLoading && history.length === 0 ? (
            <Empty description="正在加载评分历史…" />
          ) : !historyError && history.length === 0 ? (
            <Empty description="暂无历史评分记录" />
          ) : (
            <List>
              {history.map(row => (
                <List.Item
                  key={row.id}
                  title={`我的给分：${row.score} 分 · 最终：${row.final_score != null ? `${row.final_score} 分` : '待汇总'}`}
                  description={`作答 #${String(row.id).slice(0, 8)} · ${new Date(row.created_at * 1000).toLocaleString()}`}
                  extra={
                    published ? (
                      <Tag color="danger">已锁定</Tag>
                    ) : (
                      <Space style={{ '--gap': '6px' }}>
                        <Button
                          size="mini"
                          color="primary"
                          disabled={workspace.offline || locked || record?.status === 'queued' || record?.status === 'conflict'}
                          loading={action.pending === `history:${row.id}`}
                          onClick={() => void reviewHistory(row)}
                        >
                          回评
                        </Button>
                        <Button
                          size="mini"
                          fill="outline"
                          disabled={workspace.offline || locked}
                          onClick={() => { setRegradeStart(row); setRegradeReason('') }}
                        >
                          从此重阅
                        </Button>
                      </Space>
                    )
                  }
                />
              ))}
            </List>
          )}
        </div>
      </Popup>

      <Popup
        visible={!!regradeStart}
        onMaskClick={() => setRegradeStart(null)}
        position="bottom"
        bodyStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: 'calc(var(--mobile-vh, 100dvh) - 12px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div className="m-adm-popup-head">
          <strong>从这份评分起顺序重阅</strong>
          <Button size="mini" fill="none" onClick={() => setRegradeStart(null)}>取消</Button>
        </div>
        <div className="m-adm-popup-body">
          <div style={{ fontSize: 13, color: 'var(--adm-color-text-secondary)', lineHeight: 1.55 }}>
            按评分历史的时间顺序，将这份（作答 #{String(regradeStart?.id || '').slice(0, 8)}）及之后本题的本人评分加入重阅。提交新评分前保留原分，全部重阅完成后才能发布成绩。
          </div>
          <TextArea
            placeholder="请填写重阅原因"
            rows={3}
            value={regradeReason}
            onChange={setRegradeReason}
            style={{ border: '1px solid var(--adm-color-border)', borderRadius: 8, padding: 8 }}
          />
          <Button
            block
            color="primary"
            size="large"
            disabled={!regradeReason.trim() || action.pending === 'regrade'}
            loading={action.pending === 'regrade'}
            onClick={() => void regradeFrom()}
          >
            确认加入重阅
          </Button>
        </div>
      </Popup>

      <Popup
        visible={progressOpen}
        onMaskClick={() => setProgressOpen(false)}
        position={wide ? 'right' : 'bottom'}
        bodyStyle={
          wide
            ? { width: 'min(380px, 85vw)', height: '100%', maxHeight: 'var(--mobile-vh, 100dvh)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
            : { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: 'min(72dvh, calc(var(--mobile-vh, 100dvh) - 12px))', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
        }
      >
        <div className="m-adm-popup-head">
          <strong>任务详情与评阅进度</strong>
          <Button size="mini" fill="none" onClick={() => setProgressOpen(false)}>关闭</Button>
        </div>
        <div className="m-adm-popup-body">
          <div className="m-context-card">
            <strong>{fullContextLabel || projectName}</strong>
            <div>{question ? `第 ${questionLabel(question)} 题 · 满分 ${question.points} 分 · ${question.review_mode === 'double' ? '双评盲评' : '单评'}` : ''}</div>
            {roomTagLabels.length > 0 && <div>考场标签：{roomTagLabels.join('、')}</div>}
          </div>
          {progress.error ? (
            <ErrorBlock status="default" title="评阅进度加载失败" description={progress.error}>
              <Button size="small" color="primary" onClick={() => void progress.reload()}>重试</Button>
            </ErrorBlock>
          ) : !progress.loaded && progress.loading ? (
            <Empty description="正在加载评阅进度…" />
          ) : (
            <List>
              <List.Item title="我的任务" extra={<strong>{myCompleted} / {myTotal} 份</strong>} description={`本次完成 ${count} 份${count ? ` · 平均 ${(seconds / count).toFixed(1)} 秒/份` : ''}`} />
              <List.Item
                title="待处理与总量"
                description={`正在评阅 ${progress.data.my_in_progress || 0} · 待重阅 ${progress.data.my_regrade_pending || 0}${(progress.data.my_arbitration_pending || 0) > 0 ? ` · 待仲裁 ${progress.data.my_arbitration_pending}` : ''} · 本题总作答 ${progress.data.total_submissions || 0}`}
              />
              <List.Item title="我的进度" extra={`${Math.round(Number(progress.data.my_progress || 0))}%`} description={<ProgressBar percent={Math.round(Number(progress.data.my_progress || 0))} style={{ marginTop: 6 }} />} />
              <List.Item title="本题全员进度" extra={`${Math.round(Number(progress.data.question_progress || 0))}%`} description={<ProgressBar percent={Math.round(Number(progress.data.question_progress || 0))} style={{ marginTop: 6 }} />} />
              <List.Item title="本卷全员进度" extra={`${Math.round(Number(progress.data.paper_progress || 0))}%`} description={<ProgressBar percent={Math.round(Number(progress.data.paper_progress || 0))} style={{ marginTop: 6 }} />} />
            </List>
          )}
          <Button block fill="outline" loading={progress.loading} disabled={!question || workspace.offline} onClick={() => void progress.reload()}>
            <ReloadOutlined /> 刷新进度
          </Button>
        </div>
      </Popup>

      <Popup
        visible={settingsOpen}
        onMaskClick={() => setSettingsOpen(false)}
        position={wide ? 'right' : 'bottom'}
        bodyStyle={
          wide
            ? { width: 'min(360px, 85vw)', height: '100%', maxHeight: 'var(--mobile-vh, 100dvh)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
            : { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: 'min(72dvh, calc(var(--mobile-vh, 100dvh) - 12px))', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
        }
      >
        <div className="m-adm-popup-head">
          <strong>阅卷设置</strong>
          <Button size="mini" fill="none" onClick={() => setSettingsOpen(false)}>关闭</Button>
        </div>
        <div className="m-adm-popup-body">
          <List>
            <List.Item
              title="预设分值步进"
              extra={<Stepper min={0.5} max={10} step={0.5} value={step} onChange={n => setStep(n || 0.5)} />}
            />
            <List.Item
              title="服务端确认后自动下一份"
              extra={<Switch checked={automatic} onChange={setAutomatic} />}
            />
            <List.Item
              title="题图高对比度显示"
              extra={<Switch checked={contrast > 1} onChange={v => setContrast(v ? 1.45 : 1)} />}
            />
            {workspace.pendingCount > 0 && (
              <List.Item
                title={`本地待传记录（${workspace.pendingCount}）`}
                arrow
                onClick={() => { setSettingsOpen(false); workspace.openQueueModal() }}
              />
            )}
          </List>
          {task && question && !published && !workspace.offline && (
            <Space wrap block>
              <Button size="small" fill="outline" disabled={locked} onClick={() => { setSettingsOpen(false); void reportCurrent('exception') }}>报告异常卷</Button>
              <Button size="small" fill="outline" disabled={locked} onClick={() => { setSettingsOpen(false); void reportCurrent('excellent') }}>标记优秀卷</Button>
            </Space>
          )}
          <Button block fill="outline" onClick={() => { setSettingsOpen(false); onSwitchDesktop() }}>
            <DesktopOutlined /> 切换到桌面版阅卷台
          </Button>
        </div>
      </Popup>
    </section>
  )
}
