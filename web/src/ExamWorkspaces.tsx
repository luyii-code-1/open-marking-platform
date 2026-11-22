import { useEffect, useState, type ReactNode } from 'react'
import { PlusOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, App, Card, Dropdown, Empty, Form, Input, Modal, Popconfirm, Progress, Select, Space, Tabs, Tag, Tooltip, Typography } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { HierarchyDelete } from './HierarchyDelete'
import { announceChanges, send, useResource, type Row, type Template } from './api'
import { examPath, subjectGrades, unassignedGrade } from './examNavigation'
import { loadPage } from './loadPage'
import { rowNavigation } from './rowNavigation'

const SheetLookup = loadPage(() => import('./SheetLookup').then(module => ({ default: module.SheetLookup })))
const AnswerPool = loadPage(() => import('./AnswerPool').then(module => ({ default: module.AnswerPool })))
const Roster = loadPage(() => import('./Roster').then(module => ({ default: module.Roster })))
const Scans = loadPage(() => import('./Management').then(module => ({ default: module.Scans })))
const ReviewAllocation = loadPage(() => import('./ReviewAllocation').then(module => ({ default: module.ReviewAllocation })))
const Exceptions = loadPage(() => import('./Exceptions').then(module => ({ default: module.Exceptions })))
const ConversionWorkspace = loadPage(() => import('./ConversionWorkspace').then(module => ({ default: module.ConversionWorkspace })))
const Results = loadPage(() => import('./Results').then(module => ({ default: module.Results })))

export function ExamStatusTag({ row }: { row: Row }) {
  const completed = row.exam_status === 'completed'
  const manual = row.exam_status_mode && row.exam_status_mode !== 'auto'
  return (
    <Space size={4}>
      <Tag color={completed ? 'default' : 'processing'}>{completed ? '已完成' : '进行中'}</Tag>
      {manual && <Tag>手动</Tag>}
    </Space>
  )
}

export function ExamStatusMenu({ row, refresh }: { row: Row; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()
  const mode = row.exam_status_mode || 'auto'
  const autoText = row.auto_exam_status === 'completed' ? '已完成' : '进行中'

  async function update(nextMode: 'auto' | 'in_progress' | 'completed') {
    if (busy || nextMode === mode) return
    setBusy(true)
    try {
      await send(`/projects/${row.id}/exam-status`, { mode: nextMode }, 'PUT')
      announceChanges(['projects', 'exam-catalog', 'review-projects'])
      await refresh()
      message.success(nextMode === 'auto' ? '已恢复自动判断考试状态' : nextMode === 'completed' ? '已设为已完成' : '已设为进行中')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dropdown
      menu={{
        selectedKeys: [mode],
        items: [
          { key: 'auto', label: `自动判断（当前自动：${autoText}）`, onClick: () => void update('auto') },
          { key: 'in_progress', label: '手动设为进行中', onClick: () => void update('in_progress') },
          { key: 'completed', label: '手动设为已完成', onClick: () => void update('completed') },
        ],
      }}
    >
      <Button type="link" loading={busy}>
        考试状态
      </Button>
    </Dropdown>
  )
}

export function Rename({ kind, row, refresh }: { kind: string; row: Row; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()

  return (
    <>
      <Button
        type="link"
        onClick={() => {
          setName(row.name)
          setOpen(true)
        }}
      >
        编辑
      </Button>
      <Modal
        title="编辑名称"
        open={open}
        onCancel={() => !busy && setOpen(false)}
        confirmLoading={busy}
        okButtonProps={{ disabled: !name.trim() }}
        onOk={async () => {
          setBusy(true)
          try {
            await send(`/${kind}/${row.id}/name`, { name }, 'PUT')
            setOpen(false)
            await refresh()
          } catch (e) {
            message.error((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Input value={name} onChange={e => setName(e.target.value)} maxLength={100} />
      </Modal>
    </>
  )
}

export function CardGrade({ group, grades, onSaved }: { group: Row; grades: Row[]; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()
  const { message } = App.useApp()

  async function save(body: object) {
    setBusy(true)
    try {
      await send(`/groups/${group.id}/grade`, body, 'PUT')
      setOpen(false)
      await onSaved()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        type="link"
        disabled={group.frozen}
        onClick={() => {
          form.setFieldsValue({ grade_id: group.grade_id })
          setOpen(true)
        }}
      >
        {group.grade_id ? '调整年级' : '设置年级'}
      </Button>
      <Modal
        title={`设置年级 · ${group.name === 'Default' ? '默认题卡' : group.name}`}
        open={open}
        onCancel={() => !busy && setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={busy}
      >
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="grade_id" label="全局年级" rules={[{ required: true, message: '请选择年级' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={grades.filter(g => !g.archived || g.id === group.grade_id).map(g => ({ label: g.name, value: g.id }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

export function SubjectGrades({
  subject,
  groups,
  grades,
  onEnter,
  refresh,
}: {
  subject: Row
  groups: Row[]
  grades: Row[]
  onEnter: (id: string) => void
  refresh: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()
  const { message } = App.useApp()
  const [editing, setEditing] = useState<Row | null>(null)
  const [editForm] = Form.useForm()
  const rows = subjectGrades(subject, groups, grades)
  const available = grades.filter(g => !g.archived)

  async function save(body: object) {
    setBusy(true)
    try {
      const card = (await send('/groups', { subject_id: subject.id, ...body })) as Row
      await refresh()
      setOpen(false)
      form.resetFields()
      onEnter(card.grade_id)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function edit(body: object) {
    if (!editing) return
    setBusy(true)
    try {
      await send(`/grades/${editing.id}`, body, 'PUT')
      await refresh()
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    try {
      await send(`/subjects/${subject.id}/grades/${id}`, undefined, 'DELETE')
      await refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <Card>
      <Table
        rowKey="id"
        dataSource={rows}
        toolbar={
          <Button type="primary" icon={<PlusOutlined />} disabled={!available.length} onClick={() => setOpen(true)}>
            创建题卡
          </Button>
        }
        onRow={row => rowNavigation(() => onEnter(row.id), row.name)}
        columns={[
          {
            title: '年级',
            dataIndex: 'name',
            render: (name: string, row: Row) => (
              <Button type="link" onClick={() => onEnter(row.id)}>
                {name}
              </Button>
            ),
          },
          { title: '题卡', dataIndex: 'count', render: n => `${n} 份` },
          {
            title: '操作',
            className: 'row-actions',
            render: (_: unknown, row: Row) =>
              row.id === unassignedGrade ? (
                <Button type="link" onClick={() => onEnter(row.id)}>
                  设置题卡年级
                </Button>
              ) : (
                <Space>
                  <Button
                    type="link"
                    onClick={() => {
                      editForm.setFieldsValue({ name: row.name })
                      setEditing(row)
                    }}
                  >
                    编辑
                  </Button>
                  <Tooltip title={row.count ? '请先调整该年级下的题卡或删除题卡' : undefined}>
                    <span>
                      <Popconfirm
                        title="移除该科目的年级关联？"
                        description="全局年级、班级和学生资料保留。"
                        disabled={!!row.count}
                        onConfirm={() => remove(row.id)}
                      >
                        <Button type="link" danger disabled={!!row.count}>
                          移除
                        </Button>
                      </Popconfirm>
                    </span>
                  </Tooltip>
                </Space>
              ),
          },
        ]}
        locale={{ emptyText: '创建题卡时选择所属年级' }}
      />
      {!grades.some(g => !g.archived) && (
        <Typography.Text type="secondary">
          <a href="#/people/grades">前往「人员与班级 / 年级」创建年级</a>
        </Typography.Text>
      )}
      <Modal title="编辑年级" open={!!editing} onCancel={() => !busy && setEditing(null)} onOk={() => editForm.submit()} confirmLoading={busy}>
        <Typography.Paragraph type="secondary">
          年级属于全局资料，名称修改会同步显示在所有考试及人员管理中。
        </Typography.Paragraph>
        <Form form={editForm} layout="vertical" onFinish={edit}>
          <Form.Item name="name" label="年级名称" rules={[{ required: true, whitespace: true, message: '请填写年级名称' }]}>
            <Input maxLength={60} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title="创建题卡" open={open} onCancel={() => !busy && setOpen(false)} onOk={() => form.submit()} confirmLoading={busy}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="题卡名称" rules={[{ required: true, whitespace: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="grade_id" label="所属年级" rules={[{ required: true, message: '请选择年级' }]}>
            <Select showSearch optionFilterProp="label" options={available.map(g => ({ label: g.name, value: g.id }))} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

export function ScopedWorkspace({
  project,
  subject,
  gradeId,
  section,
  onSection,
  children,
}: {
  project: Row
  subject: Row
  gradeId?: string
  section?: string
  onSection: (section?: string) => void
  children: ReactNode
}) {
  const activeKey = section === 'results' || section === 'conversions' ? section : 'cards'
  return (
    <Tabs
      activeKey={activeKey}
      onChange={key => onSection(key === 'cards' ? undefined : key)}
      items={[
        { key: 'cards', label: gradeId ? '题卡' : '年级', children },
        { key: 'results', label: '成绩', children: <Results admin projectId={project.id} subjectId={subject.id} gradeId={gradeId} /> },
        {
          key: 'conversions',
          label: '赋分',
          children: <ConversionWorkspace projectId={project.id} subjectId={subject.id} gradeId={gradeId} />,
        },
      ]}
    />
  )
}

function GroupOverview({ group, projectId, onSection }: { group: Row; projectId: string; onSection: (section: string) => void }) {
  const workflow = useResource<Row>(`/groups/${group.id}/workflow`, {} as Row)
  const templates = useResource<Template[]>('/templates', [])
  const roster = useResource<any>(`/groups/${group.id}/roster`, null)
  const template = templates.data.find(t => t.id === group.template_id)
  const drafts = templates.data.filter(t => t.group_id === group.id && t.status === 'draft')
  const jobs = useResource<Row[]>(`/jobs?project_id=${projectId}`, [])
  const [reprocessing, setReprocessing] = useState(false)
  const { message } = App.useApp()

  const recent = jobs.data
    .filter(j => j.kind === 'objective-reprocess' && j.payload?.group_id === group.id)
    .sort((a, b) => b.created_at - a.created_at)[0]
  const active = recent && ['pending', 'running'].includes(recent.status)
  const reprocessFailures: Row[] = recent?.result?.failed_pages || []

  useEffect(() => {
    const timer = setInterval(
      () => {
        if (document.visibilityState === 'visible') {
          void workflow.reload()
          if (active) void jobs.reload()
        }
      },
      active ? 2000 : 15000,
    )
    return () => clearInterval(timer)
  }, [active, workflow.reload, jobs.reload])

  async function reprocess() {
    setReprocessing(true)
    try {
      await send(`/groups/${group.id}/objective/reprocess`)
      await jobs.reload()
      message.success('客观题重新识别已提交，后台会继续处理')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setReprocessing(false)
    }
  }

  const w = workflow.data
  const entries = [
    {
      key: 'template',
      label: '题卡设计',
      detail: template ? `${template.name} · 已发布` : drafts.length ? `${drafts.length} 份草稿待发布` : '创建或从题卡库选用版式',
    },
    {
      key: 'roster',
      label: '应考名单',
      detail: roster.data?.configured ? `${roster.data.students.length} 名学生 · ${roster.data.mode === 'selected' ? '指定名单' : '年级全体'}` : '设置年级或导入名单',
    },
    {
      key: 'scans',
      label: '扫描与补扫',
      detail: workflow.data.group_id
        ? `考场预期 ${workflow.data.room_expected} 人 · 已入库实考 ${workflow.data.scanned} 人 · ${workflow.data.open_batches} 个批次待完成`
        : '按考场查看批次、页面与配对情况',
    },
    {
      key: 'marking',
      label: '阅卷分配',
      detail: workflow.data.results ? `${workflow.data.results.pending} 份答卷待结分` : '管理阅卷池与仲裁池',
    },
    {
      key: 'exceptions',
      label: '异常核查',
      detail: workflow.data.group_id ? `${workflow.data.open_exceptions} 项待核查` : '核查识别与评阅中的待处理事项',
    },
    {
      key: 'results',
      label: '成绩',
      detail: group.frozen ? '成绩已发布 · 成绩复核' : w.in_review ? '成绩复核中 · 重新发布' : '检查统计并确认发布',
    },
  ]
  const percent = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0)

  return (
    <>
      <ErrorNotice
        error={templates.error || roster.error || workflow.error}
        retry={() => {
          void templates.reload()
          void roster.reload()
          void workflow.reload()
        }}
      />
      {w.scan && (
        <Card
          title="题卡流程"
          extra={
            <Space>
              <Tag color={w.published ? 'green' : w.in_review ? 'blue' : undefined}>
                {w.published ? '成绩已发布' : w.in_review ? '成绩复核中' : '成绩未发布'}
              </Tag>
              <Button loading={workflow.loading} onClick={workflow.reload}>
                刷新
              </Button>
            </Space>
          }
        >
          <div className="card-flow-grid">
            <section>
              <h4>
                扫描与入库 <span>份</span>
              </h4>
              <strong>
                {w.scan.received} / {w.scan.expected ?? '待设置'}
              </strong>
              <Progress percent={percent(w.scan.received, w.scan.expected)} size="small" showInfo={false} />
              <Space wrap>
                <span>待扫描 {w.scan.pending}</span>
                <span>异常 {w.scan.exceptions}</span>
                <span>缺考 {w.scan.absent}</span>
              </Space>
              <Button type="link" onClick={() => onSection('scans')}>
                查看扫描批次
              </Button>
            </section>
            <section>
              <h4>
                客观题阅卷 <span>题次</span>
              </h4>
              <strong>
                {w.objective.completed} / {w.objective.total}
              </strong>
              <Progress percent={percent(w.objective.completed, w.objective.total)} size="small" showInfo={false} />
              <Space wrap>
                <span>待处理 {w.objective.pending}</span>
                <span>异常 {w.objective.exceptions}</span>
                <span>未扫描 {w.objective.unscanned}</span>
              </Space>
              <Popconfirm
                title="重新识别当前题卡的客观题？"
                description="从扫描原图重新读取填涂并计分，保留人工更正和主观题评分。"
                onConfirm={reprocess}
                disabled={!!active || reprocessing || !w.objective_reprocess_allowed}
              >
                <Button type="link" loading={reprocessing} disabled={!!active || !w.objective_reprocess_allowed}>
                  重新自动识别
                </Button>
              </Popconfirm>
            </section>
            <section>
              <h4>
                主观题阅卷 <span>题次</span>
              </h4>
              <strong>
                {w.subjective.completed} / {w.subjective.total}
              </strong>
              <Progress percent={percent(w.subjective.completed, w.subjective.total)} size="small" showInfo={false} />
              <Space wrap>
                <span>待评 {w.subjective.pending}</span>
                <span>待仲裁 {w.subjective.arbitration}</span>
                <span>异常 {w.subjective.exceptions}</span>
                <span>未扫描 {w.subjective.unscanned}</span>
              </Space>
              <Button type="link" onClick={() => onSection('marking')}>
                查看教师进度
              </Button>
            </section>
          </div>
          {w.scans_purged && <Alert type="info" showIcon message="扫描文件已清理，成绩与评分记录保留。" style={{ marginTop: 12 }} />}
          {!!w.regrades && (
            <Tag color="orange" style={{ marginTop: 12 }}>
              待重阅 {w.regrades} 项
            </Tag>
          )}
          {recent && (
            <Alert
              style={{ marginTop: 12 }}
              type={recent.status === 'failed' ? 'error' : reprocessFailures.length ? 'warning' : recent.status === 'completed' ? 'success' : 'info'}
              showIcon
              message={`客观题重新识别：${reprocessFailures.length ? `${recent.result.updated_pages} 页已更新，${reprocessFailures.length} 页需核查` : ({ pending: '等待处理', running: '处理中', completed: '已完成', failed: '处理失败' } as Record<string, string>)[recent.status] || recent.status}`}
              description={recent.error_detail || (reprocessFailures.length ? reprocessFailures.slice(0, 3).map(f => f.reason).join('；') : recent.phase)}
              action={
                <Button
                  onClick={() => {
                    void jobs.reload()
                    void workflow.reload()
                  }}
                >
                  刷新状态
                </Button>
              }
            />
          )}
        </Card>
      )}
      <div className="group-work-grid">
        {entries.map(item => (
          <button type="button" className="workspace-entry" key={item.key} onClick={() => onSection(item.key)}>
            <span className="workspace-entry-title">
              {item.label}
              <RightOutlined />
            </span>
            <span className="workspace-entry-detail">{item.detail}</span>
          </button>
        ))}
      </div>
    </>
  )
}

export function GroupWorkspace({
  group,
  project,
  section,
  onSection,
  onRooms,
  scanTab,
  onScanTab,
  sections,
  renderTemplateEditor,
}: {
  group: Row
  project: Row
  section: string
  onSection: (section: string) => void
  onRooms: () => void
  scanTab: string
  onScanTab: (tab: string) => void
  sections: readonly (readonly [string, string])[]
  renderTemplateEditor: (groupId: string) => ReactNode
}) {
  return (
    <>
      {group.frozen && section !== 'results' && (
        <Alert
          type="info"
          showIcon
          message={project.scans_purged ? '扫描文件已清理，可在「成绩」中查询或导出。' : '成绩已发布。如需更正答卷、名单或评分，请先到「成绩」发起复核。'}
          action={
            <Button onClick={() => onSection('results')}>{project.scans_purged ? '查看成绩' : '前往成绩复核'}</Button>
          }
        />
      )}
      <Tabs
        activeKey={section}
        onChange={onSection}
        tabBarExtraContent={<Button onClick={() => onSection('template')}>题卡设计</Button>}
        items={sections
          .filter(([key]) => key !== 'template')
          .map(([key, label]) => ({
            key,
            label,
            children:
              key === 'sheets' ? (
                <SheetLookup key={group.id} projectId={project.id} groupId={group.id} />
              ) : key === 'overview' ? (
                <GroupOverview group={group} projectId={project.id} onSection={onSection} />
              ) : (key === 'scans' || key === 'marking') && !group.template_id ? (
                <Card>
                  <Empty description={key === 'scans' ? '发布题卡后即可建立扫描批次' : '发布题卡后即可分配教师与阅卷'}>
                    <Button type="primary" onClick={() => onSection('template')}>
                      设计题卡
                    </Button>
                  </Empty>
                </Card>
              ) : key === 'template' ? (
                renderTemplateEditor(group.id)
              ) : key === 'roster' ? (
                <Roster groupId={group.id} />
              ) : key === 'scans' ? (
                <Space direction="vertical" size={24} style={{ width: '100%' }}>
                  <div>
                    <Button onClick={onRooms}>考场设置</Button>
                  </div>
                  <Scans groupId={group.id} tab={scanTab} onTab={onScanTab} />
                </Space>
              ) : key === 'marking' ? (
                <Tabs
                  defaultActiveKey="teachers"
                  items={[
                    { key: 'answers', label: '答卷池', children: <AnswerPool groupId={group.id} projectId={project.id} /> },
                    { key: 'teachers', label: '阅卷池', children: <ReviewAllocation templateId={group.template_id} frozen={!!group.frozen} /> },
                  ]}
                />
              ) : key === 'exceptions' ? (
                <Exceptions groupId={group.id} />
              ) : (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <Results admin projectId={project.id} groupId={group.id} />
                  <ConversionWorkspace
                    projectId={project.id}
                    subjectId={group.subject_id}
                    gradeId={group.grade_id}
                    groupId={group.id}
                  />
                </Space>
              ),
          }))}
      />
    </>
  )
}
