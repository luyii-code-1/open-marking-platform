import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Alert, App, Drawer, Input, InputNumber, Modal, Progress, Space, Switch, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, DesktopOutlined, HistoryOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons'
import { ApiError, request, send, useResource, watchChanges, type Row, type Template } from './api'
import { Button } from './Button'
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

  // Pinch-to-zoom & double-tap tracking
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = useRef<PinchState | null>(null)
  const tapStart = useRef<{ id: number; x: number; y: number; moved: number } | null>(null)
  const lastTap = useRef<TapRecord | null>(null)
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

  // Track visualViewport height (soft keyboard) and orientation without remounting component
  useLayoutEffect(() => {
    const syncViewport = () => {
      const vh = window.visualViewport?.height ?? window.innerHeight
      const vw = window.visualViewport?.width ?? window.innerWidth
      if (rootRef.current) rootRef.current.style.setProperty('--mobile-vh', `${Math.max(280, Math.round(vh))}px`)
      setWide(isMobileWideLayout(vw, vh))
    }
    syncViewport()
    window.addEventListener('resize', syncViewport)
    window.addEventListener('orientationchange', syncViewport)
    window.visualViewport?.addEventListener('resize', syncViewport)
    return () => {
      window.removeEventListener('resize', syncViewport)
      window.removeEventListener('orientationchange', syncViewport)
      window.visualViewport?.removeEventListener('resize', syncViewport)
    }
  }, [])

  // Refresh progress & sync on foreground resume
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

  // Measure reading viewport width so SVG & img scale accurately without expanding layout
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

  // Prevent browser pinch-zoom hijack inside the answer reading canvas while allowing 1-finger scroll
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

  // Reset transient gesture pointers on orientation change
  useEffect(() => {
    pointers.current.clear()
    pinchStart.current = null
    tapStart.current = null
  }, [wide])

  // Remember last active task for "继续阅卷" only after confirming it is a valid authorized task
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

  // Prefetch next task while grading
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

  // Initial entry: restore cached draft or claim first task
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
    if (value !== null && !window.confirm('当前分数尚未提交，确认跳过这份作答？')) return
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
    if (record?.status === 'draft' && value !== null && record.task.id !== row.id && !window.confirm('当前给分尚未提交，确认先回评历史作答？本地草稿会保留。')) return
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
    if (record?.status === 'draft' && value !== null && !window.confirm('当前给分尚未提交，确认回评上一份？本地草稿会保留。')) return
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
        // Fetch the first queued regrade even when an ordinary task was prefetched.
        const first = await availableTask(undefined, true)
        if (first) showRecord(first)
      } catch (e) {
        message.error((e as Error).message)
      }
    })
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
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      tapStart.current = null
      lastTap.current = null
      const el = readingRef.current
      if (el) {
        const [a, b] = [...pointers.current.values()]
        pinchStart.current = beginPinch(a, b, el.getBoundingClientRect(), el.scrollLeft, el.scrollTop, zoom)
      }
    } else if (pointers.current.size === 1 && e.pointerType === 'touch') {
      tapStart.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
    }
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (tapStart.current && tapStart.current.id === e.pointerId) {
      tapStart.current.moved = Math.max(tapStart.current.moved, Math.hypot(e.clientX - tapStart.current.x, e.clientY - tapStart.current.y))
    }
    if (pointers.current.size === 2 && pinchStart.current && readingRef.current) {
      const [a, b] = [...pointers.current.values()]
      const next = updatePinch(pinchStart.current, a, b, readingRef.current.getBoundingClientRect())
      setZoom(next.zoom)
      requestAnimationFrame(() => {
        if (readingRef.current) {
          readingRef.current.scrollLeft = next.scrollLeft
          readingRef.current.scrollTop = next.scrollTop
        }
      })
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchStart.current = null
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

  return (
    <section ref={rootRef} className={`m-marking${wide ? ' is-landscape' : ''}`} aria-label="手机阅卷工作台">
      <header className="m-bar">
        <button type="button" className="m-bar-back" aria-label="返回我的阅卷" onClick={leave}>
          <ArrowLeftOutlined />
        </button>
        <button type="button" className="m-bar-title" onClick={() => setProgressOpen(true)} aria-label="查看题目详情与评阅进度">
          <strong>{heading}</strong>
          <small>{projectName}{task?.grade_name ? ` · ${task.grade_name}` : ''}</small>
        </button>
        <div className="m-bar-right">
          <WorkspaceNotificationButton compact onlyWhenActive />
          <button type="button" className="m-progress-pill" onClick={() => setProgressOpen(true)} aria-label="查看评阅进度">
            {progress.error ? '进度异常' : <>已评 <b>{myCompleted}</b> / {myTotal}</>}
          </button>
          <button type="button" className="m-bar-action" aria-label={published ? '评分记录' : '历史与回评'} disabled={!question || workspace.offline || locked} onClick={openHistory}>
            <HistoryOutlined />
          </button>
          <button type="button" className="m-bar-action" aria-label="阅卷设置" onClick={() => setSettingsOpen(true)}>
            <SettingOutlined />
          </button>
        </div>
      </header>

      <div className="m-notices">
        {(error || workspace.storageError) && <div className="m-banner error" role="alert">{error || workspace.storageError}</div>}
        {published && <div className="m-banner warn">成绩已锁定：题卡已发布，仅可查看历史记录，不可改分或回评。</div>}
        {reopened && <div className="m-banner info">复核中 · 可回评：当前可继续评分、回评或从指定份起顺序重阅。</div>}
        {workspace.offline && <div className="m-banner info">离线评阅：评分保存在本机，联网后自动补传。</div>}
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
              onPointerCancel={handlePointerUp}
            >
              <div className="m-sheet-stage" style={stageWidthStyle}>
                {record ? (
                  <ReviewImage sheet={record.sheet} image={record.image} style={{ filter: `contrast(${contrast})` }} />
                ) : (
                  <div className="m-empty">正在准备题图…</div>
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
                {question.review_mode === 'double' && <Tag style={{ margin: 0 }}>双评</Tag>}
                {task.review_role === 'arbitration' && <Tag color="orange" style={{ margin: 0 }}>仲裁</Tag>}
                {task.regrading && <Tag color="orange" style={{ margin: 0 }}>重阅</Tag>}
                {published && <Tag color="red" style={{ margin: 0 }}>已锁定</Tag>}
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
              <div className="m-presets" aria-label="常用分值">
                {presets.map(n => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={value === n}
                    disabled={!editable}
                    onClick={() => editScore(String(n))}
                  >
                    {n}
                  </button>
                ))}
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
              <button
                type="button"
                className="m-primary-btn m-send-btn"
                disabled={!canSubmit || action.pending === 'score'}
                onClick={() => void submit()}
              >
                {action.pending === 'score' ? '提交中…' : automatic ? '提交并下一份' : '提交评分'}
              </button>
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
        <div className="m-page" style={{ justifyContent: 'center' }}>
          <div className="m-empty">
            <strong>
              {published
                ? '成绩已锁定，不可继续评分或回评'
                : busy || templateResource.loading
                  ? '正在加载作答…'
                  : reopened
                    ? '复核中：当前没有待领作答，可从历史进入回评'
                    : '当前没有可领取的作答'}
            </strong>
            <Space wrap>
              <Button disabled={!question || locked || workspace.offline} onClick={openHistory}>
                {published ? '查看记录' : reopened ? '复核回评' : '历史与回评'}
              </Button>
              {!published && (
                <Button type="primary" disabled={!question || locked || workspace.offline} loading={action.pending === 'claim'} onClick={next}>
                  重新领取
                </Button>
              )}
              <Button onClick={leave}>返回列表</Button>
            </Space>
          </div>
        </div>
      )}

      {osd && <div className="m-osd" role="status">{osd.text}</div>}

      <Drawer
        title={published ? '我的评分记录（已锁定）' : reopened ? '历史与回评（复核中）' : '评分历史与回评'}
        placement={wide ? 'right' : 'bottom'}
        width={wide ? 420 : undefined}
        height={wide ? undefined : '74dvh'}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        extra={<Button size="small" icon={<ReloadOutlined />} loading={historyLoading} disabled={workspace.offline} onClick={() => void loadHistory()}>刷新</Button>}
      >
        {historyError && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message="历史评分加载失败"
            description={historyError}
            action={<Button size="small" onClick={() => void loadHistory()}>重试</Button>}
          />
        )}
        {published && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="成绩已锁定" description="题卡成绩已发布，教师端不可改分或回评。" />}
        {reopened && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="复核中 · 可回评" description="管理员已发起成绩复核，当前可回评历史作答或从指定份起顺序重阅。" />}
        {historyLoading && history.length === 0 ? (
          <div className="m-empty">正在加载评分历史…</div>
        ) : !historyError && history.length === 0 ? (
          <div className="m-empty">暂无历史评分记录</div>
        ) : (
          history.map(row => (
            <div key={row.id} className="m-history-item">
              <div className="m-history-meta">
                <strong>
                  我的给分：{row.score} 分 · 最终：{row.final_score != null ? `${row.final_score} 分` : '待汇总'}
                </strong>
                <small title={String(row.id)}>
                  作答 #{String(row.id).slice(0, 8)} · {new Date(row.created_at * 1000).toLocaleString()}
                </small>
              </div>
              {published ? (
                <Tag color="red">已锁定</Tag>
              ) : (
                <Space size={6} wrap>
                  <Button
                    size="small"
                    type="primary"
                    disabled={workspace.offline || locked || record?.status === 'queued' || record?.status === 'conflict'}
                    loading={action.pending === `history:${row.id}`}
                    onClick={() => void reviewHistory(row)}
                  >
                    回评
                  </Button>
                  <Button
                    size="small"
                    disabled={workspace.offline || locked}
                    onClick={() => { setRegradeStart(row); setRegradeReason('') }}
                  >
                    从此重阅
                  </Button>
                </Space>
              )}
            </div>
          ))
        )}
      </Drawer>

      <Modal
        title="从这份评分起顺序重阅"
        open={!!regradeStart}
        okText="加入重阅"
        cancelText="取消"
        okButtonProps={{ disabled: !regradeReason.trim() || action.pending === 'regrade', loading: action.pending === 'regrade' }}
        onOk={() => void regradeFrom()}
        onCancel={() => setRegradeStart(null)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>
            按评分历史的时间顺序，将这份（作答 #{String(regradeStart?.id || '').slice(0, 8)}）及之后本题的本人评分加入重阅。提交新评分前保留原分，全部重阅完成后才能发布成绩。
          </Typography.Text>
          <Input.TextArea
            placeholder="请填写重阅原因"
            rows={3}
            value={regradeReason}
            onChange={e => setRegradeReason(e.target.value)}
          />
        </Space>
      </Modal>

      <Drawer
        title="任务详情与评阅进度"
        placement={wide ? 'right' : 'bottom'}
        width={wide ? 380 : undefined}
        height={wide ? undefined : '64dvh'}
        open={progressOpen}
        onClose={() => setProgressOpen(false)}
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div className="m-context-card">
            <strong>{fullContextLabel || projectName}</strong>
            <div>
              {question ? `第 ${questionLabel(question)} 题 · 满分 ${question.points} 分 · ${question.review_mode === 'double' ? '双评盲评' : '单评'}` : ''}
            </div>
            {roomTagLabels.length > 0 && <div>考场标签：{roomTagLabels.join('、')}</div>}
          </div>
          {progress.error ? (
            <Alert
              type="error"
              showIcon
              message="评阅进度加载失败"
              description={progress.error}
              action={<Button size="small" onClick={() => void progress.reload()}>重试</Button>}
            />
          ) : !progress.loaded && progress.loading ? (
            <div className="m-empty">正在加载评阅进度…</div>
          ) : (
            <>
              <div>我的任务：<strong>{myCompleted} / {myTotal}</strong> 份（本次完成 {count} 份{count ? `，平均 ${(seconds / count).toFixed(1)} 秒/份` : ''}）</div>
              <div>
                正在评阅 {progress.data.my_in_progress || 0} · 待重阅 {progress.data.my_regrade_pending || 0}
                {(progress.data.my_arbitration_pending || 0) > 0 ? ` · 待仲裁 ${progress.data.my_arbitration_pending}` : ''}
                {' · '}本题总作答 {progress.data.total_submissions || 0}
              </div>
              <div>
                <small>我的进度</small>
                <Progress percent={Math.round(Number(progress.data.my_progress || 0))} />
              </div>
              <div>
                <small>本题全员进度</small>
                <Progress percent={Math.round(Number(progress.data.question_progress || 0))} />
              </div>
              <div>
                <small>本卷全员进度</small>
                <Progress percent={Math.round(Number(progress.data.paper_progress || 0))} />
              </div>
            </>
          )}
          <Button icon={<ReloadOutlined />} loading={progress.loading} disabled={!question || workspace.offline} onClick={progress.reload}>
            刷新进度
          </Button>
        </Space>
      </Drawer>

      <Drawer
        title="阅卷设置"
        placement={wide ? 'right' : 'bottom'}
        width={wide ? 360 : undefined}
        height={wide ? undefined : '64dvh'}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      >
        <Space direction="vertical" size={18} style={{ width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>预设分值步进</span>
            <InputNumber aria-label="评分步进" min={0.01} max={10} step={0.5} value={step} onChange={n => setStep(n || 0.5)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>服务端确认后自动下一份</span>
            <Switch checked={automatic} onChange={setAutomatic} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>题图高对比度显示</span>
            <Switch checked={contrast > 1} onChange={v => setContrast(v ? 1.45 : 1)} />
          </div>
          {workspace.pendingCount > 0 && (
            <Button block onClick={() => { setSettingsOpen(false); workspace.openQueueModal() }}>
              查看本地待传记录（{workspace.pendingCount}）
            </Button>
          )}
          {task && question && (
            <Space wrap>
              {(['exception', 'excellent'] as const).map(kind => (
                <Button
                  key={kind}
                  disabled={published || workspace.offline || locked}
                  onClick={() => Modal.confirm({
                    title: kind === 'exception' ? '报告异常卷' : '标记优秀卷',
                    content: '将当前作答交由管理员查看。',
                    onOk: async () => {
                      await send(`/tasks/${task.id}/report`, { kind, reason: '' })
                      message.success('已报告')
                    },
                  })}
                >
                  {kind === 'exception' ? '报告异常卷' : '标记优秀卷'}
                </Button>
              ))}
            </Space>
          )}
          <Button icon={<DesktopOutlined />} block onClick={() => { setSettingsOpen(false); onSwitchDesktop() }}>
            切换到桌面版阅卷台
          </Button>
        </Space>
      </Drawer>
    </section>
  )
}
