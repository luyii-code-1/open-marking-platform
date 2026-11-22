import { useEffect, useState } from 'react'
import { ArrowLeftOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, Breadcrumb, Card, Empty, Form, Segmented, Space, Spin, Tabs, Tag, Tooltip, Typography } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { CatalogPicker } from './Electives'
import { EntityTable, ErrorNotice } from './EntityTable'
import { ExamCatalog } from './ExamCatalog'
import {
  CardGrade,
  ExamStatusMenu,
  ExamStatusTag,
  GroupWorkspace,
  Rename,
  ScopedWorkspace,
  SubjectGrades,
} from './ExamWorkspaces'
import { HierarchyDelete } from './HierarchyDelete'
import { RoomTagManager } from './RoomTags'
import { useReviewWorkspace } from './ReviewWorkspace'
import { WorkspaceNotificationButton } from './WorkspaceNotifications'
import { jobDetailText, jobKindLabel, jobStatusColor, jobStatusLabel } from './jobDisplay'
import { useResource, type Row } from './api'
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
const ConversionWorkspace = loadPage(() => import('./ConversionWorkspace').then(module => ({ default: module.ConversionWorkspace })))
const ProjectStorage = loadPage(() => import('./StorageConnections').then(module => ({ default: module.ProjectStorage })))
const Results = loadPage(() => import('./Results').then(module => ({ default: module.Results })))
const SheetLookup = loadPage(() => import('./SheetLookup').then(module => ({ default: module.SheetLookup })))
const TemplateEditor = loadPage(() => import('./TemplateEditor').then(module => ({ default: module.TemplateEditor })))

const { Title, Text } = Typography

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

  const back: ExamLocation = group
    ? { projectId: project!.id, subjectId: subject!.id, gradeId }
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
            {group.frozen && !project?.scans_purged && (
              <a href={examPath({ ...base, section: 'results' })} target="_blank" rel="noopener noreferrer">
                在新标签页打开成绩复核
              </a>
            )}
            <WorkspaceNotificationButton compact onlyWhenActive />
          </Space>
        </header>
        <TemplateEditor key={group.id} groupId={group.id} />
      </div>
    )
  }

  const children = groups.data.filter(g => g.subject_id === subject?.id && (g.grade_id || unassignedGrade) === gradeId)
  const enterCard = (row: Row) => go({ ...base, groupId: row.id })
  const cardStatusText = (row: Row) => (row.frozen ? '成绩已发布' : row.reopened_at && row.published_at ? '成绩复核中' : '成绩未发布')
  const cardColumns = [
    {
      title: '题卡名称',
      dataIndex: 'name',
      render: (_: string, row: Row) => <a href={examPath({ ...base, groupId: row.id })}>{cardName(row, subject)}</a>,
    },
    { title: '版式', render: (_: unknown, row: Row) => (row.template_id ? '已发布' : '待设计') },
    { title: '应考名单', render: (_: unknown, row: Row) => (row.roster_mode === 'selected' ? '指定名单' : row.grade_id ? '年级全体' : '待设置') },
    {
      title: '成绩',
      render: (_: unknown, row: Row) => (
        <Tag color={row.frozen ? 'green' : row.reopened_at && row.published_at ? 'blue' : 'default'}>
          {row.frozen ? '已发布' : row.reopened_at && row.published_at ? '复核中' : '未发布'}
        </Tag>
      ),
    },
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
                          const completed = p.exam_status === 'completed'
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
                                <Tag color={completed ? 'default' : 'processing'} style={{ marginInlineEnd: 0 }}>
                                  {completed ? '已完成' : '进行中'}
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
                          { value: 'completed', label: '已完成' },
                          { value: 'all', label: '全部' },
                        ]}
                      />
                    }
                    creationFields={
                      <Form.Item name="catalog_ids" label="同时创建科目">
                        <CatalogPicker />
                      </Form.Item>
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
                        title: '考试名称',
                        dataIndex: 'name',
                        render: (name: string, row: Row) => <a href={examPath({ projectId: row.id })}>{name}</a>,
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
          onRooms={() => go({ projectId: project.id, section: 'rooms' })}
          sections={groupSections}
          renderTemplateEditor={id => <TemplateEditor groupId={id} />}
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
          activeKey={location.section || 'subjects'}
          onChange={section => go({ projectId: project.id, section })}
          items={[
            {
              key: 'subjects',
              label: '科目',
              children: (
                <EntityTable
                  key={project.id}
                  path="/subjects"
                  title="科目"
                  hideTitle
                  resource={subjects}
                  scope={{ project_id: project.id }}
                  fields={[{ name: 'name', label: '科目名称' }]}
                  onEnter={row => go({ projectId: project.id, subjectId: row.id })}
                  onCreated={async row => {
                    await refresh()
                    if (row) go({ projectId: project.id, subjectId: row.id })
                  }}
                  columns={[
                    {
                      title: '科目名称',
                      dataIndex: 'name',
                      render: (name: string, row: Row) => <a href={examPath({ projectId: project.id, subjectId: row.id })}>{name}</a>,
                    },
                    { title: '年级', render: (_: unknown, row: Row) => `${subjectGrades(row, groups.data).length} 个` },
                    { title: '题卡', render: (_: unknown, row: Row) => `${groups.data.filter(g => g.subject_id === row.id).length} 份` },
                    {
                      title: '操作',
                      className: 'row-actions',
                      render: (_: unknown, row: Row) => (
                        <Space>
                          <Rename kind="subjects" row={row} refresh={refresh} />
                          <HierarchyDelete kind="subjects" target={row} onDeleted={refresh} />
                        </Space>
                      ),
                    },
                  ]}
                />
              ),
            },
            { key: 'rooms', label: '考场设置', children: <RoomTagManager projectId={project.id} /> },
            { key: 'sheets', label: '答题卡查询', children: <SheetLookup key={project.id} projectId={project.id} /> },
            { key: 'summary', label: '成绩总览', children: <Results key={project.id} admin projectId={project.id} /> },
            { key: 'conversions', label: '赋分方案', children: <ConversionWorkspace projectId={project.id} /> },
            { key: 'storage', label: '存储设置', children: <ProjectStorage project={project} onSaved={refresh} /> },
            { key: 'archives', label: '文件管理', children: <ArchiveManager projectId={project.id} /> },
          ]}
        />
      )}
    </div>
  )
}
