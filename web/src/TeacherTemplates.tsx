import { useEffect, useRef, useState } from 'react'
import { Alert, App, Card, Descriptions, Dropdown, Empty, Form, Input, InputNumber, Modal, Popconfirm, Radio, Segmented, Select, Space, Switch, Tabs, Tag, Typography, Upload } from 'antd'
import { ArrowLeftOutlined, BookOutlined, CheckCircleOutlined, CopyOutlined, DownloadOutlined, PaperClipOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { ObjectiveEditor } from './ObjectiveEditor'
import { Paper, type TextTarget } from './PrintPaper'
import { QuestionSettings } from './QuestionSettings'
import { SUBJECT_PRESETS, TagPicker } from './TagPicker'
import { download, newQuestion, request, send, useResource, type Question, type Row, type Template } from './api'
import { examPath } from './examNavigation'
import { mergeQuestions, questionLabel, questionNumbers, splitQuestions } from './mergeQuestions'
import { initialSubjectiveRegion, uniformSubjectiveWidths } from './sheetRegions'
import { subjectiveLayoutKey } from './subjectiveLayout'
import { useUnsavedChanges } from './useNavigation'

const { Text } = Typography

type TeacherTemplateRow = Row & {
  id: string
  owner_id: string
  owner_name: string
  owner_username?: string
  name: string
  subject_name?: string
  description?: string
  status: 'draft' | 'submitted' | 'approved' | 'rejected'
  share_token: string
  internal_link: string
  review_note?: string
  submitted_at?: number | null
  created_at: number
  updated_at: number
  adopted_template_id?: string | null
  adopted_group_id?: string | null
  question_count?: number
  total_points?: number
  definition: Template
}

const statusMeta: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  submitted: { label: '待审核', color: 'processing' },
  approved: { label: '已采用', color: 'green' },
  rejected: { label: '已退回', color: 'error' },
}

const emptyDefinition = (name = '新独立题卡'): Template => ({
  id: crypto.randomUUID(),
  name,
  font_size: 13,
  leading: 20,
  group_id: '',
  paper: 'A4',
  sides: 2,
  layout_version: 3,
  sheet_columns: 1,
  notice_template: 'standard-v1',
  notice_layout: 2,
  column_frame: true,
  uniform_subjective: true,
  auto_subjective_layout: true,
  print_style: 'standard-v2',
  forbidden_regions: [],
  candidate_length: 9,
  revision: 0,
  questions: [],
})

const editableDef = (def: Template): Template =>
  uniformSubjectiveWidths({
    ...structuredClone(def),
    group_id: '',
    layout_version: 3,
    uniform_subjective: true,
    auto_subjective_layout: def.auto_subjective_layout ?? false,
    column_frame: def.column_frame ?? true,
    notice_layout: 2,
    notice_template: def.notice_template || 'standard-v1',
    print_style: 'standard-v2',
    forbidden_regions: def.forbidden_regions || [],
  })

export function TeacherTemplates({
  management,
  initialTemplateId,
  onNavigate,
}: {
  management: boolean
  initialTemplateId?: string
  onNavigate?: (hash: string) => void
}) {
  const list = useResource<TeacherTemplateRow[]>('/teacher-templates', [])
  const subjectTags = useResource<Row[]>('/subject-tags', [])
  const subjectOptions = [...new Set([...subjectTags.data.map(t => String(t.name)), ...SUBJECT_PRESETS].filter(Boolean))].map(name => ({
    label: name,
    value: name,
  }))
  const projects = useResource<Row[]>(management ? '/projects' : null, [])
  const subjects = useResource<Row[]>(management ? '/subjects' : null, [])
  const groups = useResource<Row[]>(management ? '/groups' : null, [])
  const users = useResource<Row[]>(management ? '/users' : null, [])

  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [editingRow, setEditingRow] = useState<TeacherTemplateRow | null>(null)
  const openedRef = useRef('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignForm] = Form.useForm()
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkText, setLinkText] = useState('')
  const [linkMatch, setLinkMatch] = useState<TeacherTemplateRow | null>(null)
  const [linkBusy, setLinkBusy] = useState(false)
  const [adoptTarget, setAdoptTarget] = useState<TeacherTemplateRow | null>(null)
  const [adoptMode, setAdoptMode] = useState<'group' | 'subject'>('group')
  const [adoptForm] = Form.useForm()
  const [rejectTarget, setRejectTarget] = useState<TeacherTemplateRow | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const { message, modal } = App.useApp()

  useEffect(() => {
    if (!initialTemplateId || !list.loaded || openedRef.current === initialTemplateId) return
    const found = list.data.find(r => r.id === initialTemplateId)
    if (found) {
      openedRef.current = initialTemplateId
      setEditingRow(found)
    }
  }, [initialTemplateId, list.loaded, list.data])

  const copyLink = async (row: TeacherTemplateRow) => {
    const tokenLink = row.internal_link || `omp-tpl:${row.share_token}`
    try {
      await navigator.clipboard.writeText(tokenLink)
      message.success(`已复制内部链接：${tokenLink}`)
    } catch {
      modal.info({
        title: '题卡内部链接',
        content: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>可将下方内部链接发送给管理员，在考试题卡库或教师制卡审核中导入：</Typography.Text>
            <Input.TextArea readOnly rows={2} value={tokenLink} />
          </Space>
        ),
      })
    }
  }

  async function createItem(values: { name: string; subject_name?: string; description?: string }) {
    setActionBusy(true)
    try {
      const created = await send<TeacherTemplateRow>('/teacher-templates', values)
      setCreateOpen(false)
      createForm.resetFields()
      await list.reload()
      setEditingRow(created)
      message.success('独立题卡草稿已创建')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setActionBusy(false)
    }
  }

  async function createTaskCard(values: { group_id: string; teacher_id: string; name?: string; description?: string }) {
    setActionBusy(true)
    try {
      const created = await send<TeacherTemplateRow>('/teacher-templates/assign', {
        group_id: values.group_id,
        teacher_id: values.teacher_id,
        name: values.name?.trim() || undefined,
        description: values.description?.trim() || '',
      })
      setAssignOpen(false)
      assignForm.resetFields()
      await list.reload()
      message.success(`已向 ${created.owner_name} 创建并分配任务题卡`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setActionBusy(false)
    }
  }

  async function lookupLink() {
    if (!linkText.trim()) return
    setLinkBusy(true)
    try {
      const found = await request<TeacherTemplateRow>(`/teacher-templates/by-link?link=${encodeURIComponent(linkText.trim())}`)
      setLinkMatch(found)
    } catch (e) {
      setLinkMatch(null)
      message.error((e as Error).message)
    } finally {
      setLinkBusy(false)
    }
  }

  function openAdopt(row: TeacherTemplateRow) {
    setAdoptTarget(row)
    setAdoptMode('group')
    adoptForm.setFieldsValue({ name: row.name, group_id: row.target_group_id || undefined, subject_id: undefined })
    void projects.reload()
    void subjects.reload()
    void groups.reload()
  }

  async function confirmAdopt(values: { group_id?: string; subject_id?: string; name?: string }) {
    if (!adoptTarget) return
    setActionBusy(true)
    try {
      const res = await send<{ template: Template; teacher_template: TeacherTemplateRow }>(
        `/teacher-templates/${adoptTarget.id}/adopt`,
        {
          ...(adoptMode === 'group' ? { group_id: values.group_id } : { subject_id: values.subject_id }),
          ...(values.name?.trim() ? { name: values.name.trim() } : {}),
        },
      )
      setAdoptTarget(null)
      setLinkOpen(false)
      setLinkMatch(null)
      setLinkText('')
      await Promise.all([list.reload(), groups.reload()])
      if (editingRow?.id === res.teacher_template.id) {
        setEditingRow(res.teacher_template)
      }
      const targetGroup = groups.data.find(g => g.id === res.template.group_id)
      const targetSubject = subjects.data.find(s => s.id === targetGroup?.subject_id)
      const targetProjectId = targetSubject?.project_id
      modal.success({
        title: '已导入为考试题卡草稿',
        content: `已将「${res.template.name}」导入目标题卡分组，可在题卡设计中继续微调或审查发布。`,
        okText: targetProjectId && targetSubject && onNavigate ? '前往题卡设计' : '完成',
        onOk: () => {
          if (targetProjectId && targetSubject && onNavigate) {
            onNavigate(
              examPath({
                projectId: targetProjectId,
                subjectId: targetSubject.id,
                gradeId: targetGroup?.grade_id,
                groupId: res.template.group_id,
                section: 'template',
              }),
            )
          }
        },
      })
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setActionBusy(false)
    }
  }

  async function submitForReview(row: TeacherTemplateRow) {
    setActionBusy(true)
    try {
      const updated = await send<TeacherTemplateRow>(`/teacher-templates/${row.id}/submit`, {})
      await list.reload()
      if (editingRow?.id === updated.id) setEditingRow(updated)
      message.success('已推送给管理员审核')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setActionBusy(false)
    }
  }

  async function confirmReject() {
    if (!rejectTarget) return
    setActionBusy(true)
    try {
      const updated = await send<TeacherTemplateRow>(`/teacher-templates/${rejectTarget.id}/reject`, {
        reason: rejectReason.trim(),
      })
      setRejectTarget(null)
      setRejectReason('')
      await list.reload()
      if (editingRow?.id === updated.id) setEditingRow(updated)
      message.success('已退回给制作教师修改')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setActionBusy(false)
    }
  }

  async function deleteRow(row: TeacherTemplateRow) {
    setActionBusy(true)
    try {
      await request(`/teacher-templates/${row.id}`, { method: 'DELETE' })
      if (editingRow?.id === row.id) setEditingRow(null)
      await list.reload()
      message.success('已删除')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setActionBusy(false)
    }
  }

  if (editingRow) {
    return (
      <TeacherTemplateWorkbench
        row={editingRow}
        management={management}
        subjectOptions={subjectOptions}
        onBack={() => {
          setEditingRow(null)
          openedRef.current = ''
          if (initialTemplateId && onNavigate) onNavigate('#/teacher-templates')
          void list.reload()
        }}
        onUpdated={next => {
          setEditingRow(next)
          void list.reload()
        }}
        onCopyLink={() => void copyLink(editingRow)}
        onSubmit={() => void submitForReview(editingRow)}
        onAdopt={() => openAdopt(editingRow)}
        onReject={() => {
          setRejectTarget(editingRow)
          setRejectReason('')
        }}
      />
    )
  }

  const rows = list.data.filter(r => statusFilter === 'all' || r.status === statusFilter)
  const submittedCount = list.data.filter(r => r.status === 'submitted').length

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <ErrorNotice error={list.error} retry={list.reload} />
      <Card size="small">
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <Segmented
              value={statusFilter}
              onChange={v => setStatusFilter(String(v))}
              options={[
                { label: `全部（${list.data.length}）`, value: 'all' },
                { label: `待审核（${submittedCount}）`, value: 'submitted' },
                { label: '草稿', value: 'draft' },
                { label: '已采用', value: 'approved' },
                { label: '已退回', value: 'rejected' },
              ]}
            />
          </Space>
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={list.loading} onClick={() => void list.reload()}>
              刷新
            </Button>
            {management && (
              <>
                <Button icon={<PaperClipOutlined />} onClick={() => { setLinkText(''); setLinkMatch(null); setLinkOpen(true) }}>
                  通过内部链接添加
                </Button>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    assignForm.resetFields()
                    setAssignOpen(true)
                    void projects.reload()
                    void subjects.reload()
                    void groups.reload()
                    void users.reload()
                  }}
                >
                  创建任务题卡
                </Button>
              </>
            )}
            <Button type={management ? 'default' : 'primary'} icon={<PlusOutlined />} onClick={() => { createForm.resetFields(); setCreateOpen(true) }}>
              新建独立题卡
            </Button>
          </Space>
        </Space>
      </Card>

      <Card>
        <Table<TeacherTemplateRow>
          rowKey="id"
          loading={list.loading}
          dataSource={rows}
          locale={{
            emptyText: (
              <Empty
                description={
                  management
                    ? '暂无教师独立制卡记录，可右上角新建或通过内部链接添加。'
                    : '尚未创建独立题卡，点击「新建独立题卡」开始制卡，完成后可生成内部链接或提交管理员审核。'
                }
              />
            ),
          }}
          columns={[
            {
              title: '题卡标题',
              dataIndex: 'name',
              render: (v: string, row) => (
                <Space direction="vertical" size={2}>
                  <Button type="link" className="table-name-link" onClick={() => setEditingRow(row)}>
                    {v}
                  </Button>
                  {row.description && <Text type="secondary" style={{ fontSize: 12 }}>{row.description}</Text>}
                </Space>
              ),
            },
            {
              title: '学科',
              dataIndex: 'subject_name',
              render: (v: string) => (v ? <Tag color="blue">{v}</Tag> : '—'),
            },
            ...(management
              ? [
                  {
                    title: '制作教师',
                    dataIndex: 'owner_name',
                    render: (v: string, row: TeacherTemplateRow) => (
                      <Space size={4}>
                        <span>{v || '—'}</span>
                        {row.owner_username && <Text type="secondary">({row.owner_username})</Text>}
                      </Space>
                    ),
                  },
                ]
              : []),
            {
              title: '状态',
              dataIndex: 'status',
              render: (v: string, row) => {
                const meta = statusMeta[v] || { label: v, color: 'default' }
                return (
                  <Space direction="vertical" size={2}>
                    <Tag color={meta.color}>{meta.label}</Tag>
                    {v === 'rejected' && row.review_note && (
                      <Text type="danger" style={{ fontSize: 12 }}>{row.review_note}</Text>
                    )}
                  </Space>
                )
              },
            },
            {
              title: '题数 / 总分',
              render: (_, row) => `${row.question_count ?? row.definition?.questions?.length ?? 0} 题 · ${row.total_points ?? 0} 分`,
            },
            {
              title: '内部链接',
              dataIndex: 'internal_link',
              render: (link: string, row) => (
                <Space size={4}>
                  <Text code copyable={{ text: link }}>{link}</Text>
                  <Button size="small" type="text" icon={<CopyOutlined />} aria-label="复制内部链接" onClick={() => void copyLink(row)} />
                </Space>
              ),
            },
            {
              title: '更新时间',
              dataIndex: 'updated_at',
              render: (v: number) => (v ? new Date(v * 1000).toLocaleString() : '—'),
            },
            {
              title: '操作',
              render: (_, row) => {
                const canTeacherSubmit = !management && (row.status === 'draft' || row.status === 'rejected')
                return (
                  <Space size={6} wrap>
                    <Button size="small" onClick={() => setEditingRow(row)}>
                      {management ? '审核与编辑' : canTeacherSubmit ? '编辑设置' : '查看'}
                    </Button>
                    {canTeacherSubmit && (
                      <Button size="small" type="primary" loading={actionBusy} onClick={() => void submitForReview(row)}>
                        推送给管理员
                      </Button>
                    )}
                    {management && (
                      <>
                        <Button size="small" type="primary" onClick={() => openAdopt(row)}>
                          采用到考试
                        </Button>
                        {row.status === 'submitted' && (
                          <Button
                            size="small"
                            onClick={() => {
                              setRejectTarget(row)
                              setRejectReason('')
                            }}
                          >
                            退回
                          </Button>
                        )}
                      </>
                    )}
                    <Button
                      size="small"
                      danger
                      onClick={() =>
                        modal.confirm({
                          title: `删除独立题卡「${row.name}」？`,
                          okText: '确认删除',
                          okButtonProps: { danger: true },
                          onOk: () => deleteRow(row),
                        })
                      }
                    >
                      删除
                    </Button>
                  </Space>
                )
              },
            },
          ]}
        />
      </Card>

      <Modal
        title="创建任务题卡（分配给教师）"
        open={assignOpen}
        onCancel={() => !actionBusy && setAssignOpen(false)}
        onOk={() => assignForm.submit()}
        confirmLoading={actionBusy}
        okText="创建并分配"
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message="选择考试题卡并分配给指定教师，对方教师端通知中心将收到一键进入制卡入口。"
        />
        <Form form={assignForm} layout="vertical" onFinish={createTaskCard}>
          <Form.Item name="group_id" label="目标考试题卡" rules={[{ required: true, message: '请选择目标考试题卡' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="搜索考试项目 / 科目 / 题卡"
              options={groups.data
                .filter(g => !g.frozen)
                .map(g => {
                  const s = subjects.data.find(item => item.id === g.subject_id)
                  const p = projects.data.find(item => item.id === s?.project_id)
                  return {
                    value: g.id,
                    label: `${p?.name || ''} / ${s?.name || ''} / ${g.name}${g.template_id ? '（已有版式）' : ''}`,
                  }
                })}
            />
          </Form.Item>
          <Form.Item name="teacher_id" label="分配给教师" rules={[{ required: true, message: '请选择接收教师' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="搜索教师姓名或账号"
              options={users.data.map(u => ({ value: u.id, label: `${u.name}（${u.username}）` }))}
            />
          </Form.Item>
          <Form.Item name="name" label="任务题卡标题（选填）">
            <Input maxLength={100} placeholder="留空自动按考试科目命名" />
          </Form.Item>
          <Form.Item name="description" label="制卡要求说明（选填）">
            <Input.TextArea rows={3} maxLength={2000} placeholder="可注明题量、分值、纸张大小或截稿时间" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="新建独立题卡"
        open={createOpen}
        onCancel={() => !actionBusy && setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={actionBusy}
      >
        <Form form={createForm} layout="vertical" onFinish={createItem}>
          <Form.Item name="name" label="题卡标题" rules={[{ required: true, whitespace: true, message: '请填写题卡标题' }]}>
            <Input maxLength={100} placeholder="例如：高一数学周测答题卡" />
          </Form.Item>
          <Form.Item name="subject_name" label="学科（选填）">
            <TagPicker
              allowCustom
              allowClear
              maxLength={40}
              options={subjectOptions}
              customPlaceholder="点击上方学科标签快速填充，或输入自定义学科"
            />
          </Form.Item>
          <Form.Item name="description" label="制作说明（选填）">
            <Input.TextArea rows={3} maxLength={2000} placeholder="可备注适用年级、试卷结构或审核提示" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="通过内部链接导入教师题卡"
        open={linkOpen}
        onCancel={() => !actionBusy && setLinkOpen(false)}
        footer={null}
        width={620}
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            粘贴教师分享的内部链接（格式如 omp-tpl:xxxx）或题卡编号，查询后可直接在线审核编辑或采用到指定考试题卡。
          </Typography.Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="粘贴内部链接（omp-tpl:...）"
              value={linkText}
              onChange={e => setLinkText(e.target.value)}
              onPressEnter={() => void lookupLink()}
            />
            <Button type="primary" loading={linkBusy} onClick={() => void lookupLink()}>
              查找题卡
            </Button>
          </Space.Compact>
          {linkMatch && (
            <Card size="small">
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Descriptions
                  size="small"
                  column={2}
                  items={[
                    { label: '标题', children: linkMatch.name },
                    { label: '制作教师', children: linkMatch.owner_name },
                    { label: '学科', children: linkMatch.subject_name || '—' },
                    { label: '题数 / 总分', children: `${linkMatch.question_count ?? 0} 题 · ${linkMatch.total_points ?? 0} 分` },
                  ]}
                />
                <Space wrap>
                  <Button
                    onClick={() => {
                      setLinkOpen(false)
                      setEditingRow(linkMatch)
                    }}
                  >
                    在线审核与编辑
                  </Button>
                  <Button type="primary" onClick={() => openAdopt(linkMatch)}>
                    采用到考试题卡
                  </Button>
                </Space>
              </Space>
            </Card>
          )}
        </Space>
      </Modal>

      <Modal
        title={adoptTarget ? `采用「${adoptTarget.name}」到考试题卡` : '采用到考试题卡'}
        open={!!adoptTarget}
        onCancel={() => !actionBusy && setAdoptTarget(null)}
        onOk={() => adoptForm.submit()}
        confirmLoading={actionBusy}
        okText="确认采用并生成草稿"
      >
        <Form form={adoptForm} layout="vertical" onFinish={confirmAdopt}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 14 }}
            message="将为目标考试题卡创建独立草稿，完整保留所有题型、区域、底图、插图与标准答案，管理员可继续编辑后审查发布。"
          />
          <Form.Item label="目标位置">
            <Radio.Group
              value={adoptMode}
              onChange={e => setAdoptMode(e.target.value)}
              options={[
                { label: '导入到已有题卡分组', value: 'group' },
                { label: '按考试科目自动创建默认题卡', value: 'subject' },
              ]}
            />
          </Form.Item>
          {adoptMode === 'group' ? (
            <Form.Item name="group_id" label="所属题卡" rules={[{ required: true, message: '请选择目标题卡' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                options={groups.data
                  .filter(g => !g.frozen)
                  .map(g => {
                    const s = subjects.data.find(item => item.id === g.subject_id)
                    const p = projects.data.find(item => item.id === s?.project_id)
                    return {
                      value: g.id,
                      label: `${p?.name || ''} / ${s?.name || ''} / ${g.grade_name || ''} · ${g.name}${g.template_id ? '（已有题卡）' : ''}`,
                    }
                  })}
              />
            </Form.Item>
          ) : (
            <Form.Item name="subject_id" label="所属科目" rules={[{ required: true, message: '请选择考试科目' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                options={subjects.data.map(s => {
                  const p = projects.data.find(item => item.id === s.project_id)
                  return { value: s.id, label: `${p?.name || ''} / ${s.name}` }
                })}
              />
            </Form.Item>
          )}
          <Form.Item name="name" label="生成后的题卡标题">
            <Input maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={rejectTarget ? `退回「${rejectTarget.name}」给 ${rejectTarget.owner_name}` : '退回修改'}
        open={!!rejectTarget}
        onCancel={() => !actionBusy && setRejectTarget(null)}
        onOk={() => void confirmReject()}
        confirmLoading={actionBusy}
        okText="确认退回"
      >
        <Form layout="vertical">
          <Form.Item label="退回原因或修改建议（选填）">
            <Input.TextArea
              rows={3}
              maxLength={500}
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="例如：请核对第 12 题分值或补齐客观题答案"
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}

function TeacherTemplateWorkbench({
  row,
  management,
  subjectOptions,
  onBack,
  onUpdated,
  onCopyLink,
  onSubmit,
  onAdopt,
  onReject,
}: {
  row: TeacherTemplateRow
  management: boolean
  subjectOptions: { label: string; value: string }[]
  onBack: () => void
  onUpdated: (next: TeacherTemplateRow) => void
  onCopyLink: () => void
  onSubmit: () => void
  onAdopt: () => void
  onReject: () => void
}) {
  const [value, setValue] = useState<Template>(() => editableDef(row.definition || emptyDefinition(row.name)))
  const [subjectName, setSubjectName] = useState(row.subject_name || '')
  const [description, setDescription] = useState(row.description || '')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pane, setPane] = useState('setup')
  const [page, setPage] = useState(1)
  const [questionId, setQuestionId] = useState('')
  const [draw, setDraw] = useState(false)
  const [answerMode, setAnswerMode] = useState(false)
  const [forbiddenMode, setForbiddenMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [subBatchPoints, setSubBatchPoints] = useState<number | null>(10)
  const [mergeIds, setMergeIds] = useState<string[]>([])
  const [editing, setEditing] = useState<TextTarget | null>(null)
  const [noteId, setNoteId] = useState('')
  const [layoutBusy, setLayoutBusy] = useState(false)
  const [layoutError, setLayoutError] = useState('')
  const layoutSeq = useRef(0)
  const lastLayout = useRef('')
  const valueRef = useRef(value)
  valueRef.current = value
  const editingRef = useRef(editing)
  editingRef.current = editing
  const { message, modal } = App.useApp()

  const readOnly = !management && row.status !== 'draft' && row.status !== 'rejected'
  useUnsavedChanges(dirty)

  useEffect(() => {
    setValue(editableDef(row.definition || emptyDefinition(row.name)))
    setSubjectName(row.subject_name || '')
    setDescription(row.description || '')
    setDirty(false)
    setEditing(null)
    setQuestionId('')
    setNoteId('')
    setMergeIds([])
    setPage(1)
  }, [row.id, row.status, row.updated_at])

  function change(update: Partial<Template>) {
    if (readOnly || saving) return
    const next = uniformSubjectiveWidths({ ...valueRef.current, ...update })
    setValue(next)
    setDirty(true)
  }

  function editText(target: TextTarget | null) {
    setEditing(target)
    if (!target) return
    setSettingsOpen(false)
    setDraw(false)
    setForbiddenMode(false)
    setAnswerMode(false)
    if (target.kind === 'note') {
      setNoteId(target.id)
      setPane('notes')
    } else {
      setQuestionId(target.id)
      setPane('subjective')
    }
  }

  function updateText(target: TextTarget, html: string) {
    const current = valueRef.current
    if (target.kind === 'note') {
      change({ print_notes: current.print_notes?.map(n => (n.id === target.id ? { ...n, html } : n)) })
    } else {
      change({
        questions: current.questions.map(q => {
          if (q.id !== target.id) return q
          if (!q.parts) return { ...q, content_html: html }
          const number = q.regions[target.index]?.part_number
          return { ...q, parts: q.parts.map(part => (part.number === number ? { ...part, content_html: html } : part)) }
        }),
      })
    }
  }

  const layoutKey = subjectiveLayoutKey(value)
  async function arrange(source: Template, signal?: AbortSignal) {
    const seq = ++layoutSeq.current
    const key = subjectiveLayoutKey(source)
    setLayoutBusy(true)
    try {
      const result = await request<{ value: Template }>('/templates/subjective-layout', {
        method: 'POST',
        body: JSON.stringify(source),
        signal,
      })
      if (signal?.aborted || seq !== layoutSeq.current || subjectiveLayoutKey(valueRef.current) !== key) return valueRef.current
      const arranged = new Map(result.value.questions.map(q => [q.id, q.regions]))
      const next = {
        ...valueRef.current,
        questions: valueRef.current.questions.map(q => ({ ...q, regions: arranged.get(q.id) ?? q.regions })),
      }
      lastLayout.current = subjectiveLayoutKey(next)
      setLayoutError('')
      if (JSON.stringify(next.questions) !== JSON.stringify(valueRef.current.questions)) {
        setValue(next)
        setDirty(true)
      }
      const target = editingRef.current
      if (target?.kind === 'question') {
        const region = next.questions.find(q => q.id === target.id)?.regions[target.index]
        if (region) setPage(region.page)
      }
      return next
    } finally {
      if (seq === layoutSeq.current) setLayoutBusy(false)
    }
  }

  useEffect(() => {
    if (readOnly || saving || !value.auto_subjective_layout || !value.questions.some(q => q.type === 'subjective') || layoutKey === lastLayout.current) {
      setLayoutBusy(false)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void arrange(valueRef.current, controller.signal).catch(error => {
        if (!controller.signal.aborted) setLayoutError((error as Error).message)
      })
    }, 500)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [layoutKey, readOnly, saving])

  async function saveChanges(reopen = false): Promise<TeacherTemplateRow | null> {
    if (readOnly || saving) return row
    setSaving(true)
    try {
      const prepared = valueRef.current.auto_subjective_layout ? await arrange(valueRef.current) : valueRef.current
      const saved = await send<TeacherTemplateRow>(
        `/teacher-templates/${row.id}`,
        {
          name: prepared.name,
          subject_name: subjectName,
          description,
          definition: prepared,
          ...(reopen ? { reopen: true } : {}),
        },
        'PUT',
      )
      setDirty(false)
      onUpdated(saved)
      message.success(management ? '审核修改已保存（含题区与答案）' : '独立题卡已保存')
      return saved
    } catch (e) {
      message.error((e as Error).message)
      return null
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveAndSubmit() {
    if (dirty) {
      const saved = await saveChanges(true)
      if (!saved) return
    }
    onSubmit()
  }

  async function handleSaveAndAdopt() {
    if (dirty) {
      const saved = await saveChanges()
      if (!saved) return
    }
    onAdopt()
  }

  function select(id: string, edit = false) {
    setEditing(null)
    setQuestionId(id)
    setForbiddenMode(false)
    const q = value.questions.find(item => item.id === id)
    if (q) {
      setPane(q.type === 'subjective' ? 'subjective' : 'objective')
      setAnswerMode(false)
      setDraw(false)
      if (q.regions[0]) setPage(q.regions[0].page)
    }
    if (edit) setSettingsOpen(true)
  }

  function answerOnCard(id: string, letter: string) {
    const q = value.questions.find(item => item.id === id)
    if (!q || readOnly) return
    const answer = q.type === 'single' ? [letter] : q.answer.includes(letter) ? q.answer.filter(a => a !== letter) : [...q.answer, letter].sort()
    change({ questions: value.questions.map(item => (item.id === id ? { ...item, answer } : item)) })
    const rows = value.questions.filter(item => item.type !== 'subjective').sort((a, b) => a.number - b.number)
    const index = rows.findIndex(item => item.id === id)
    if (q.type === 'single' && rows.length) select(rows[Math.min(index + 1, rows.length - 1)].id)
    else setQuestionId(id)
  }

  function patchQuestion(patch: Partial<Question>) {
    if (!question) return
    if (patch.number && value.questions.some(q => q.id !== question.id && questionNumbers(q).includes(patch.number!))) {
      message.warning('该题号已存在')
      return
    }
    change({ questions: value.questions.map(q => (q.id === question.id ? { ...q, ...patch } : q)) })
    if (patch.type) setPane(patch.type === 'subjective' ? 'subjective' : 'objective')
  }

  function combine() {
    const targets = mergeIds.filter(id => {
      const q = value.questions.find(item => item.id === id)
      return q && q.type === 'subjective' && !q.parts
    })
    try {
      const q = mergeQuestions(value.questions, targets)
      modal.confirm({
        title: `合并第 ${questionLabel(q)} 题？`,
        content: `合并后共 ${q.points} 分，每份答卷只录一个总分。评阅方式、评分步长和双评允许差值沿用第 ${q.number} 题的设置。`,
        onOk: () => {
          change({ questions: value.questions.flatMap(item => (item.id === q.id ? [q] : targets.includes(item.id) ? [] : [item])) })
          setQuestionId(q.id)
          setMergeIds([])
          setDraw(false)
          setPage(q.regions[0].page)
        },
      })
    } catch (e) {
      message.warning((e as Error).message)
    }
  }

  function addSubjective() {
    const num = Math.max(0, ...value.questions.flatMap(questionNumbers)) + 1
    const starter = initialSubjectiveRegion(value, page)
    const q = { ...newQuestion(num), regions: starter ? [starter] : [] }
    change({ questions: [...value.questions, q] })
    setEditing(null)
    setQuestionId(q.id)
    setDraw(false)
    setAnswerMode(false)
    setForbiddenMode(false)
  }

  const question = value.questions.find(q => q.id === questionId)
  const subjective = value.questions.filter(q => q.type === 'subjective').sort((a, b) => a.number - b.number)
  const validSubIds = mergeIds.filter(id => subjective.some(q => q.id === id))
  const mergeableIds = validSubIds.filter(id => !subjective.find(q => q.id === id)?.parts)
  const notes = value.print_notes || []
  const note = notes.find(n => n.id === noteId && n.page === page)
  const total = value.questions.reduce((sum, q) => sum + Number(q.points || 0), 0)
  const meta = statusMeta[row.status] || { label: row.status, color: 'default' }

  const setup = (
    <div className="editor-section">
      <Form layout="vertical" disabled={readOnly || saving}>
        <Form.Item label="题卡标题">
          <Input value={value.name} onChange={e => change({ name: e.target.value })} />
        </Form.Item>
        <Form.Item label="学科">
          <TagPicker
            compact
            allowCustom
            allowClear
            disabled={readOnly || saving}
            value={subjectName}
            maxLength={40}
            options={subjectOptions}
            customPlaceholder="点击学科标签快速填充或自定义输入"
            onChange={v => {
              setSubjectName(v || '')
              setDirty(true)
            }}
          />
        </Form.Item>
        <Form.Item label="内部链接">
          <Space.Compact style={{ width: '100%' }}>
            <Input readOnly value={row.internal_link} />
            <Button icon={<CopyOutlined />} onClick={onCopyLink}>
              复制
            </Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item label="制卡说明">
          <Input.TextArea
            rows={2}
            maxLength={2000}
            value={description}
            onChange={e => {
              setDescription(e.target.value)
              setDirty(true)
            }}
          />
        </Form.Item>
        <Form.Item label="副标题">
          <Input value={value.subtitle || ''} onChange={e => change({ subtitle: e.target.value })} />
        </Form.Item>
        <div className="editor-form-grid">
          <Form.Item label="纸张">
            <TagPicker
              compact
              disabled={readOnly || saving}
              value={value.paper}
              options={[{ label: 'A4 纵向', value: 'A4' }, { label: 'A3 横向', value: 'A3' }]}
              onChange={paper => paper && change({ paper, sheet_columns: paper === 'A3' ? 2 : 1, layout_version: 3 })}
            />
          </Form.Item>
          <Form.Item label="面数">
            <TagPicker
              compact
              disabled={readOnly || saving}
              value={value.sides}
              options={[{ label: '单面', value: 1 }, { label: '双面', value: 2 }]}
              onChange={sides => {
                if (!sides) return
                if (sides === 1 && (value.questions.some(q => q.regions.some(r => r.page === 2)) || notes.some(n => n.page === 2) || (value.forbidden_regions || []).some(r => r.page === 2))) {
                  message.warning('背面已有答题区域，请先调整后再改为单面')
                  return
                }
                change({ sides })
                setPage(1)
              }}
            />
          </Form.Item>
        </div>
        {value.paper === 'A3' && (
          <Form.Item label="题卡分栏模板">
            <Select
              value={value.sheet_columns || 2}
              options={[{ label: '2×2 · 正反面各2栏', value: 2 }, { label: '3×3 · 正反面各3栏', value: 3 }]}
              onChange={sheet_columns => change({ sheet_columns, layout_version: 3 })}
            />
          </Form.Item>
        )}
        <div className="editor-form-grid">
          <Form.Item label="题干与自定义文字字号（磅）">
            <InputNumber
              min={6}
              max={36}
              value={value.font_size ?? 9}
              onChange={size => {
                if (size != null) change({ font_size: size, leading: Math.max(size, value.leading ?? 13) })
              }}
            />
          </Form.Item>
          <Form.Item label="文字行距（磅）">
            <InputNumber
              min={value.font_size ?? 9}
              max={72}
              value={value.leading ?? 13}
              onChange={leading => {
                if (leading != null) change({ leading })
              }}
            />
          </Form.Item>
        </div>
        <Form.Item label="分栏底版">
          <Select
            value={value.column_frame ? 'framed' : 'classic'}
            options={[{ label: '整栏圆角框与边缘提示', value: 'framed' }, { label: '逐题圆角框', value: 'classic' }]}
            onChange={v => change({ column_frame: v === 'framed' })}
          />
        </Form.Item>
        <Form.Item label="准考证号位数">
          <InputNumber min={1} max={11} value={value.candidate_length} onChange={length => change({ candidate_length: length || 9 })} />
        </Form.Item>
        <Form.Item label="内置须知">
          <Select
            value={value.notice_template || 'none'}
            options={[{ label: '标准模板 · 考生禁填、注意事项与填涂样例', value: 'standard-v1' }, { label: '不添加', value: 'none' }]}
            onChange={notice_template => change({ notice_template })}
          />
        </Form.Item>
        <Space wrap>
          <Upload
            disabled={readOnly}
            accept="image/*"
            showUploadList={false}
            beforeUpload={async file => {
              const data = new FormData()
              data.append('file', file)
              try {
                const asset = await request<Row>('/assets', { method: 'POST', body: data })
                const pageW = value.paper === 'A3' ? 420 : 210
                const defaultBox = { x: 12, y: page === 1 ? 100 : 34, width: pageW - 24, height: page === 1 ? 165 : 225 }
                change({ background_assets: { ...value.background_assets, [String(page)]: asset.id }, background_boxes: { ...value.background_boxes, [String(page)]: defaultBox } })
                setForbiddenMode(false)
                message.success('当前面底图已导入，可在画布上自由拖动和缩放')
              } catch (e) {
                message.error((e as Error).message)
              }
              return false
            }}
          >
            <Button disabled={readOnly || saving}>导入当前面题卡底图</Button>
          </Upload>
          {value.background_assets?.[String(page)] && !readOnly && (
            <>
              <Button
                disabled={saving}
                onClick={() => {
                  const pageW = value.paper === 'A3' ? 420 : 210
                  change({ background_boxes: { ...value.background_boxes, [String(page)]: { x: 0, y: 0, width: pageW, height: 297 } } })
                }}
              >
                铺满整页
              </Button>
              <Button
                danger
                disabled={saving}
                onClick={() => {
                  const nextAssets = { ...value.background_assets }
                  delete nextAssets[String(page)]
                  const nextBoxes = { ...value.background_boxes }
                  delete nextBoxes[String(page)]
                  change({ background_assets: nextAssets, background_boxes: nextBoxes })
                }}
              >
                移除底图
              </Button>
            </>
          )}
        </Space>
      </Form>
    </div>
  )

  return (
    <div className="template-workspace">
      <Card className="template-action-bar">
        <div className="template-actions">
          <Space wrap>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => {
                if (dirty) modal.confirm({ title: '有未保存的修改，确定返回列表？', onOk: onBack })
                else onBack()
              }}
            >
              返回列表
            </Button>
            <Tag color={meta.color}>{meta.label}</Tag>
            {management && <Tag icon={<BookOutlined />}>制作教师：{row.owner_name}</Tag>}
          </Space>
          <Space wrap>
            <Text type="secondary">{value.questions.length} 题 · {total} 分</Text>
            {dirty && <Tag color="orange">未保存修改</Tag>}
            <Button icon={<CopyOutlined />} onClick={onCopyLink}>
              复制内部链接
            </Button>
            <Button
              icon={<DownloadOutlined />}
              disabled={dirty}
              onClick={() => void download(`/teacher-templates/${row.id}/pdf`, `${value.name}.pdf`).catch(e => message.error((e as Error).message))}
            >
              导出 PDF
            </Button>
            {!readOnly && (
              <Button icon={<SaveOutlined />} loading={saving} onClick={() => void saveChanges()}>
                保存
              </Button>
            )}
            {!management && (row.status === 'draft' || row.status === 'rejected') && (
              <Button type="primary" loading={saving} onClick={() => void handleSaveAndSubmit()}>
                推送给管理员
              </Button>
            )}
            {management && (
              <>
                {row.status === 'submitted' && (
                  <Button onClick={onReject}>
                    退回修改
                  </Button>
                )}
                <Button type="primary" icon={<CheckCircleOutlined />} loading={saving} onClick={() => void handleSaveAndAdopt()}>
                  采用到考试题卡
                </Button>
              </>
            )}
          </Space>
        </div>
      </Card>

      {row.target_project_name && (
        <Alert
          type="info"
          showIcon
          message={`管理员 ${row.assigned_by_name || ''} 下发的制卡任务：${[row.target_project_name, row.target_grade_name, row.target_subject_name, row.target_group_name].filter(Boolean).join(' · ')}`}
          description={row.description || '完成制卡后点击「保存」，即可复制内部链接或点击「推送给管理员」。'}
        />
      )}
      {row.status === 'rejected' && row.review_note && (
        <Alert type="warning" showIcon message={`管理员退回意见：${row.review_note}`} />
      )}
      {!management && (row.status === 'submitted' || row.status === 'approved') && (
        <Alert
          type="info"
          showIcon
          message={row.status === 'submitted' ? '当前题卡已提交管理员审核，暂不可自行修改；仍可复制内部链接。' : '当前题卡已被管理员采用到考试题卡，仍可查看或复制内部链接。'}
        />
      )}
      {layoutError && (
        <Alert
          type="error"
          showIcon
          message="题区需要调整"
          description={layoutError}
          action={
            <Button disabled={readOnly || layoutBusy} onClick={() => void arrange(valueRef.current).catch(error => setLayoutError((error as Error).message))}>
              重新排版
            </Button>
          }
        />
      )}

      <div className="template-workbench">
        <Card className="template-config">
          <Tabs
            activeKey={pane}
            onChange={key => {
              setEditing(null)
              setPane(key)
              setForbiddenMode(false)
              setAnswerMode(false)
              setDraw(false)
              if (key === 'subjective' && question?.type !== 'subjective') setQuestionId(subjective[0]?.id || '')
            }}
            items={[
              { key: 'setup', label: '底版与链接', children: setup },
              {
                key: 'objective',
                label: '选择题与答案',
                children: (
                  <ObjectiveEditor
                    value={value}
                    page={page}
                    readOnly={readOnly || saving}
                    selected={questionId}
                    onChange={questions => change({ questions, layout_version: 3 })}
                    onSelect={id => select(id)}
                    onEdit={id => select(id, true)}
                  />
                ),
              },
              {
                key: 'subjective',
                label: '主观题',
                children: (
                  <div className="editor-section">
                    <Space wrap size={6}>
                      <Switch
                        size="small"
                        aria-label="题区随内容自动调整"
                        disabled={readOnly || saving}
                        checked={!!value.auto_subjective_layout}
                        onChange={auto_subjective_layout => change({ auto_subjective_layout })}
                      />
                      <Text style={{ fontSize: 12 }}>自动排版</Text>
                      <Button size="small" disabled={readOnly || saving || layoutBusy} loading={layoutBusy} onClick={() => void arrange(valueRef.current).catch(error => setLayoutError((error as Error).message))}>
                        按内容排版
                      </Button>
                      <Button size="small" type="primary" icon={<PlusOutlined />} disabled={readOnly || saving} onClick={addSubjective}>
                        {value.sides === 2 ? `添加主观题（${page === 2 ? '背面' : '正面'}）` : '添加主观题'}
                      </Button>
                    </Space>
                    {!readOnly && validSubIds.length > 0 && (
                      <div className="question-batch-bar">
                        <Space wrap size={6}>
                          <Text style={{ fontSize: 12 }}>已选 {validSubIds.length} 题</Text>
                          <InputNumber
                            size="small"
                            min={0.01}
                            precision={2}
                            value={subBatchPoints}
                            onChange={setSubBatchPoints}
                            style={{ width: 64 }}
                            aria-label="主观题批量分值"
                          />
                          <Button
                            size="small"
                            onClick={() => {
                              if (subBatchPoints == null || subBatchPoints <= 0) return
                              const ids = new Set(mergeableIds)
                              change({ questions: value.questions.map(q => (ids.has(q.id) ? { ...q, points: subBatchPoints } : q)) })
                              message.success('已批量更新分值')
                            }}
                          >
                            设分
                          </Button>
                          <Button size="small" disabled={saving || mergeableIds.length < 2} onClick={combine}>
                            合并
                          </Button>
                          <Popconfirm
                            title={`删除选中的 ${validSubIds.length} 道主观题？`}
                            onConfirm={() => {
                              const ids = new Set(validSubIds)
                              change({ questions: value.questions.filter(q => !ids.has(q.id)) })
                              setMergeIds([])
                              if (ids.has(questionId)) setQuestionId('')
                            }}
                          >
                            <Button size="small" danger>删除</Button>
                          </Popconfirm>
                          <Button size="small" type="text" onClick={() => setMergeIds([])}>取消</Button>
                        </Space>
                      </div>
                    )}
                    <Table<Question>
                      columnChooser={false}
                      exportable={false}
                      rowSelection={readOnly ? undefined : { columnWidth: 32, selectedRowKeys: validSubIds, onChange: keys => setMergeIds(keys.map(String)) }}
                      rowClassName={q => (q.id === questionId ? 'selected-question-row' : '')}
                      onRow={q => ({
                        onClick: () => {
                          setEditing(null)
                          setQuestionId(q.id)
                          setDraw(false)
                          if (q.regions.length) setPage(q.regions[0].page)
                        },
                      })}
                      rowKey="id"
                      size="small"
                      dataSource={subjective}
                      pagination={subjective.length > 50 ? { defaultPageSize: 50, size: 'small' } : false}
                      locale={{ emptyText: <Empty description="点击「添加主观题」在当前面创建答题区" /> }}
                      columns={[
                        {
                          title: '题号',
                          width: 92,
                          render: (_, q) => (
                            <Space size={4}>
                              <span>{questionLabel(q)}</span>
                              {q.regions.length ? (
                                <Tag style={{ marginInlineEnd: 0, fontSize: 11, paddingInline: 4, lineHeight: '16px' }}>
                                  {[...new Set(q.regions.map(r => (r.page === 1 ? '正' : '背')))].join('/')}
                                </Tag>
                              ) : (
                                <Tag color="orange" style={{ marginInlineEnd: 0, fontSize: 11, paddingInline: 4, lineHeight: '16px' }}>待框选</Tag>
                              )}
                            </Space>
                          ),
                        },
                        {
                          title: '分值',
                          width: 76,
                          render: (_, q) => (
                            <InputNumber
                              size="small"
                              aria-label={'第' + q.number + '题分值'}
                              disabled={readOnly || saving || !!q.parts}
                              min={0.01}
                              precision={2}
                              value={q.points}
                              onClick={e => e.stopPropagation()}
                              onChange={points => {
                                if (points !== null) change({ questions: value.questions.map(item => (item.id === q.id ? { ...item, points } : item)) })
                              }}
                            />
                          ),
                        },
                        {
                          title: '',
                          width: 48,
                          render: (_, q) => (
                            <Button
                              size="small"
                              type="link"
                              style={{ paddingInline: 2 }}
                              onClick={e => {
                                e.stopPropagation()
                                select(q.id, true)
                              }}
                            >
                              设置
                            </Button>
                          ),
                        },
                      ]}
                    />
                  </div>
                ),
              },
              {
                key: 'notes',
                label: '版面文字',
                children: (
                  <div className="editor-section">
                    <Text>点击网格添加文字，双击已有文字修改。拖动文字框移动，拖右下角调整大小。</Text>
                    {!!notes.filter(n => n.page === page).length && (
                      <Select
                        aria-label="当前面的文字框"
                        placeholder="选择文字框"
                        value={note?.id}
                        onChange={id => {
                          setEditing(null)
                          setNoteId(id)
                        }}
                        options={notes
                          .filter(n => n.page === page)
                          .map((n, i) => ({
                            value: n.id,
                            label: new DOMParser().parseFromString(n.html, 'text/html').body.textContent?.trim().slice(0, 35) || '文字框 ' + (i + 1),
                          }))}
                      />
                    )}
                    {note && (
                      <>
                        <Button disabled={readOnly || saving} onClick={() => editText({ kind: 'note', id: note.id, index: 0 })}>
                          在题卡上编辑文字
                        </Button>
                        <Button
                          danger
                          disabled={readOnly || saving}
                          onClick={() => {
                            change({ print_notes: notes.filter(n => n.id !== note.id) })
                            setNoteId('')
                          }}
                        >
                          删除文字框
                        </Button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>

        <Card
          className="template-preview"
          title={pane === 'notes' ? '文字排版网格' : '题卡画布'}
          extra={
            <Space wrap>
              <Radio.Group
                value={page}
                onChange={event => {
                  setEditing(null)
                  setPage(event.target.value)
                }}
                options={Array.from({ length: value.sides }, (_, i) => ({ label: i === 0 ? '正面' : '背面', value: i + 1 }))}
              />
              {!readOnly && pane !== 'notes' && (
                <Radio.Group
                  value={forbiddenMode ? 'forbidden' : answerMode ? 'answer' : draw ? 'draw' : 'move'}
                  onChange={event => {
                    setEditing(null)
                    setForbiddenMode(event.target.value === 'forbidden')
                    setAnswerMode(event.target.value === 'answer')
                    setDraw(event.target.value === 'draw')
                  }}
                  options={[
                    { label: '移动位置', value: 'move' },
                    ...(pane === 'objective' ? [{ label: '设答案', value: 'answer' }] : []),
                    ...(pane === 'subjective' ? [{ label: '框选题区', value: 'draw' }] : []),
                    ...(pane === 'setup' ? [{ label: '禁答区', value: 'forbidden' }] : []),
                  ]}
                />
              )}
            </Space>
          }
        >
          <Paper
            editing={editing}
            onEdit={editText}
            onTextChange={updateText}
            noteMode={pane === 'notes'}
            bgMode={pane === 'setup' && !forbiddenMode}
            selectedNote={noteId}
            onNoteSelect={setNoteId}
            onNoteRegion={(region, id) => {
              if (id) {
                change({ print_notes: notes.map(n => (n.id === id ? { ...n, ...region } : n)) })
                return
              }
              const added = { ...region, id: crypto.randomUUID(), html: '' }
              change({ print_notes: [...notes, added] })
              editText({ kind: 'note', id: added.id, index: 0 })
            }}
            onBackgroundBox={(p, box) => change({ background_boxes: { ...value.background_boxes, [String(p)]: box } })}
            onQuestionImageBox={(id, box) => change({ questions: value.questions.map(q => (q.id === id ? { ...q, image_box: box } : q)) })}
            value={value}
            page={page}
            selected={questionId}
            draw={draw && !answerMode && !forbiddenMode && !question?.parts}
            forbiddenMode={forbiddenMode}
            onForbidden={forbidden_regions => change({ forbidden_regions })}
            answerMode={answerMode}
            readOnly={readOnly || saving}
            onAnswer={answerOnCard}
            onSelect={(id, targetPage) => {
              setQuestionId(id)
              const q = value.questions.find(item => item.id === id)
              if (q) {
                setPane(q.type === 'subjective' ? 'subjective' : 'objective')
                if (q.type === 'subjective') setAnswerMode(false)
              }
              if (targetPage) setPage(targetPage)
            }}
            onRegion={(id, region, index) =>
              change({
                questions: value.questions.map(q =>
                  q.id === id ? { ...q, regions: index === undefined ? [...q.regions, region] : q.regions.map((r, i) => (i === index ? region : r)) } : q,
                ),
              })
            }
          />
        </Card>
      </div>

      <QuestionSettings
        template={value}
        onText={() => {
          if (!question?.regions.length) return
          const index = Math.max(0, question.regions.findIndex(r => r.page === page))
          setPage(question.regions[index].page)
          editText({ kind: 'question', id: question.id, index })
        }}
        onSplit={() => {
          if (!question?.parts) return
          change({ questions: value.questions.flatMap(q => (q.id === question.id ? splitQuestions(q) : [q])) })
          setSettingsOpen(false)
          setMergeIds([])
        }}
        question={question}
        open={settingsOpen}
        readOnly={readOnly || saving}
        onClose={() => setSettingsOpen(false)}
        onChange={patchQuestion}
        onDraw={() => {
          setForbiddenMode(false)
          setDraw(true)
          setAnswerMode(false)
          setSettingsOpen(false)
        }}
        onDelete={() => {
          if (!question) return
          change({ questions: value.questions.filter(q => q.id !== question.id) })
          setQuestionId('')
          setSettingsOpen(false)
        }}
      />
    </div>
  )
}
