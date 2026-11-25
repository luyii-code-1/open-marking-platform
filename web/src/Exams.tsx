import { useEffect, useState } from 'react'
import { ArrowLeftOutlined, PlusOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, App, Breadcrumb, Card, Collapse, Empty, Form, Input, Modal, Popconfirm, Radio, Segmented, Select, Space, Spin, Tabs, Tag, Tooltip, Typography } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { CatalogPicker } from './Electives'
import { EntityTable, ErrorNotice } from './EntityTable'
import { ExamCatalog } from './ExamCatalog'
import { gradeColor } from './SchoolTags'
import { SUBJECT_PRESETS, TagPicker } from './TagPicker'
import {
  CardGrade,
  ExamStatusMenu,
  ExamStatusTag,
  GroupWorkspace,
  StatisticsResults,
  Rename,
  ScopedWorkspace,
  SubjectGrades,
} from './ExamWorkspaces'
import { CardConversionFields } from './ConversionWorkspace'
import { HierarchyDelete } from './HierarchyDelete'
import { useReviewWorkspace } from './ReviewWorkspace'
import { WorkspaceNotificationButton } from './WorkspaceNotifications'
import { jobDetailText, jobKindLabel, jobStatusColor, jobStatusLabel } from './jobDisplay'
import { send, templateCreationOptions, useResource, type Row } from './api'
import {
  cardName,
  examPath,
  groupSections,
  rememberExamContext,
  resolveExam,
  subjectGrades,
  unassignedGrade,
  type ExamLocation,
} from './examNavigation'
import { loadPage } from './loadPage'
import type { ProjectFilter } from './reviewProjects'
import { rowNavigation } from './rowNavigation'
import './cardFlow.css'

const ArchiveManager = loadPage(() => import('./ArchiveManager').then(module => ({ default: module.ArchiveManager })))
const Conversions = loadPage(() => import('./Conversions').then(module => ({ default: module.Conversions })))
const ProjectStorage = loadPage(() => import('./StorageConnections').then(module => ({ default: module.ProjectStorage })))
const Results = loadPage(() => import('./Results').then(module => ({ default: module.Results })))
const SheetLookup = loadPage(() => import('./SheetLookup').then(module => ({ default: module.SheetLookup })))
const TemplateEditor = loadPage(() => import('./TemplateEditor').then(module => ({ default: module.TemplateEditor })))
const StatisticsWorkspace = loadPage(() => import('./StatisticsWorkspace').then(module => ({ default: module.StatisticsWorkspace })))

const { Title, Text } = Typography

function ProjectCollapsibleTree({
  project,
  subjects,
  groups,
  grades,
  go,
  refresh,
}: {
  project: Row
  subjects: Row[]
  groups: Row[]
  grades: Row[]
  go: (value: ExamLocation) => void
  refresh: () => Promise<void>
}) {
  const { message } = App.useApp()
  const statistics = project.category === 'statistics'
  const projectSubjects = subjects.filter(s => s.project_id === project.id)
  const storageKey = `omp-exam-tree-open:${project.id}`
  const [keyword, setKeyword] = useState('')
  const [openSubjects, setOpenSubjects] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
      if (Array.isArray(saved)) return saved.filter((id: unknown) => typeof id === 'string')
    } catch {}
    return projectSubjects.length <= 4 ? projectSubjects.map(s => s.id) : projectSubjects.slice(0, 1).map(s => s.id)
  })
  const [closedGrades, setClosedGrades] = useState<Record<string, boolean>>({})
  const [createSubjectOpen, setCreateSubjectOpen] = useState(false)
  const [createCardTarget, setCreateCardTarget] = useState<{ subject: Row; gradeId?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [subjectForm] = Form.useForm()
  const [cardForm] = Form.useForm()
  const subjectTags = useResource<Row[]>('/subject-tags', [])
  const subjectPresets = [...new Set([...subjectTags.data.map(t => String(t.name)), ...SUBJECT_PRESETS].filter(Boolean))]
  const availableGrades = grades.filter(g => !g.archived)

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(openSubjects))
    } catch {}
  }, [storageKey, openSubjects])

  const q = keyword.trim().toLowerCase()
  const visibleSubjects = projectSubjects
    .map(subject => {
      const subjectMatch = !q || String(subject.name || '').toLowerCase().includes(q)
      const gradeRows = subjectGrades(subject, groups, grades)
      const filteredGrades = gradeRows
        .map(grade => {
          const cards = groups.filter(g => g.subject_id === subject.id && (g.grade_id || unassignedGrade) === grade.id)
          const gradeMatch = subjectMatch || String(grade.name || '').toLowerCase().includes(q)
          const matchedCards = gradeMatch
            ? cards
            : cards.filter(c => cardName(c, subject).toLowerCase().includes(q))
          return { grade, cards: matchedCards, keep: gradeMatch || matchedCards.length > 0 }
        })
        .filter(item => item.keep)
      const totalCards = groups.filter(g => g.subject_id === subject.id).length
      return {
        subject,
        gradeRows: filteredGrades,
        gradeCount: gradeRows.length,
        totalCards,
        keep: subjectMatch || filteredGrades.length > 0,
      }
    })
    .filter(item => item.keep)

  const allSubjectIds = visibleSubjects.map(item => item.subject.id)
  const effectiveOpenSubjects = q ? allSubjectIds : openSubjects
  const allExpanded = allSubjectIds.length > 0 && allSubjectIds.every(id => effectiveOpenSubjects.includes(id))

  async function createSubject(values: { name: string }) {
    if (busy) return
    setBusy(true)
    try {
      const created = (await send('/subjects', { project_id: project.id, name: values.name.trim() })) as Row
      await refresh()
      setCreateSubjectOpen(false)
      subjectForm.resetFields()
      if (created?.id) setOpenSubjects(prev => (prev.includes(created.id) ? prev : [...prev, created.id]))
      message.success('科目已创建')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function createCard(values: Record<string, unknown>) {
    if (!createCardTarget || busy) return
    setBusy(true)
    try {
      const created = (await send('/groups', { subject_id: createCardTarget.subject.id, ...values })) as Row
      await refresh()
      setOpenSubjects(prev => (prev.includes(createCardTarget.subject.id) ? prev : [...prev, createCardTarget.subject.id]))
      setCreateCardTarget(null)
      cardForm.resetFields()
      message.success('题卡已创建')
      if (created?.id) {
        go({
          projectId: project.id,
          subjectId: createCardTarget.subject.id,
          gradeId: created.grade_id || unassignedGrade,
          groupId: created.id,
        })
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeSubjectGrade(subjectId: string, gradeId: string) {
    try {
      await send(`/subjects/${subjectId}/grades/${gradeId}`, undefined, 'DELETE')
      await refresh()
      message.success('已移除该科目的年级关联')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  function openCreateCard(subject: Row, gradeId?: string) {
    setCreateCardTarget({ subject, gradeId })
    cardForm.resetFields()
    cardForm.setFieldsValue({
      grade_id: gradeId && gradeId !== unassignedGrade ? gradeId : availableGrades[0]?.id,
      template_creation: 'native',
    })
  }

  return (
    <div>
      <div className="exam-tree-toolbar">
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索科目、年级或题卡"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            style={{ width: 260 }}
          />
          {allSubjectIds.length > 0 && !q && (
            <Button onClick={() => setOpenSubjects(allExpanded ? [] : allSubjectIds)}>
              {allExpanded ? '全部收起' : '全部展开'}
            </Button>
          )}
        </Space>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateSubjectOpen(true)}>
            新建科目
          </Button>
        </Space>
      </div>

      {!visibleSubjects.length ? (
        <Card>
          <Empty description={q ? '没有匹配的科目或题卡' : '当前考试项目还没有科目'}>
            {!q && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateSubjectOpen(true)}>
                新建科目
              </Button>
            )}
          </Empty>
        </Card>
      ) : (
        <Collapse
          className="exam-tree-collapse"
          bordered={false}
          activeKey={effectiveOpenSubjects}
          onChange={keys => {
            if (!q) setOpenSubjects(Array.isArray(keys) ? keys.map(String) : [String(keys)])
          }}
          items={visibleSubjects.map(({ subject, gradeRows, gradeCount, totalCards }) => ({
            key: subject.id,
            label: (
              <div className="exam-tree-subject-title">
                <span>{subject.name}</span>
                <span className="exam-tree-subject-meta">
                  {gradeCount} 个年级 · {totalCards} 份题卡
                </span>
              </div>
            ),
            extra: (
              <Space size={4} onClick={e => e.stopPropagation()}>
                <Button
                  type="link"
                  size="small"
                  icon={<PlusOutlined />}
                  disabled={!availableGrades.length}
                  onClick={() => openCreateCard(subject)}
                >
                  新建题卡
                </Button>
                <Rename kind="subjects" row={subject} refresh={refresh} />
                <HierarchyDelete kind="subjects" target={subject} onDeleted={refresh} />
              </Space>
            ),
            children: !gradeRows.length ? (
              <div className="exam-tree-empty-hint">
                <span>该科目下暂无题卡，点击右侧「新建题卡」并选择年级即可开始。</span>
                {availableGrades.length > 0 ? (
                  <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreateCard(subject)}>
                    新建题卡
                  </Button>
                ) : (
                  <a href="#/people/grades">先去创建年级</a>
                )}
              </div>
            ) : (
              <div className="exam-tree-grades">
                <Collapse
                  className="exam-tree-grade-collapse"
                  bordered={false}
                  activeKey={gradeRows
                    .map(({ grade }) => `${subject.id}:${grade.id}`)
                    .filter(key => q || !closedGrades[key])}
                  onChange={keys => {
                    if (q) return
                    const openSet = new Set(Array.isArray(keys) ? keys.map(String) : [String(keys)])
                    setClosedGrades(prev => {
                      const next = { ...prev }
                      for (const { grade } of gradeRows) {
                        const k = `${subject.id}:${grade.id}`
                        next[k] = !openSet.has(k)
                      }
                      return next
                    })
                  }}
                  items={gradeRows.map(({ grade, cards }) => {
                    const gradeKey = `${subject.id}:${grade.id}`
                    const isUnassigned = grade.id === unassignedGrade
                    return {
                      key: gradeKey,
                      label: (
                        <div className="exam-tree-grade-title">
                          <span>{grade.name}</span>
                          {isUnassigned && <Tag color="warning">需设置年级</Tag>}
                          <Tag style={{ marginInlineEnd: 0 }}>{cards.length} 份题卡</Tag>
                        </div>
                      ),
                      extra: (
                        <Space size={4} onClick={e => e.stopPropagation()}>
                          {!isUnassigned && (
                            <Button
                              type="link"
                              size="small"
                              icon={<PlusOutlined />}
                              onClick={() => openCreateCard(subject, grade.id)}
                            >
                              新建题卡
                            </Button>
                          )}
                          {!isUnassigned && cards.length === 0 && (
                            <Popconfirm
                              title="移除该科目的年级关联？"
                              description="全局年级、班级和学生资料保留。"
                              onConfirm={() => void removeSubjectGrade(subject.id, grade.id)}
                            >
                              <Button type="link" size="small" danger>
                                移除年级
                              </Button>
                            </Popconfirm>
                          )}
                        </Space>
                      ),
                      children: !cards.length ? (
                        <div className="exam-tree-empty-hint">
                          <span>该年级下暂无题卡</span>
                          {!isUnassigned && (
                            <Button size="small" onClick={() => openCreateCard(subject, grade.id)}>
                              新建题卡
                            </Button>
                          )}
                        </div>
                      ) : (
                        <div className="exam-tree-card-list">
                          {cards.map(row => {
                            const cardLoc: ExamLocation = {
                              projectId: project.id,
                              subjectId: subject.id,
                              gradeId: row.grade_id || unassignedGrade,
                              groupId: row.id,
                            }
                            const rosterText =
                              row.roster_mode === 'selected'
                                ? '指定名单'
                                : row.roster_mode === 'open'
                                  ? '开放扫入'
                                  : row.grade_id
                                    ? '年级全体'
                                    : '开放扫入'
                            return (
                              <div key={row.id} className="exam-tree-card-row">
                                <div className="exam-tree-card-main">
                                  <a
                                    className="exam-tree-card-link"
                                    href={examPath(cardLoc)}
                                    onClick={e => {
                                      e.preventDefault()
                                      go(cardLoc)
                                    }}
                                  >
                                    {cardName(row, subject)}
                                  </a>
                                  <Tag color={row.template_id ? 'success' : 'default'}>
                                    {row.template_id ? '版式已发布' : '版式待设计'}
                                  </Tag>
                                  <Tag>{rosterText}</Tag>
                                  {!statistics && row.conversion_id && row.conversion_mode !== 'none' && <Tag color="blue">已赋分</Tag>}
                                  {!statistics && <Tag color={row.frozen ? 'green' : row.reopened_at && row.published_at ? 'blue' : 'default'}>
                                    {row.frozen ? '成绩已发布' : row.reopened_at && row.published_at ? '复核中' : '成绩未发布'}
                                  </Tag>}
                                </div>
                                <div className="exam-tree-card-actions">
                                  <Button type="link" size="small" onClick={() => go(cardLoc)}>
                                    进入工作台
                                  </Button>
                                  <Button type="link" size="small" onClick={() => go({ ...cardLoc, section: 'template' })}>
                                    题卡设计
                                  </Button>
                                  <Rename kind="groups" row={row} refresh={refresh} />
                                  <CardGrade group={row} grades={grades} onSaved={refresh} />
                                  <HierarchyDelete kind="groups" target={row} onDeleted={refresh} />
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ),
                    }
                  })}
                />
              </div>
            ),
          }))}
        />
      )}

      <Modal
        title="新建科目"
        open={createSubjectOpen}
        onCancel={() => !busy && setCreateSubjectOpen(false)}
        onOk={() => subjectForm.submit()}
        confirmLoading={busy}
      >
        <Form form={subjectForm} layout="vertical" onFinish={createSubject}>
          <Form.Item name="name" label="科目名称" rules={[{ required: true, whitespace: true, message: '请选择或填写科目名称' }]}>
            <TagPicker
              allowCustom
              maxLength={100}
              options={subjectPresets.map(name => ({
                label: name,
                value: name,
                disabled: projectSubjects.some(s => s.name === name),
              }))}
              customPlaceholder="点击上方标签快速填充，或输入自定义科目"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={createCardTarget ? `新建题卡 · ${createCardTarget.subject.name}` : '新建题卡'}
        open={!!createCardTarget}
        onCancel={() => !busy && setCreateCardTarget(null)}
        onOk={() => cardForm.submit()}
        confirmLoading={busy}
      >
        <Form form={cardForm} layout="vertical" onFinish={createCard}>
          <Form.Item name="name" label="题卡名称" rules={[{ required: true, whitespace: true, message: '请填写题卡名称' }]}>
            <Input maxLength={100} placeholder="如：高一数学答题卡" />
          </Form.Item>
          <Form.Item name="grade_id" label="所属年级" rules={[{ required: true, message: '请选择所属年级' }]}>
            <TagPicker
              options={availableGrades.map(g => ({ label: g.name, value: g.id, color: gradeColor(g.name) }))}
              emptyText={<a href="#/people/grades">请先创建年级</a>}
            />
          </Form.Item>
          <Form.Item name="template_creation" label="制卡方式">
            <Select options={templateCreationOptions} />
          </Form.Item>
          {!statistics && <CardConversionFields projectId={project.id} />}
        </Form>
      </Modal>
    </div>
  )
}

function ProjectStatistics({ project, subjects, groups, grades, reload }: {
  project: Row
  subjects: Row[]
  groups: Row[]
  grades: Row[]
  reload: () => Promise<unknown>
}) {
  const [groupId, setGroupId] = useState<string>()
  const cards = groups.filter(g => g.template_id && subjects.some(s => s.id === g.subject_id && s.project_id === project.id))
  const selected = cards.find(g => g.id === groupId) || cards[0]
  if (!selected) return <Card><Empty description="发布题卡后可查看统计结果" /></Card>
  return <Space direction="vertical" size={12} style={{ width: '100%' }}>
    <Select aria-label="选择统计题卡" value={selected.id} onChange={setGroupId} style={{ minWidth: 240 }}
      options={cards.map(g => {
        const subject = subjects.find(s => s.id === g.subject_id)
        const grade = grades.find(row => row.id === g.grade_id)
        return { value: g.id, label: [subject?.name, grade?.name, cardName(g, subject)].filter(Boolean).join(' · ') }
      })} />
    <StatisticsResults key={selected.id} endpoint={'/projects/'+project.id+'/statistics'} groupId={selected.id}
      name={selected.name} closed={!!selected.frozen} canChange={!project.scans_purged} onCollectionChange={reload} />
  </Space>
}

export function Exams({ location, navigate }: { location: ExamLocation; navigate: (path: string, replace?: boolean) => void }) {
  const projects = useResource<Row[]>('/projects', [])
  const subjects = useResource<Row[]>('/subjects', [])
  const groups = useResource<Row[]>('/groups', [])
  const grades = useResource<Row[]>('/grades', [])
  const backgroundJobs = useResource<Row[]>('/jobs', [])
  const [statusFilter, setStatusFilter] = useState<ProjectFilter>('in_progress')
  const [scopedSection, setScopedSection] = useState<string | undefined>(undefined)

  const ready = projects.loaded && subjects.loaded && groups.loaded && grades.loaded
  const { project, subject, group, invalid } = resolveExam(location, projects.data, subjects.data, groups.data)
  const { user } = useReviewWorkspace()
  const recentKey = `omp-recent-exams:${user.id}`
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    setScopedSection(undefined)
  }, [project?.id, subject?.id, location.gradeId, group?.id])

  useEffect(() => {
    if (!ready || invalid) return
    if (project) rememberExamContext({ projectId: project.id, ...(group ? { groupId: group.id } : {}) })
  }, [ready, invalid, project?.id, group?.id])

  useEffect(() => {
    let ids: string[] = []
    try {
      const stored = JSON.parse(localStorage.getItem(recentKey) || '[]')
      if (Array.isArray(stored)) ids = stored.filter((id: unknown) => typeof id === 'string')
    } catch {}
    if (ready && project && !invalid) {
      ids = [project.id, ...ids.filter(id => id !== project.id)].slice(0, 5)
      try {
        localStorage.setItem(recentKey, JSON.stringify(ids))
      } catch {}
    }
    setRecent(ids)
  }, [ready, recentKey, project?.id, invalid])

  const recentProjects = recent.flatMap(id => projects.data.filter(p => p.id === id))
  const filteredProjects = {
    ...projects,
    data: projects.data.filter(p => statusFilter === 'all' || (p.exam_status || 'in_progress') === statusFilter),
  }

  const returnKey = `omp-designer-return:${location.groupId}`
  const go = (value: ExamLocation) => {
    if (value.section === 'template' && location.section !== 'template') {
      sessionStorage.setItem(returnKey, JSON.stringify({ location, scrollY: window.scrollY }))
    }
    navigate(examPath(value))
  }

  useEffect(() => {
    if (!ready || location.section === 'template') return
    try {
      const stored = JSON.parse(sessionStorage.getItem(returnKey) || 'null')
      if (stored && examPath(stored.location) === examPath(location)) {
        requestAnimationFrame(() => window.scrollTo(0, stored.scrollY))
        sessionStorage.removeItem(returnKey)
      }
    } catch {}
  }, [ready, location])

  const gradeId = location.gradeId
  const grade = subject ? subjectGrades(subject, groups.data, grades.data).find(g => g.id === gradeId) : undefined
  const base = { projectId: project?.id, subjectId: subject?.id, gradeId, groupId: group?.id }
  const error = projects.error || subjects.error || groups.error || grades.error
  const refresh = async () => {
    await Promise.all([projects.reload(), subjects.reload(), groups.reload(), grades.reload()])
  }
  const canonical = !!group && (!gradeId || (gradeId === unassignedGrade && !!group.grade_id))

  useEffect(() => {
    if (ready && canonical && project && subject && group) {
      navigate(examPath({ ...location, projectId: project.id, subjectId: subject.id, gradeId: group.grade_id || unassignedGrade }), true)
    }
  }, [ready, canonical, group?.id, group?.grade_id, gradeId])

  if (error && (!ready || (invalid && !canonical))) return <ErrorNotice error={error} retry={refresh} />
  if (!ready || canonical) {
    return (
      <div className="workspace-loading">
        <Spin />
      </div>
    )
  }
  if (invalid) {
    return (
      <Card>
        <Empty description="该考试位置不存在或已不可访问">
          <Button onClick={() => go({})}>返回考试项目</Button>
        </Empty>
      </Card>
    )
  }
  const statistics = project?.category === 'statistics'
  if (statistics && project.statistics_group_id) {
    return <StatisticsWorkspace project={project} back={() => go({})} />
  }

  const back: ExamLocation = group
    ? { projectId: project!.id }
    : grade
      ? { projectId: project!.id, subjectId: subject!.id }
      : subject
        ? { projectId: project!.id }
        : {}

  const crumbs = [
    { title: <a href={examPath()}>考试项目</a> },
    ...(project ? [{ title: <a href={examPath({ projectId: project.id })}>{project.name}</a> }] : []),
    ...(subject ? [{ title: <a href={examPath({ projectId: project!.id, subjectId: subject.id })}>{subject.name}</a> }] : []),
    ...(grade ? [{ title: <a href={examPath({ projectId: project!.id, subjectId: subject!.id, gradeId })}>{grade.name}</a> }] : []),
    ...(group ? [{ title: cardName(group, subject) }] : []),
  ]

  if (group && location.section === 'template') {
    return (
      <div className="template-design-page">
        <header className="template-context">
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => {
              let target: ExamLocation = { ...base, section: 'overview' }
              try {
                const saved = JSON.parse(sessionStorage.getItem(returnKey) || 'null')
                if (saved?.location?.groupId === group.id && saved.location.section !== 'template') target = saved.location
              } catch {}
              go(target)
            }}
          >
            返回工作台
          </Button>
          <Breadcrumb items={[...crumbs, { title: '题卡设计' }]} />
          <Space style={{ marginInlineStart: 'auto' }}>
            {group.frozen && !statistics && !project?.scans_purged && (
              <a href={examPath({ ...base, section: 'results' })} target="_blank" rel="noopener noreferrer">
                在新标签页打开成绩复核
              </a>
            )}
            <WorkspaceNotificationButton compact onlyWhenActive />
          </Space>
        </header>
        <TemplateEditor key={group.id} groupId={group.id} statistics={statistics} />
      </div>
    )
  }

  const children = groups.data.filter(g => g.subject_id === subject?.id && (g.grade_id || unassignedGrade) === gradeId)
  const enterCard = (row: Row) => go({ ...base, groupId: row.id })
  const cardStatusText = (row: Row) => statistics ? (row.frozen ? '收集已结束' : '收集中') : (row.frozen ? '成绩已发布' : row.reopened_at && row.published_at ? '成绩复核中' : '成绩未发布')
  const cardColumns = [
    {
      title: '题卡名称',
      dataIndex: 'name',
      render: (_: string, row: Row) => <a href={examPath({ ...base, groupId: row.id })}>{cardName(row, subject)}</a>,
    },
    { title: '版式', render: (_: unknown, row: Row) => (row.template_id ? '已发布' : '待设计') },
    { title: '应考名单', render: (_: unknown, row: Row) => (row.roster_mode === 'selected' ? '指定名单' : row.roster_mode === 'open' ? '开放扫入' : row.grade_id ? '年级全体' : '开放扫入') },
    ...(!statistics ? [{
      title: '赋分',
      render: (_: unknown, row: Row) =>
        row.conversion_id && row.conversion_mode !== 'none' ? <Tag color="blue">已启用</Tag> : <Tag>不赋分</Tag>,
    },
    {
      title: '成绩',
      render: (_: unknown, row: Row) => (
        <Tag color={row.frozen ? 'green' : row.reopened_at && row.published_at ? 'blue' : 'default'}>
          {row.frozen ? '已发布' : row.reopened_at && row.published_at ? '复核中' : '未发布'}
        </Tag>
      ),
    }] : []),
    {
      title: '操作',
      className: 'row-actions',
      render: (_: unknown, row: Row) => (
        <Space>
          <Rename kind="groups" row={row} refresh={refresh} />
          <CardGrade
            group={row}
            grades={grades.data}
            onSaved={async () => {
              await refresh()
              go({ projectId: project!.id, subjectId: subject!.id })
            }}
          />
          <HierarchyDelete kind="groups" target={row} onDeleted={refresh} />
        </Space>
      ),
    },
  ]

  return (
    <div className="exam-workspace">
      <ErrorNotice error={error} retry={refresh} />
      {project && (
        <header className="workspace-header-bar">
          <Breadcrumb items={crumbs} />
          <div className="workspace-heading">
            <div className="workspace-heading-main">
              <Button
                type="text"
                size="small"
                className="hierarchy-back"
                icon={<ArrowLeftOutlined />}
                aria-label={group ? '返回题卡列表' : grade ? '返回年级列表' : subject ? '返回科目列表' : '返回考试项目'}
                onClick={() => go(back)}
              />
              <Title level={3} className="workspace-heading-title">
                {group ? cardName(group, subject) : grade?.name || subject?.name || project.name}
              </Title>
              {!subject && <ExamStatusTag row={project} />}
              <Text className="workspace-heading-meta">
                {group
                  ? `${subject!.name} · ${grade?.name} · ${cardStatusText(group)}`
                  : grade
                    ? `${children.length} 份题卡`
                    : subject
                      ? `${subjectGrades(subject, groups.data).length} 个年级`
                      : `${subjects.data.filter(s => s.project_id === project.id).length} 门科目`}
              </Text>
            </div>
            <Space size={4}>
              {!subject && <ExamStatusMenu row={project} refresh={refresh} />}
              {!grade || group ? (
                <HierarchyDelete
                  kind={group ? 'groups' : subject ? 'subjects' : 'projects'}
                  target={group || subject || project}
                  onDeleted={async () => {
                    navigate(examPath(back), true)
                    await refresh()
                  }}
                />
              ) : null}
            </Space>
          </div>
        </header>
      )}

      {!project ? (
        <Tabs
          items={[
            {
              key: 'projects',
              label: '考试项目',
              children: (
                <>
                  {recentProjects.length > 0 && (
                    <section className="recent-exams-panel" aria-label="最近项目">
                      <div className="recent-exams-header">
                        <span className="recent-exams-title">最近项目</span>
                        <Button
                          type="text"
                          size="small"
                          onClick={() => {
                            try {
                              localStorage.removeItem(recentKey)
                            } catch {}
                            setRecent([])
                          }}
                        >
                          清除记录
                        </Button>
                      </div>
                      <div className="recent-exams-grid">
                        {recentProjects.map(p => {
                          const projectSubjects = subjects.data.filter(s => s.project_id === p.id)
                          const subjectIds = new Set(projectSubjects.map(s => s.id))
                          const cardCount = groups.data.filter(g => subjectIds.has(g.subject_id)).length
                          return (
                            <button
                              type="button"
                              key={p.id}
                              className="recent-exam-card"
                              onClick={() => go({ projectId: p.id })}
                            >
                              <div className="recent-exam-card-head">
                                <span className="recent-exam-card-name" title={p.name}>
                                  {p.name}
                                </span>
                                <Tag
                                  color={p.exam_status === 'completed' ? 'default' : p.exam_status === 'pending_review' ? 'warning' : 'processing'}
                                  style={{ marginInlineEnd: 0 }}
                                >
                                  {p.exam_status === 'completed' ? '已完成' : p.exam_status === 'pending_review' ? '等待审查' : '进行中'}
                                </Tag>
                              </div>
                              <div className="recent-exam-card-meta">
                                <span className="numeric-cell">
                                  {projectSubjects.length} 门科目 · {cardCount} 份题卡
                                </span>
                                <RightOutlined className="recent-exam-card-arrow" />
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </section>
                  )}
                  <EntityTable
                    path="/projects"
                    title="考试项目"
                    hideTitle
                    extra={
                      <Segmented<ProjectFilter>
                        aria-label="考试状态"
                        value={statusFilter}
                        onChange={setStatusFilter}
                        options={[
                          { value: 'in_progress', label: '进行中' },
                          { value: 'pending_review', label: '等待审查' },
                          { value: 'completed', label: '已完成' },
                          { value: 'all', label: '全部' },
                        ]}
                      />
                    }
                    creationFields={
                      <>
                        <Form.Item name="category" label="项目类别" initialValue="exam">
                          <Radio.Group>
                            <Radio.Button value="exam">考试</Radio.Button>
                            <Radio.Button value="statistics">统计</Radio.Button>
                          </Radio.Group>
                        </Form.Item>
                        <Form.Item name="catalog_ids" label="同时创建科目"><CatalogPicker /></Form.Item>
                      </>
                    }
                    fields={[{ name: 'name', label: '考试名称' }]}
                    resource={filteredProjects}
                    onEnter={row => go({ projectId: row.id })}
                    onCreated={async row => {
                      await refresh()
                      if (row) go({ projectId: row.id })
                    }}
                    columns={[
                      {
                        title: '项目名称',
                        dataIndex: 'name',
                        render: (name: string, row: Row) => <Space><a href={examPath({ projectId: row.id })}>{name}</a>{row.category === 'statistics' && <Tag>统计</Tag>}</Space>,
                      },
                      { title: '科目', render: (_: unknown, row: Row) => `${subjects.data.filter(s => s.project_id === row.id).length} 门` },
                      {
                        title: '后台任务',
                        render: (_: unknown, row: Row) => {
                          const jobs = backgroundJobs.data.filter(
                            j => j.project_id === row.id && ['pending', 'running', 'failed'].includes(j.status),
                          )
                          return jobs.length ? (
                            <Space direction="vertical" size={4}>
                              {jobs.map(j => {
                                const detail = jobDetailText(j)
                                return (
                                  <Tooltip key={j.id} title={detail}>
                                    <Tag color={jobStatusColor(j.status)} style={{ marginInlineEnd: 0 }}>
                                      {jobKindLabel(j.kind)} · {jobStatusLabel(j.status)}
                                    </Tag>
                                  </Tooltip>
                                )
                              })}
                            </Space>
                          ) : (
                            '—'
                          )
                        },
                      },
                      { title: '考试状态', render: (_: unknown, row: Row) => <ExamStatusTag row={row} /> },
                      {
                        title: '操作',
                        className: 'row-actions',
                        render: (_: unknown, row: Row) => (
                          <Space>
                            <Rename kind="projects" row={row} refresh={refresh} />
                            <ExamStatusMenu row={row} refresh={refresh} />
                            <HierarchyDelete kind="projects" target={row} onDeleted={refresh} />
                          </Space>
                        ),
                      },
                    ]}
                  />
                  {projects.data.length > 0 && !filteredProjects.data.length && (
                    <Alert
                      style={{ marginTop: 12 }}
                      type="info"
                      showIcon
                      message="此状态下暂无考试项目"
                      action={
                        <Button size="small" onClick={() => setStatusFilter('all')}>
                          查看全部考试项目
                        </Button>
                      }
                    />
                  )}
                </>
              ),
            },
            { key: 'catalog', label: '题卡索引', children: <ExamCatalog /> },
          ]}
        />
      ) : group ? (
        <GroupWorkspace
          key={group.id}
          group={group}
          project={project}
          section={location.section || 'overview'}
          onSection={section => go({ ...base, section })}
          scanTab={location.scanTab || 'capture'}
          onScanTab={tab => go({ ...base, section: 'scans', scanTab: tab === 'correct' ? 'correct' : undefined })}
          sections={groupSections}
          renderTemplateEditor={id => <TemplateEditor groupId={id} statistics={statistics} />}
        />
      ) : grade ? (
        <ScopedWorkspace project={project} subject={subject!} gradeId={gradeId} section={scopedSection} onSection={setScopedSection}>
          {grade.id === unassignedGrade ? (
            <Card title="待设置年级的题卡">
              <Table
                rowKey="id"
                dataSource={children}
                columns={cardColumns}
                onRow={row => rowNavigation(() => enterCard(row), cardName(row, subject))}
              />
            </Card>
          ) : (
            <EntityTable
              key={subject!.id + grade.id}
              path="/groups"
              title="题卡"
              hideTitle
              resource={groups}
              allowImport={false}
              scope={{ subject_id: subject!.id, grade_id: grade.id }}
              fields={[{ name: 'name', label: '题卡名称' }]}
              creationFields={statistics ? undefined : <CardConversionFields projectId={project.id} />}
              onEnter={enterCard}
              onCreated={async row => {
                await refresh()
                if (row) enterCard(row)
              }}
              columns={cardColumns}
            />
          )}
        </ScopedWorkspace>
      ) : subject ? (
        <ScopedWorkspace project={project} subject={subject} section={scopedSection} onSection={setScopedSection}>
          <SubjectGrades
            subject={subject}
            groups={groups.data}
            grades={grades.data}
            onEnter={id => go({ ...base, gradeId: id })}
            refresh={refresh}
          />
        </ScopedWorkspace>
      ) : (
        <Tabs
          activeKey={statistics && location.section === 'conversions' ? 'subjects' : location.section || 'subjects'}
          onChange={section => go({ projectId: project.id, section })}
          items={[
            {
              key: 'subjects',
              label: '科目与题卡',
              children: (
                <ProjectCollapsibleTree
                  key={project.id}
                  project={project}
                  subjects={subjects.data}
                  groups={groups.data}
                  grades={grades.data}
                  go={go}
                  refresh={refresh}
                />
              ),
            },
            { key: 'sheets', label: '答题卡查询', children: <SheetLookup key={project.id} projectId={project.id} /> },
            ...(statistics ? [{ key: 'summary', label: '统计结果', children: <ProjectStatistics key={project.id} project={project}
              subjects={subjects.data} groups={groups.data} grades={grades.data} reload={refresh} /> }]
              : [{ key: 'summary', label: '成绩总览', children: <Results key={project.id} admin projectId={project.id} /> },
            { key: 'conversions', label: '赋分方案', children: <Conversions projectId={project.id} /> }]),
            { key: 'storage', label: '存储设置', children: <ProjectStorage project={project} onSaved={refresh} /> },
            { key: 'archives', label: '文件管理', children: <ArchiveManager projectId={project.id} /> },
          ]}
        />
      )}
    </div>
  )
}
