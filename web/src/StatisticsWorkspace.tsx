import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Card, Dropdown, Empty, Input, InputNumber, Popconfirm, Progress, Segmented, Select, Space, Spin, Statistic, Tabs, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, DownloadOutlined, PlusOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { MultipleRecordSelect } from './RecordSelect'
import { FilterSummaryBar, type FilterChip } from './ReportToolkit'
import { ClassTags } from './SchoolTags'
import { MultiTagPicker } from './TagPicker'
import { announceChanges, download, request, send, useResource, type ExternalMode, type Row, type Template } from './api'
import { useUnsavedChanges } from './useNavigation'
import { Scans } from './Management'
import { DraftSaver } from './draftSaver'
import { CompatibleTemplateEditor } from './CompatibleTemplateEditor'

type Question = { type: 'single' | 'multiple'; options: number; title: string }
type CardState = {
  group_id: string
  template: Template | null
  external_draft?: Template | null
  draft: Question[] | null
  draft_version: number
  locked: boolean
  closed: boolean
  scans_purged: boolean
}
type ResultRow = {
  number: number
  title: string
  type: Question['type']
  options?: number
  counts: Record<string, number>
  blank: number
  invalid: number
  valid?: number
}
type ClassOption = { id: string; name: string; class_name: string; grade_name: string; tags: string[]; count: number }
type ClassBreakdown = { class_id: string; class_name: string; grade_name: string; tags: string[]; total: number; rows: ResultRow[] }
type ResponseRecord = {
  id: string
  index: number
  candidate_number: string
  student_name: string
  class_id: string
  class_name: string
  grade_name: string
  tags: string[]
  status: string
  answers: Record<string, string>
}
type Results = {
  total: number
  unfiltered_total?: number
  uses_candidate?: boolean
  rows: ResultRow[]
  classes?: ClassOption[]
  class_tags?: string[]
  by_class?: ClassBreakdown[]
  records?: ResponseRecord[]
}
type OverviewCard = {
  group_id: string
  group_name: string
  subject_id: string
  subject_name: string
  grade_id: string
  grade_name: string
  template_id: string | null
  template_name: string
  uses_candidate: boolean
  question_count: number
  closed: boolean
  received: number
  expected: number | null
  open_exceptions: number
}
type OverviewData = {
  project_id: string
  project_name: string
  card_count: number
  published_count: number
  closed_count: number
  total_received: number
  cards: OverviewCard[]
}

const defaultQuestion: Question = { type: 'single', options: 4, title: '' }
const blankResults: Results = { total: 0, rows: [], classes: [], class_tags: [], by_class: [], records: [] }

export function StatisticsWorkspace({ project, back }: { project: Row; back: () => void }) {
  const endpoint = `/projects/${project.id}/statistics`
  const data = useResource<CardState | null>(endpoint, null)
  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Space wrap><Button icon={<ArrowLeftOutlined />} onClick={back}>返回项目</Button>
      <Typography.Title level={4} style={{ margin: 0 }}>{project.name}</Typography.Title><Tag>统计</Tag></Space>
    <ErrorNotice error={data.error} retry={data.reload} />
    {data.data ? <StatisticsCard key={project.id} endpoint={endpoint} name={project.name} initial={data.data} refresh={data.reload} /> : !data.error && <Spin />}
  </Space>
}

function StatisticsCard({ endpoint, name, initial, refresh }: { endpoint: string; name: string; initial: CardState; refresh: () => Promise<unknown> }) {
  const [card, setCard] = useState(initial)
  const makeRows = (state: CardState): (Question & { key: string })[] => (state.draft ?? state.template?.questions ?? [defaultQuestion])
    .map(({ type, options, title }) => ({ type: type === 'multiple' ? 'multiple' : 'single', options, title: title || '', key: crypto.randomUUID() }))
  const [questions, setQuestions] = useState(() => makeRows(initial))
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false)
  const [section, setSection] = useState('design')
  const [creation, setCreation] = useState<'native' | 'external'>(() =>
    initial.template?.external_sheet || (!initial.template && initial.external_draft) ? 'external' : 'native')
  const [openedExternal, setOpenedExternal] = useState(creation === 'external')
  const { message } = App.useApp()
  useUnsavedChanges(dirty)

  function change(next: typeof questions) {
    setQuestions(next)
    setDirty(true)
  }

  async function save(publish: boolean) {
    setBusy(true)
    try {
      const saved = await send<CardState>(endpoint, {
        questions: questions.map(({ type, options, title }) => ({ type, options, title })),
        draft_version: card.draft_version, publish,
      }, 'PUT')
      setCard(saved)
      setDirty(false)
      announceChanges(['groups', 'templates', 'projects'])
      message.success(publish ? '统计题卡已发布' : '统计草稿已保存')
    } catch (error) { message.error((error as Error).message) }
    finally { setBusy(false) }
  }

  const scanLocked = initial.locked || card.locked
  const activeTemplate = initial.locked ? initial.template : card.template
  const draft = scanLocked ? null : card.draft
  const external = scanLocked ? !!activeTemplate?.external_sheet : creation === 'external'
  const visibleQuestions = scanLocked
    ? activeTemplate?.questions.map((q, i) => ({ type: q.type === 'multiple' ? 'multiple' as const : 'single' as const,
      options: q.options, title: q.title || '', key: 'published-' + i })) ?? []
    : questions
  const locked = scanLocked || busy
  const design = <Card title="统计题卡" extra={<Space wrap>
    {activeTemplate && !activeTemplate.external_sheet && <Tag color="green">第 {activeTemplate.revision} 版 · {activeTemplate.sides === 2 ? '双面' : '单面'}</Tag>}
    {draft && <Tag>草稿</Tag>}
    {!scanLocked && <Button disabled={!questions.length} loading={busy} onClick={() => save(false)}>保存草稿</Button>}
    <Button icon={<DownloadOutlined />} disabled={(!scanLocked && dirty) || (!draft && (!activeTemplate || !!activeTemplate.external_sheet))} onClick={() =>
      download(draft ? endpoint + '/preview' : `/templates/${activeTemplate!.id}/pdf`, `${name}.pdf`).catch(error => message.error(error.message))}>{draft ? '下载草稿预览' : '下载打印题卡'}</Button>
    {!scanLocked && <Popconfirm title={card.template ? '发布新版统计题卡？' : '发布统计题卡？'}
      description="正式扫描开始后锁定题目配置。" onConfirm={() => save(true)}>
      <Button type="primary" disabled={!questions.length || !!card.template && !card.draft && !dirty} loading={busy}>发布题卡</Button>
    </Popconfirm>}
  </Space>}>
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {scanLocked && <Alert type="info" showIcon message="扫描已开始，题卡已锁定。" />}
      <Typography.Text type="secondary">A4 题卡自动排版。每题可设 2–26 个选项，超过 13 个时自动换行。</Typography.Text>
      <Table rowKey="key" dataSource={visibleQuestions} pagination={false} columnChooser={false} exportable={false}
        columns={[
          { title: '题号', render: (_, _row, index) => index + 1, width: 70 },
          { title: '题目说明', render: (_, row) => <Input aria-label="题目说明" maxLength={64} disabled={locked}
            placeholder="选填" value={row.title} onChange={event => change(questions.map(q =>
              q.key === row.key ? { ...q, title: event.target.value } : q))} /> },
          { title: '题型', width: 116, render: (_, row) => <Select aria-label="题型" value={row.type} disabled={locked}
            options={[{ value: 'single', label: '单选' }, { value: 'multiple', label: '多选' }]}
            onChange={type => change(questions.map(q => q.key === row.key ? { ...q, type } : q))} /> },
          { title: '选项数', width: 165, render: (_, row) => <Space>
            <InputNumber aria-label="选项数" value={row.options} disabled={locked} min={2} max={26} precision={0}
              onChange={options => { if (options) change(questions.map(q => q.key === row.key ? { ...q, options } : q)) }} />
            <Typography.Text type="secondary">A–{String.fromCharCode(64 + row.options)}</Typography.Text>
          </Space> },
          ...(!scanLocked ? [{ title: '操作', width: 84, render: (_: unknown, row: typeof questions[number]) =>
            <Button type="link" danger disabled={busy} onClick={() => change(questions.filter(q => q.key !== row.key))}>删除</Button> }] : []),
        ]} />
      {!scanLocked && <Button icon={<PlusOutlined />} disabled={busy || questions.length >= 32}
        onClick={() => change([...questions, { ...defaultQuestion, key: crypto.randomUUID() }])}>添加题目</Button>}
    </Space>
    <StatisticsPaperPreview endpoint={endpoint} questions={visibleQuestions}
      published={!!activeTemplate && !activeTemplate.external_sheet && !dirty && !draft} />
  </Card>
  const designer = <Space direction="vertical" size={12} style={{ width: '100%' }}>
    {!scanLocked && <Segmented<'native' | 'external'> aria-label="制卡方式" value={creation} options={[
      { label: '系统制卡', value: 'native' }, { label: '从外部兼容导入', value: 'external' },
    ]} onChange={next => { setCreation(next); if (next === 'external') setOpenedExternal(true) }} />}
    {!external && design}
    {(external || openedExternal) && <div hidden={!external}><StatisticsExternalDesigner
      groupId={card.group_id} name={name} savedDraft={initial.external_draft}
      published={activeTemplate} locked={scanLocked}
      onPublished={async template => { setCard(old => ({ ...old, template, draft: null })); await refresh() }} /></div>}
  </Space>
  return <Tabs activeKey={section} onChange={setSection} items={[
    { key: 'design', label: '题卡', children: designer },
    { key: 'scans', label: '扫描与导入', children: activeTemplate ? <Scans groupId={card.group_id} /> :
      <Card><Empty description="发布统计题卡后即可创建扫描记录" /></Card> },
    { key: 'statistics', label: '统计结果', destroyOnHidden: true, children: <StatisticsResults
      endpoint={endpoint} name={name} closed={initial.closed} canChange={!initial.scans_purged} onCollectionChange={refresh} /> },
  ]} />
}

type PaperPreview = { page: number; sides: number; image: string }

function StatisticsPaperPreview({ endpoint, questions, published }: { endpoint: string; questions: Question[]; published: boolean }) {
  const [page, setPage] = useState(1), [result, setResult] = useState<PaperPreview>()
  const [error, setError] = useState('')
  const body = JSON.stringify(published ? { published: true } :
    { questions: questions.map(({ type, options, title }) => ({ type, options, title })) })
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setError('')
      if (!published && !questions.length) { setResult(undefined); return }
      void sendPreview().catch(error => {
        if (!controller.signal.aborted) { setError((error as Error).message); setResult(undefined) }
      })
    }, 300)
    async function sendPreview() {
      const response = await request<PaperPreview>(`${endpoint}/paper-preview?page=${page}`, {
        method: 'POST', body, signal: controller.signal,
      })
      if (!controller.signal.aborted) setResult(response)
    }
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [endpoint, body, page])
  return <Card title="题卡预览" style={{ marginTop: 16 }}
    extra={result?.sides === 2 ? <Segmented aria-label="预览纸面" value={result.page} options={[
      { label: '正面', value: 1 }, { label: '背面', value: 2 },
    ]} onChange={setPage} /> : undefined}>
    {error ? <Alert type="warning" showIcon message={error} /> : result
      ? <img src={result.image} alt={result.page === 2 ? '统计题卡背面预览' : '统计题卡正面预览'}
        style={{ display: 'block', width: '100%', maxWidth: 620, margin: '0 auto', border: '1px solid var(--border-color, #ddd)' }} />
      : questions.length ? <Spin /> : <Empty description="添加题目后预览题卡" />}
  </Card>
}

function newExternal(groupId: string, name: string, mode: ExternalMode): Template {
  return {
    id: crypto.randomUUID(), group_id: groupId, name, paper: 'A4', sides: 1,
    layout_version: 3, candidate_length: 0, revision: 0, status: 'draft', questions: [],
    statistics_sheet: true, external_sheet: { version: 1, mode, pages: {} },
  }
}

function StatisticsExternalDesigner({ groupId, name, savedDraft, published, locked, onPublished }: {
  groupId: string; name: string; savedDraft?: Template | null; published: Template | null; locked: boolean
  onPublished: (template: Template) => Promise<void>
}) {
  const { message } = App.useApp()
  const [, repaint] = useState(0)
  const [busy, setBusy] = useState(false)
  const [saver] = useState(() => new DraftSaver(
    savedDraft || (published?.external_sheet ? published : newExternal(groupId, name, 'blank')),
    ({ value, request_id, base_version }) =>
      send<Template>(`/groups/${groupId}/drafts/${value.id}`, { value, request_id, base_version }, 'PUT'),
    () => repaint(n => n + 1),
  ))
  const value = locked && published?.external_sheet ? published : saver.value
  const readOnly = locked || value.status === 'published'
  useUnsavedChanges(!readOnly && saver.dirty)
  async function flush() {
    if (!saver.value.draft_version && !saver.dirty) saver.edit(saver.value)
    return saver.flush()
  }
  async function save(publish: boolean) {
    setBusy(true)
    try {
      const draft = await flush()
      if (publish) {
        const result = await send<Template>(`/templates/${draft.id}/publish`, { replace_id: published?.id ?? null })
        saver.load(result)
        await onPublished(result)
        announceChanges(['groups', 'templates', 'projects'])
      }
      message.success(publish ? '兼容题卡已发布' : '兼容草稿已保存')
    } catch (error) { message.error((error as Error).message) }
    finally { setBusy(false) }
  }
  function downloadCard() {
    void download(`/templates/${value.id}/pdf`, `${value.name}.pdf`).catch(error => message.error(error.message))
  }
  return <Space direction="vertical" size={12} style={{ width: '100%' }}>
    <Card size="small"><Space wrap>
      {readOnly ? <Tag color="green">第 {value.revision} 版</Tag> : <>
        <Select aria-label="原稿类型" value={value.external_sheet?.mode}
          disabled={busy || saver.saving || !!value.questions.length || !!Object.keys(value.background_assets || {}).length ||
            !!Object.keys(value.external_sheet?.pages || {}).length}
          options={[{ label: '空白原稿', value: 'blank' }, { label: '已填样张', value: 'completed' }]}
          onChange={mode => saver.edit({ ...value, external_sheet: { ...value.external_sheet!, mode } })} />
        <Button disabled={busy} onClick={() => save(false)}>保存草稿</Button>
        <Popconfirm title="发布兼容题卡？" description="逐面试扫后发布，用于后续扫描统计。" onConfirm={() => save(true)}>
          <Button type="primary" disabled={busy || !value.questions.length}>发布题卡</Button>
        </Popconfirm>
      </>}
      {readOnly && value.external_sheet?.mode === 'blank' && <Button icon={<DownloadOutlined />} onClick={downloadCard}>下载空白题卡</Button>}
      {readOnly && !locked && <Button onClick={() => saver.load(newExternal(groupId, name, 'blank'))}>新建兼容草稿</Button>}
    </Space></Card>
    <CompatibleTemplateEditor key={value.id} value={value} disabled={busy} readOnly={readOnly} flush={flush}
      change={patch => saver.edit({ ...saver.value, ...patch })} settings={() => {}} />
  </Space>
}

export function StatisticsOverviewPanel({
  project,
  subjectId,
  gradeId,
  onOpenCard,
  onReload,
}: {
  project: Row
  subjectId?: string
  gradeId?: string
  onOpenCard?: (card: OverviewCard) => void
  onReload: () => Promise<unknown>
}) {
  const params = new URLSearchParams()
  if (subjectId) params.set('subject_id', subjectId)
  if (gradeId) params.set('grade_id', gradeId)
  const qs = params.toString()
  const overview = useResource<OverviewData>(`/projects/${project.id}/statistics/overview${qs ? '?' + qs : ''}`, {
    project_id: project.id,
    project_name: project.name,
    card_count: 0,
    published_count: 0,
    closed_count: 0,
    total_received: 0,
    cards: [],
  })
  const [selectedGroupId, setSelectedGroupId] = useState<string>()
  const publishedCards = overview.data.cards.filter(c => !!c.template_id)
  const activeCard = publishedCards.find(c => c.group_id === selectedGroupId) || publishedCards[0]

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <ErrorNotice error={overview.error} retry={overview.reload} />
      <Card
        title="统计总览"
        extra={<Button loading={overview.loading} onClick={() => void overview.reload()}>刷新</Button>}
      >
        <Space wrap size={32} style={{ marginBottom: 16 }}>
          <Statistic title="统计题卡" value={overview.data.card_count} suffix="份" />
          <Statistic title="已发布版式" value={overview.data.published_count} suffix="份" />
          <Statistic title="已结束收集" value={overview.data.closed_count} suffix="份" />
          <Statistic title="累计确认入库" value={overview.data.total_received} suffix="份" />
        </Space>
        {!overview.data.cards.length ? (
          <Empty description="当前范围内还没有统计题卡" />
        ) : (
          <Table<OverviewCard>
            rowKey="group_id"
            size="small"
            loading={overview.loading}
            dataSource={overview.data.cards}
            pagination={false}
            columnChooser={false}
            exportable={false}
            rowClassName={row => (activeCard?.group_id === row.group_id ? 'selected-question-row' : '')}
            onRow={row => ({ onClick: () => { if (row.template_id) setSelectedGroupId(row.group_id) } })}
            columns={[
              { title: '科目 / 分类', dataIndex: 'subject_name', width: 120 },
              { title: '年级', dataIndex: 'grade_name', width: 110 },
              {
                title: '题卡名称',
                dataIndex: 'group_name',
                render: (text: string, row: OverviewCard) => (
                  <Space size={6}>
                    <span>{text === 'Default' ? `${row.subject_name}题卡` : text}</span>
                    <Tag color={row.uses_candidate ? 'blue' : 'default'}>{row.uses_candidate ? '实名考号' : '匿名统计'}</Tag>
                  </Space>
                ),
              },
              { title: '题数', dataIndex: 'question_count', width: 76, render: (n: number, row: OverviewCard) => (row.template_id ? `${n} 题` : '—') },
              {
                title: '确认入库',
                width: 120,
                render: (_: unknown, row: OverviewCard) =>
                  row.expected != null ? `${row.received} / ${row.expected}` : `${row.received} 份`,
              },
              {
                title: '异常',
                dataIndex: 'open_exceptions',
                width: 80,
                render: (n: number) => (n > 0 ? <Tag color="orange">{n} 项</Tag> : '0'),
              },
              {
                title: '状态',
                width: 110,
                render: (_: unknown, row: OverviewCard) =>
                  !row.template_id ? <Tag>待发布版式</Tag> : row.closed ? <Tag color="green">收集已结束</Tag> : <Tag color="processing">收集中</Tag>,
              },
              {
                title: '操作',
                width: 150,
                render: (_: unknown, row: OverviewCard) => (
                  <Space size={4} onClick={e => e.stopPropagation()}>
                    {row.template_id && (
                      <Button type="link" size="small" onClick={() => setSelectedGroupId(row.group_id)}>
                        查看统计
                      </Button>
                    )}
                    {onOpenCard && (
                      <Button type="link" size="small" onClick={() => onOpenCard(row)}>
                        工作台
                      </Button>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>
      {activeCard ? (
        <StatisticsResults
          key={activeCard.group_id}
          endpoint={`/projects/${project.id}/statistics`}
          groupId={activeCard.group_id}
          name={`${activeCard.subject_name} · ${activeCard.group_name === 'Default' ? '默认题卡' : activeCard.group_name}`}
          closed={activeCard.closed}
          canChange={!project.scans_purged}
          onCollectionChange={async () => {
            await overview.reload()
            await onReload()
          }}
        />
      ) : (
        <Card><Empty description="发布统计题卡后即可在此查看汇总、分班对比与作答明细" /></Card>
      )}
    </Space>
  )
}

export function StatisticsResults({ endpoint, groupId, name, closed, canChange, onCollectionChange }: {
  endpoint: string; groupId?: string; name: string; closed: boolean; canChange: boolean; onCollectionChange: () => Promise<unknown>
}) {
  const [view, setView] = useState<'summary' | 'classes' | 'records'>('summary')
  const [selectedQuestion, setSelectedQuestion] = useState<number>()
  const [classIds, setClassIds] = useState<string[]>([])
  const [classTags, setClassTags] = useState<string[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [q, setQ] = useState('')
  const [filterQuestion, setFilterQuestion] = useState<number>()
  const [filterOption, setFilterOption] = useState<string>()
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()

  const queryString = useMemo(() => {
    const params = new URLSearchParams()
    if (groupId) params.set('group_id', groupId)
    if (classIds.length) params.set('class_ids', classIds.join(','))
    if (classTags.length) params.set('class_tags', classTags.join(','))
    if (q.trim()) params.set('q', q.trim())
    if (filterQuestion && filterOption) {
      params.set('question_number', String(filterQuestion))
      params.set('option', filterOption)
    }
    return params.toString()
  }, [groupId, classIds, classTags, q, filterQuestion, filterOption])

  const data = useResource<Results>(`${endpoint}/results${queryString ? '?' + queryString : ''}`, blankResults)
  const rows = data.data.rows || []
  const usesCandidate = !!data.data.uses_candidate
  const availableClasses = data.data.classes || []
  const availableTags = data.data.class_tags || []
  const byClass = data.data.by_class || []
  const records = data.data.records || []
  const focusedQuestion = rows.find(row => row.number === selectedQuestion) ?? rows[0]
  const total = data.data.total
  const unfilteredTotal = data.data.unfiltered_total ?? total
  const ratio = (count: number, base = total) => (base ? Math.round(count * 1000 / base) / 10 : 0)

  const maxLetters = useMemo(() => {
    const maxCount = rows.reduce((acc, row) => Math.max(acc, Object.keys(row.counts || {}).length), 0)
    return Array.from({ length: Math.min(maxCount, 26) }, (_, i) => String.fromCharCode(65 + i))
  }, [rows])

  const filterChips = useMemo<FilterChip[]>(() => {
    const chips: FilterChip[] = []
    classIds.forEach(id => {
      const cls = availableClasses.find(c => c.id === id)
      chips.push({ key: `cls:${id}`, label: `班级：${cls?.name || id}`, onRemove: () => setClassIds(prev => prev.filter(v => v !== id)) })
    })
    classTags.forEach(tag => {
      chips.push({ key: `tag:${tag}`, label: `标签：${tag}`, onRemove: () => setClassTags(prev => prev.filter(v => v !== tag)) })
    })
    if (q.trim()) {
      chips.push({ key: 'q', label: `搜索：${q.trim()}`, onRemove: () => { setQ(''); setSearchInput('') } })
    }
    if (filterQuestion && filterOption) {
      const optLabel = filterOption === 'blank' ? '空白' : filterOption === 'invalid' ? '无效' : `选项 ${filterOption}`
      chips.push({
        key: 'opt',
        label: `第 ${filterQuestion} 题：${optLabel}`,
        onRemove: () => { setFilterQuestion(undefined); setFilterOption(undefined) },
      })
    }
    return chips
  }, [classIds, availableClasses, classTags, q, filterQuestion, filterOption])

  function resetFilters() {
    setClassIds([])
    setClassTags([])
    setSearchInput('')
    setQ('')
    setFilterQuestion(undefined)
    setFilterOption(undefined)
  }

  function exportTable(exportView: 'summary' | 'records' | 'classes', format: 'xlsx' | 'csv') {
    const params = new URLSearchParams(queryString)
    params.set('view', exportView)
    params.set('format', format)
    const suffix = exportView === 'records' ? '作答明细' : exportView === 'classes' ? '分班统计' : '选项统计'
    void download(`${endpoint}/export?${params.toString()}`, `${name} ${suffix}.${format}`).catch(error => message.error(error.message))
  }

  async function changeCollection() {
    setBusy(true)
    try {
      const scope = groupId ? '?group_id=' + encodeURIComponent(groupId) : ''
      const result = await send<{ closed: boolean }>(endpoint + '/collection' + scope, { closed: !closed }, 'PUT')
      await onCollectionChange()
      announceChanges(['groups', 'projects'])
      message.success(result.closed ? '已结束收集' : '已恢复收集')
    } catch (error) { message.error((error as Error).message) }
    finally { setBusy(false) }
  }

  const filterOptionChoices = useMemo(() => {
    const target = rows.find(r => r.number === filterQuestion)
    if (!target) return []
    return [
      ...Object.keys(target.counts).map(letter => ({ value: letter, label: `选 ${letter}` })),
      { value: 'blank', label: '空白' },
      { value: 'invalid', label: '无效' },
    ]
  }, [rows, filterQuestion])

  const summaryTableColumns = useMemo(() => [
    {
      title: '题号',
      dataIndex: 'number',
      width: 74,
      fixed: 'left' as const,
      render: (n: number) => `第 ${n} 题`,
    },
    {
      title: '题目说明',
      dataIndex: 'title',
      width: 170,
      ellipsis: true,
      render: (text: string) => text || '—',
    },
    {
      title: '题型',
      dataIndex: 'type',
      width: 76,
      render: (t: Question['type']) => <Tag color={t === 'multiple' ? 'blue' : 'default'}>{t === 'multiple' ? '多选' : '单选'}</Tag>,
    },
    {
      title: '有效 / 空白 / 无效',
      width: 146,
      render: (_: unknown, row: ResultRow) => {
        const valid = row.valid ?? Math.max(0, total - row.blank - row.invalid)
        return <span className="numeric-cell">{valid} / {row.blank} / {row.invalid}</span>
      },
    },
    ...maxLetters.map(letter => ({
      title: letter,
      key: `opt_${letter}`,
      width: 106,
      render: (_: unknown, row: ResultRow) => {
        if (!(letter in row.counts)) return '—'
        const cnt = row.counts[letter]
        return <span className="numeric-cell">{cnt} ({ratio(cnt)}%)</span>
      },
    })),
  ], [maxLetters, total])

  const focusedClassLetters = focusedQuestion ? Object.keys(focusedQuestion.counts) : []

  const recordColumns = useMemo(() => [
    { title: '序号', dataIndex: 'index', width: 68, fixed: 'left' as const },
    ...(usesCandidate ? [
      { title: '准考证号', dataIndex: 'candidate_number', width: 120, fixed: 'left' as const },
      { title: '姓名', dataIndex: 'student_name', width: 96, fixed: 'left' as const, render: (v: string) => v || '—' },
      { title: '年级', dataIndex: 'grade_name', width: 96, render: (v: string) => v || '—' },
      { title: '班级', dataIndex: 'class_name', width: 110, render: (v: string) => v || '—' },
      { title: '标签', dataIndex: 'tags', width: 140, render: (tags: string[]) => <ClassTags tags={tags} /> },
    ] : []),
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      render: (status: string) => (
        <Tag color={status === '完整有效' ? 'green' : status === '含无效' ? 'error' : 'warning'}>{status}</Tag>
      ),
    },
    ...rows.map(row => ({
      title: `第 ${row.number} 题`,
      key: `q_${row.number}`,
      width: 86,
      render: (_: unknown, rec: ResponseRecord) => {
        const val = rec.answers[String(row.number)]
        if (!val) return <Typography.Text type="secondary">空</Typography.Text>
        if (val.startsWith('无效')) return <Tag color="error">{val}</Tag>
        return <span className="numeric-cell">{val}</span>
      },
    })),
  ], [usesCandidate, rows])

  const exportMenuItems = [
    { key: 'summary-xlsx', label: '选项汇总表（Excel）', onClick: () => exportTable('summary', 'xlsx') },
    { key: 'summary-csv', label: '选项汇总表（CSV）', onClick: () => exportTable('summary', 'csv') },
    { key: 'records-xlsx', label: '作答明细表（Excel）', onClick: () => exportTable('records', 'xlsx') },
    { key: 'records-csv', label: '作答明细表（CSV）', onClick: () => exportTable('records', 'csv') },
    ...(usesCandidate ? [
      { key: 'classes-xlsx', label: '分班统计对比表（Excel）', onClick: () => exportTable('classes', 'xlsx') },
      { key: 'classes-csv', label: '分班统计对比表（CSV）', onClick: () => exportTable('classes', 'csv') },
    ] : []),
  ]

  return (
    <Card
      title={`统计结果 · ${name}`}
      extra={
        <Space wrap>
          <Tag color={usesCandidate ? 'blue' : 'default'}>{usesCandidate ? '实名考号' : '匿名统计'}</Tag>
          {closed ? <Tag color="green">收集已结束</Tag> : <Tag color="processing">收集中</Tag>}
          {canChange && (closed || unfilteredTotal > 0) && (
            <Popconfirm title={closed ? '恢复接收统计答卷？' : '结束收集并锁定结果？'} onConfirm={changeCollection}>
              <Button loading={busy}>{closed ? '恢复收集' : '结束收集'}</Button>
            </Popconfirm>
          )}
          <Button loading={data.loading} onClick={() => void data.reload()}>刷新</Button>
          <Dropdown menu={{ items: exportMenuItems }} disabled={!rows.length}>
            <Button type="primary" icon={<DownloadOutlined />} disabled={!rows.length}>导出结果</Button>
          </Dropdown>
        </Space>
      }
    >
      <ErrorNotice error={data.error} retry={data.reload} />
      {!rows.length ? (
        <Empty description="发布题卡后可查看汇总统计、分班对比与作答明细" />
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Space wrap size={12} align="center">
            {usesCandidate && availableClasses.length > 0 && (
              <MultipleRecordSelect
                title="筛选班级"
                records={availableClasses}
                value={classIds}
                onChange={setClassIds}
              />
            )}
            {usesCandidate && availableTags.length > 0 && (
              <MultiTagPicker
                compact
                aria-label="按班级标签筛选"
                options={availableTags.map(tag => ({ label: tag, value: tag }))}
                value={classTags}
                onChange={setClassTags}
              />
            )}
            {usesCandidate && (
              <Input.Search
                allowClear
                placeholder="搜索姓名、准考证号或班级"
                value={searchInput}
                onChange={e => { setSearchInput(e.target.value); if (!e.target.value) setQ('') }}
                onSearch={val => setQ(val)}
                style={{ width: 220 }}
              />
            )}
            <Select
              allowClear
              placeholder="按题筛选选项"
              value={filterQuestion}
              onChange={num => { setFilterQuestion(num); setFilterOption(undefined) }}
              style={{ width: 150 }}
              options={rows.map(r => ({ value: r.number, label: `第 ${r.number} 题` }))}
            />
            {filterQuestion && (
              <Select
                allowClear
                placeholder="选择选项"
                value={filterOption}
                onChange={setFilterOption}
                style={{ width: 120 }}
                options={filterOptionChoices}
              />
            )}
          </Space>

          <FilterSummaryBar chips={filterChips} onReset={resetFilters} />

          <Space wrap size={32}>
            <Statistic
              title={filterChips.length ? '当前筛选份数' : '确认入库'}
              value={total}
              suffix={filterChips.length && unfilteredTotal !== total ? `/ ${unfilteredTotal} 份` : '份'}
            />
            <Statistic title="统计题数" value={rows.length} suffix="题" />
            {usesCandidate && <Statistic title="涉及班级" value={byClass.length} suffix="个" />}
          </Space>

          <Tabs
            activeKey={view === 'classes' && !usesCandidate ? 'summary' : view}
            onChange={key => setView(key as 'summary' | 'classes' | 'records')}
            items={[
              {
                key: 'summary',
                label: '选项汇总',
                children: (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    <Table<ResultRow>
                      rowKey="number"
                      size="small"
                      loading={data.loading}
                      dataSource={rows}
                      columns={summaryTableColumns}
                      scroll={{ x: 'max-content' }}
                      pagination={rows.length > 50 ? { defaultPageSize: 50, size: 'small' } : false}
                      columnChooser={false}
                      exportable={false}
                      rowClassName={row => (focusedQuestion?.number === row.number ? 'selected-question-row' : '')}
                      onRow={row => ({ onClick: () => setSelectedQuestion(row.number) })}
                    />
                    {focusedQuestion && (
                      <Card
                        size="small"
                        title={`单题分布详情 · 第 ${focusedQuestion.number} 题${focusedQuestion.title ? `（${focusedQuestion.title}）` : ''}`}
                        extra={
                          <Space wrap>
                            <Tag color={focusedQuestion.type === 'multiple' ? 'blue' : 'default'}>
                              {focusedQuestion.type === 'multiple' ? '多选' : '单选'}
                            </Tag>
                            <Tag>有效 {focusedQuestion.valid ?? Math.max(0, total - focusedQuestion.blank - focusedQuestion.invalid)}</Tag>
                            <Tag color={focusedQuestion.blank ? 'warning' : 'default'}>空白 {focusedQuestion.blank}</Tag>
                            <Tag color={focusedQuestion.invalid ? 'error' : 'default'}>无效 {focusedQuestion.invalid}</Tag>
                            <Select
                              size="small"
                              aria-label="切换题目分布"
                              value={focusedQuestion.number}
                              onChange={setSelectedQuestion}
                              style={{ minWidth: 160 }}
                              options={rows.map(r => ({ value: r.number, label: `第 ${r.number} 题 ${r.title}`.trim() }))}
                            />
                          </Space>
                        }
                      >
                        <Typography.Paragraph type="secondary" style={{ marginBottom: 10 }}>
                          占比按当前确认入库份数（{total} 份）计算。{focusedQuestion.type === 'single' ? '单选多填计入无效。' : '多选时每个已选选项分别计数。'}点击「查明细」可反查选该项的答卷。
                        </Typography.Paragraph>
                        <Table
                          rowKey="option"
                          size="small"
                          loading={data.loading}
                          pagination={false}
                          columnChooser={false}
                          exportable={false}
                          dataSource={Object.entries(focusedQuestion.counts).map(([option, count]) => ({ option, count }))}
                          columns={[
                            { title: '选项', dataIndex: 'option', width: 80 },
                            { title: '选择份数', dataIndex: 'count', width: 100 },
                            { title: '占比分布', render: (_, row) => <Progress percent={ratio(row.count)} /> },
                            {
                              title: '操作',
                              width: 96,
                              render: (_, row) => (
                                <Button
                                  type="link"
                                  size="small"
                                  disabled={!row.count}
                                  onClick={() => {
                                    setFilterQuestion(focusedQuestion.number)
                                    setFilterOption(row.option)
                                    setView('records')
                                  }}
                                >
                                  查明细
                                </Button>
                              ),
                            },
                          ]}
                        />
                      </Card>
                    )}
                  </Space>
                ),
              },
              ...(usesCandidate ? [{
                key: 'classes',
                label: `分班对比 (${byClass.length})`,
                children: !byClass.length ? (
                  <Empty description="当前筛选条件下暂无分班统计数据" />
                ) : (
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Space wrap>
                      <Typography.Text>对比题目：</Typography.Text>
                      <Select
                        aria-label="分班对比题目"
                        value={focusedQuestion?.number}
                        onChange={setSelectedQuestion}
                        style={{ minWidth: 220 }}
                        options={rows.map(r => ({ value: r.number, label: `第 ${r.number} 题 ${r.title}`.trim() }))}
                      />
                    </Space>
                    <Table<ClassBreakdown>
                      rowKey={row => row.class_id || row.class_name}
                      size="small"
                      loading={data.loading}
                      dataSource={byClass}
                      scroll={{ x: 'max-content' }}
                      pagination={false}
                      columnChooser={false}
                      exportable={false}
                      columns={[
                        { title: '年级', dataIndex: 'grade_name', width: 96, fixed: 'left' as const, render: (v: string) => v || '—' },
                        {
                          title: '班级',
                          dataIndex: 'class_name',
                          width: 120,
                          fixed: 'left' as const,
                          render: (nameText: string, row: ClassBreakdown) => (
                            row.class_id ? (
                              <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => setClassIds([row.class_id])}>
                                {nameText}
                              </Button>
                            ) : nameText
                          ),
                        },
                        { title: '标签', dataIndex: 'tags', width: 140, render: (tags: string[]) => <ClassTags tags={tags} /> },
                        { title: '入库份数', dataIndex: 'total', width: 90 },
                        {
                          title: '空白 / 无效',
                          width: 100,
                          render: (_: unknown, row: ClassBreakdown) => {
                            const qr = row.rows.find(item => item.number === focusedQuestion?.number)
                            return qr ? `${qr.blank} / ${qr.invalid}` : '—'
                          },
                        },
                        ...focusedClassLetters.map(letter => ({
                          title: letter,
                          key: `cls_opt_${letter}`,
                          width: 106,
                          render: (_: unknown, row: ClassBreakdown) => {
                            const qr = row.rows.find(item => item.number === focusedQuestion?.number)
                            if (!qr || !(letter in qr.counts)) return '—'
                            const cnt = qr.counts[letter]
                            return <span className="numeric-cell">{cnt} ({ratio(cnt, row.total)}%)</span>
                          },
                        })),
                      ]}
                    />
                  </Space>
                ),
              }] : []),
              {
                key: 'records',
                label: `作答明细 (${records.length})`,
                children: !records.length ? (
                  <Empty description="当前筛选条件下暂无已确认答卷" />
                ) : (
                  <Table<ResponseRecord>
                    rowKey="id"
                    size="small"
                    loading={data.loading}
                    dataSource={records}
                    columns={recordColumns}
                    scroll={{ x: 'max-content' }}
                    columnChooser={false}
                    exportable={false}
                  />
                ),
              },
            ]}
          />
        </Space>
      )}
    </Card>
  )
}
