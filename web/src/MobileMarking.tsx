import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Alert, App, Drawer, Input, InputNumber, Modal, Progress, Space, Switch, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, DesktopOutlined, HistoryOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons'
import { ApiError, request, send, useResource, watchChanges, type Row, type Template } from './api'
import { Button } from './Button'
import { questionLabel } from './mergeQuestions'
import { isMobileWideLayout, rememberMobileTask } from './mobilePlatform'
import { ReviewImage } from './ReviewImage'
import { loadReviewSheet } from './reviewImages'
import { previousReview, scoreInputError, scorePresets } from './reviewInteraction'
import { cacheReview, enqueueReview, forgetReview, getReview, hasUnsentReview, listReviews, saveReviewDraft, settleReviewWrites, type ReviewRecord } from './reviewStore'
import { useReviewWorkspace } from './ReviewWorkspace'
import { useAction } from './useAction'
import { useUnsavedChanges } from './useNavigation'

type Props = {
  initialProjectId?: string
  initialTemplateId: string
  initialQuestionId: string
  onBack: (projectId?: string) => void
  onSwitchDesktop: () => void
}

const MIN_ZOOM = 0.75
const MAX_ZOOM = 3.5

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
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null)
  const lastTap = useRef(0)

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

  // Remember last active task for "继续阅卷"
  useEffect(() => {
    if (!templateId || !questionId) return
    rememberMobileTask(workspace.user.id, {
      projectId: subject?.project_id || record?.template.project_id || initialProjectId,
      projectName: project?.name || record?.template.project_name,
      subjectName: subject?.name || record?.template.subject_name,
      templateId,
      templateName: template?.name || record?.template.name,
      questionId,
      questionLabel: question ? questionLabel(question) : undefined,
      points: question?.points,
    })
  }, [workspace.user.id, templateId, questionId, subject?.project_id, subject?.name, project?.name, template?.name, question?.id, question?.points, record?.template.project_id, record?.template.project_name, record?.template.subject_name, record?.template.name, initialProjectId])

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

  async function availableTask(from?: string): Promise<ReviewRecord | null> {
    const local = (await listReviews(workspace.user.id)).filter(r => r.template.id === templateId && r.question.id === questionId)
    const drafts = local.filter(r => r.status === 'draft' && r.task.id !== from && (hasUnsentReview(r) || workspace.offline || r.task.status !== 'claimed' || r.task.expires_at * 1000 > Date.now()))
    const cached = drafts.find(hasUnsentReview) || drafts.at(-1)
    if (cached && hasUnsentReview(cached)) return cached
    if (workspace.offline || !navigator.onLine) return cached || null
    const held = local.filter(r => r.operation).map(r => r.task.id)
    if (from && !held.includes(from)) held.push(from)
    let row: Row | null
    try {
      row = await send<Row | null>('/tasks/claim', { template_id: templateId, question_id: questionId, pending_task_ids: held })
    } catch (e) {
      if (cached && (!(e instanceof ApiError) || e.status === 403)) return cached
      throw e
    }
    if (!row || held.includes(row.id)) return null
    const saved = await cacheTask(row)
    return saved.status === 'draft' ? saved : null
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
    try {
      const rows = (await request<Row[]>(`/tasks/history?template_id=${encodeURIComponent(templateId)}&question_id=${encodeURIComponent(questionId)}`)).reverse()
      if (context === historyContext.current && version === historyVersion.current) {
        setHistory(rows)
        return rows
      }
    } catch (e) {
      if (context === historyContext.current && version === historyVersion.current) setError((e as Error).message)
    }
  }

  useEffect(() => watchChanges(roots => {
    if (templateId && questionId && historyOpen && (!roots || roots.includes('tasks'))) void loadHistory()
  }), [templateId, questionId, historyOpen])

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
        setError((e as Error).message)
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
        if (!rows) return
        const row = previousReview(rows, task?.id)
        if (row) await openTask(await request<Row>(`/tasks/${row.id}`))
        else message.info('已到最早一份评分')
      } catch (e) {
        setError((e as Error).message)
      }
    })
  }

  function regradeFrom(row: Row) {
    if (published) {
      message.warning('成绩已锁定，不可从此处重阅')
      return
    }
    let reason = ''
    Modal.confirm({
      title: '从这份评分起顺序重阅',
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>按评分历史的时间顺序，将这份及之后本题的本人评分加入重阅。提交新评分前保留原分。</Typography.Text>
          <Input.TextArea placeholder="填写重阅原因" rows={3} onChange={e => { reason = e.target.value }} />
        </Space>
      ),
      onOk: async () => {
        if (!reason.trim()) {
          message.error('请填写重阅原因')
          throw new Error('请填写重阅原因')
        }
        try {
          const result = await send<{ queued: number }>(`/tasks/${row.id}/regrade-from`, { reason })
          setHistoryOpen(false)
          await progress.reload()
          await next()
          message.success(`已加入 ${result.queued} 份重阅任务`)
        } catch (e) {
          message.error((e as Error).message)
          throw e
        }
      },
    })
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom }
    } else if (pointers.current.size === 1 && e.pointerType === 'touch') {
      const now = Date.now()
      if (now - lastTap.current < 280) {
        setZoom(z => (z > 1.1 ? 1 : 1.75))
        lastTap.current = 0
      } else {
        lastTap.current = now
      }
    }
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2 && pinchStart.current && pinchStart.current.dist > 0) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchStart.current.zoom * (dist / pinchStart.current.dist)))
      setZoom(Number(nextZoom.toFixed(2)))
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchStart.current = null
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

  return (
    <section ref={rootRef} className={`m-marking${wide ? ' is-landscape' : ''}`} aria-label="手机阅卷工作台">
      <header className="m-bar">
        <button type="button" className="m-bar-back" aria-label="返回我的阅卷" onClick={leave}>
          <ArrowLeftOutlined />
        </button>
        <div className="m-bar-title">
          <strong>{heading}</strong>
          <small>{projectName}{task?.grade_name ? ` · ${task.grade_name}` : ''}</small>
        </div>
        <div className="m-bar-right">
          <button type="button" className="m-progress-pill" onClick={() => setProgressOpen(true)} aria-label="查看评阅进度">
            已评 <b>{myCompleted}</b> / {myTotal}
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
              <div className="m-sheet-stage" style={{ width: `${Math.round(zoom * 100)}%` }}>
                {record ? (
                  <ReviewImage sheet={record.sheet} image={record.image} style={{ filter: `contrast(${contrast})` }} />
                ) : (
                  <div className="m-empty">正在准备题图…</div>
                )}
              </div>
            </div>
            <div className="m-zoom-fab" aria-label="题图缩放与显示">
              <button type="button" aria-label="缩小作答" onClick={() => setZoom(z => Math.max(MIN_ZOOM, Number((z - 0.25).toFixed(2))))}>−</button>
              <button type="button" aria-label="重置缩放" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button type="button" aria-label="放大作答" onClick={() => setZoom(z => Math.min(MAX_ZOOM, Number((z + 0.25).toFixed(2))))}>+</button>
              <button type="button" aria-pressed={contrast > 1} onClick={() => setContrast(c => (c > 1 ? 1 : 1.45))}>优化</button>
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
        height={wide ? undefined : '72vh'}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
      >
        {published && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="成绩已锁定" description="题卡成绩已发布，教师端不可改分或回评。" />}
        {reopened && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="复核中 · 可回评" description="管理员已发起成绩复核，当前可回评历史作答或从指定份起顺序重阅。" />}
        {history.length === 0 ? (
          <div className="m-empty">暂无历史评分记录</div>
        ) : (
          history.map(row => (
            <div key={row.id} className="m-history-item">
              <div className="m-history-meta">
                <strong>我的给分：{row.score} 分{row.final_score != null ? ` · 最终 ${row.final_score} 分` : ''}</strong>
                <small>{new Date(row.created_at * 1000).toLocaleString()}</small>
              </div>
              {published ? (
                <Tag color="red">已锁定</Tag>
              ) : (
                <Space size={6}>
                  <Button
                    size="small"
                    type="primary"
                    disabled={workspace.offline || locked || record?.status === 'queued' || record?.status === 'conflict'}
                    loading={action.pending === `history:${row.id}`}
                    onClick={() => void reviewHistory(row)}
                  >
                    回评
                  </Button>
                  <Button size="small" disabled={workspace.offline || locked} onClick={() => regradeFrom(row)}>
                    顺序重阅
                  </Button>
                </Space>
              )}
            </div>
          ))
        )}
      </Drawer>

      <Drawer
        title="评阅进度"
        placement={wide ? 'right' : 'bottom'}
        width={wide ? 360 : undefined}
        height={wide ? undefined : '56vh'}
        open={progressOpen}
        onClose={() => setProgressOpen(false)}
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div>我的任务：<strong>{myCompleted} / {myTotal}</strong> 份（本次完成 {count} 份{count ? `，平均 ${(seconds / count).toFixed(1)} 秒/份` : ''}）</div>
          <div>正在评阅 {progress.data.my_in_progress || 0} · 待重阅 {progress.data.my_regrade_pending || 0} · 本题总作答 {progress.data.total_submissions || 0}</div>
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
          <Button icon={<ReloadOutlined />} loading={progress.loading} disabled={!question || workspace.offline} onClick={progress.reload}>
            刷新进度
          </Button>
        </Space>
      </Drawer>

      <Drawer
        title="阅卷设置"
        placement={wide ? 'right' : 'bottom'}
        width={wide ? 360 : undefined}
        height={wide ? undefined : '60vh'}
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
