import { useMemo, useState } from 'react'
import { App, Card, ColorPicker, Divider, Form, Input, Modal, Segmented, Select, Space, Tag, Typography } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { Table } from './DataTable'
import { Button } from './Button'
import { BatchDeleteButton, DeleteRecord } from './DeleteRecord'
import { ErrorNotice } from './ErrorNotice'
import { RecordPicker } from './RecordPicker'
import { MultipleRecordSelect } from './RecordSelect'
import { ClassTags, DEFAULT_CLASS_TAGS, TAG_COLOR_CHOICES, classTagColor, gradeColor } from './SchoolTags'
import { TagPicker } from './TagPicker'
import { request, send, useResource, type Row } from './api'

type CategoryFilter = 'all' | 'custom' | 'grade' | 'elective'

const categoryLabels: Record<string, string> = {
  grade: '内置 · 年级',
  elective: '内置 · 选科',
  custom: '自定义标签',
}

export function TagsManager({
  classes,
  students,
  grades,
  onChanged,
  onFilterByTag,
  onFilterClassesByTag,
}: {
  classes: Row[]
  students: Row[]
  grades: Row[]
  onChanged: () => Promise<unknown>
  onFilterByTag?: (tagName: string) => void
  onFilterClassesByTag?: (row: Row) => void
}) {
  const tags = useResource<Row[]>('/tags', [])
  const electives = useResource<Row[]>('/electives', [])
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState('blue')
  const [description, setDescription] = useState('')
  const [classIds, setClassIds] = useState<string[]>([])
  const [studentIds, setStudentIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  // Elective member editor state (for built-in elective tags)
  const [electiveGrade, setElectiveGrade] = useState('')
  const [electiveKind, setElectiveKind] = useState<'required' | 'elective'>('elective')
  const [electiveStudentIds, setElectiveStudentIds] = useState<string[]>([])
  const [electivePickerOpen, setElectivePickerOpen] = useState(false)
  const [savingElective, setSavingElective] = useState(false)

  const { message } = App.useApp()

  const activeGrades = useMemo(() => grades.filter(g => !g.archived), [grades])
  const gradeName = (id?: string) => grades.find(g => g.id === id)?.name || ''
  const classLabel = (id?: string) => {
    const c = classes.find(item => item.id === id)
    return c ? [gradeName(c.grade_id), c.name].filter(Boolean).join(' · ') : ''
  }

  const visibleTags = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tags.data.filter(t => {
      if (category !== 'all' && t.category !== category) return false
      if (q && !String(t.name || '').toLowerCase().includes(q) && !String(t.description || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [tags.data, category, search])

  const validSelectedIds = useMemo(
    () => selectedIds.filter(id => tags.data.some(t => t.id === id && !t.builtin)),
    [selectedIds, tags.data],
  )

  const loadElectiveGrade = (subjectName: string, gid: string) => {
    setElectiveGrade(gid)
    const entry = electives.data.find(e => e.grade_id === gid && e.subject === subjectName)
    setElectiveKind(entry?.kind_of_subject === 'required' ? 'required' : 'elective')
    setElectiveStudentIds(Array.isArray(entry?.student_ids) ? entry.student_ids : [])
  }

  const openCreate = () => {
    setEditing(null)
    setName('')
    setColor('blue')
    setDescription('')
    setClassIds([])
    setStudentIds([])
    setModalOpen(true)
  }

  const openEdit = (row: Row) => {
    setEditing(row)
    setName(row.name || '')
    setColor(row.color || 'blue')
    setDescription(row.description || '')
    setClassIds(Array.isArray(row.class_ids) ? row.class_ids : [])
    setStudentIds(Array.isArray(row.direct_student_ids) ? row.direct_student_ids : [])
    if (row.category === 'elective') {
      const firstGrade =
        electives.data.find(e => e.subject === row.name)?.grade_id ||
        activeGrades[0]?.id ||
        ''
      loadElectiveGrade(row.name || '', firstGrade)
    }
    setModalOpen(true)
  }

  async function saveElectiveMembers() {
    if (!editing || !electiveGrade || savingElective) return
    setSavingElective(true)
    try {
      const targetSubject = name.trim() || editing.name
      await send(
        '/electives',
        {
          grade_id: electiveGrade,
          subject: targetSubject,
          kind: electiveKind,
          student_ids: electiveKind === 'required' ? [] : electiveStudentIds,
        },
        'PUT',
      )
      message.success(`已保存 ${gradeName(electiveGrade)}「${targetSubject}」选科成员`)
      await Promise.all([electives.reload(), tags.reload(), onChanged()])
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSavingElective(false)
    }
  }

  async function save() {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      if (!editing) {
        await send('/tags', {
          name: name.trim(),
          color,
          description: description.trim(),
          class_ids: classIds,
          student_ids: studentIds,
        })
        message.success('标签已创建')
      } else {
        const body: Record<string, unknown> = {
          name: name.trim(),
          color,
        }
        if (!editing.builtin) {
          body.description = description.trim()
          body.class_ids = classIds
          body.student_ids = studentIds
        }
        await send(`/tags/${encodeURIComponent(editing.id)}`, body, 'PUT')
        message.success('标签已更新')
      }
      setModalOpen(false)
      await Promise.all([tags.reload(), electives.reload(), onChanged()])
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const electiveGradeClasses = useMemo(
    () => classes.filter(c => c.grade_id === electiveGrade),
    [classes, electiveGrade],
  )
  const electiveGradeClassMap = useMemo(
    () => new Map(electiveGradeClasses.map(c => [c.id, c])),
    [electiveGradeClasses],
  )
  const electiveGradeStudents = useMemo(
    () => students.filter(s => electiveGradeClassMap.has(s.class_id)),
    [students, electiveGradeClassMap],
  )

  const isHex = /^#[0-9a-fA-F]{6}$/.test(color)

  return (
    <Card>
      <ErrorNotice error={tags.error || electives.error} retry={() => Promise.all([tags.reload(), electives.reload()])} />
      {validSelectedIds.length > 0 && (
        <div className="selection-action-bar">
          <span className="selection-action-summary">已选 {validSelectedIds.length} 个自定义标签</span>
          <Space size={8}>
            <BatchDeleteButton
              kind="tags"
              ids={validSelectedIds}
              onDeleted={async () => {
                setSelectedIds([])
                await Promise.all([tags.reload(), onChanged()])
              }}
            />
            <Button size="small" type="text" onClick={() => setSelectedIds([])}>
              清空选择
            </Button>
          </Space>
        </div>
      )}
      <Table<Row>
        rowKey="id"
        query={search}
        loading={tags.loading}
        dataSource={visibleTags}
        pagination={{ defaultPageSize: 50, showSizeChanger: true }}
        rowSelection={{
          selectedRowKeys: validSelectedIds,
          onChange: keys => setSelectedIds(keys.map(String)),
          getCheckboxProps: row => ({ disabled: !!row.builtin }),
        }}
        toolbar={
          <div className="entity-toolbar">
            <Input.Search
              className="entity-search"
              placeholder="搜索标签名称或说明"
              allowClear
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <Space wrap>
              <Segmented<CategoryFilter>
                value={category}
                onChange={setCategory}
                options={[
                  { value: 'all', label: '全部标签' },
                  { value: 'custom', label: '自定义标签' },
                  { value: 'grade', label: '年级标签' },
                  { value: 'elective', label: '选科标签' },
                ]}
              />
              <Button onClick={() => void Promise.all([tags.reload(), electives.reload()])} loading={tags.loading}>
                刷新
              </Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建标签
              </Button>
            </Space>
          </div>
        }
        columns={[
          {
            title: '标签（点击快速筛选学生）',
            dataIndex: 'name',
            render: (value: string, row: Row) => (
              <Tag
                color={row.color || 'blue'}
                style={{ marginInlineEnd: 0, cursor: onFilterByTag ? 'pointer' : undefined }}
                title={onFilterByTag ? `点击筛选包含「${value}」标签的学生` : undefined}
                onClick={
                  onFilterByTag
                    ? e => {
                        e.stopPropagation()
                        onFilterByTag(value)
                      }
                    : undefined
                }
              >
                {value}
              </Tag>
            ),
          },
          {
            title: '类别',
            dataIndex: 'category',
            render: (value: string) => (
              <Tag
                style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                title="点击按此类别筛选"
                onClick={() => setCategory(value === 'grade' || value === 'elective' || value === 'custom' ? value : 'all')}
              >
                {categoryLabels[value] || value}
              </Tag>
            ),
          },
          {
            title: '关联班级',
            dataIndex: 'class_count',
            align: 'right',
            render: (n: number, row: Row) =>
              n && onFilterClassesByTag ? (
                <Button type="link" size="small" onClick={() => onFilterClassesByTag(row)}>
                  {n} 个
                </Button>
              ) : n ? (
                `${n} 个`
              ) : (
                '—'
              ),
          },
          {
            title: '覆盖学生',
            dataIndex: 'student_count',
            align: 'right',
            render: (n: number, row: Row) =>
              onFilterByTag ? (
                <Button type="link" size="small" onClick={() => onFilterByTag(row.name)}>
                  {n || 0} 人
                </Button>
              ) : (
                `${n || 0} 人`
              ),
          },
          {
            title: '说明',
            dataIndex: 'description',
            render: (v: string) => <Typography.Text type="secondary">{v || '—'}</Typography.Text>,
          },
          {
            title: '操作',
            className: 'row-actions',
            render: (_: unknown, row: Row) => (
              <Space>
                <Button onClick={() => openEdit(row)}>{row.category === 'elective' ? '编辑 / 选科成员' : '编辑'}</Button>
                {!row.builtin && (
                  <DeleteRecord
                    kind="tags"
                    row={row}
                    reload={async () => {
                      setSelectedIds(ids => ids.filter(id => id !== row.id))
                      await Promise.all([tags.reload(), onChanged()])
                    }}
                  />
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? `编辑标签 · ${editing.name}` : '新建自定义标签'}
        open={modalOpen}
        width={640}
        onCancel={() => !busy && setModalOpen(false)}
        onOk={() => void save()}
        confirmLoading={busy}
        okButtonProps={{ disabled: !name.trim() }}
      >
        <Form layout="vertical">
          <Form.Item
            label="标签名称"
            extra={editing?.category === 'grade' ? '修改内置年级标签名称将同步更新全校对应年级名称，便于学年升级。' : undefined}
          >
            {!editing ? (
              <TagPicker
                allowCustom
                maxLength={30}
                value={name}
                onChange={v => setName(v || '')}
                options={DEFAULT_CLASS_TAGS.map(t => ({ label: t, value: t, color: classTagColor(t) }))}
                customPlaceholder="点击上方标签快速填充，或输入自定义标签名称"
              />
            ) : (
              <Input value={name} maxLength={30} onChange={e => setName(e.target.value)} placeholder="如：直卓、卓越、重点、实验、普通、竞赛班" />
            )}
          </Form.Item>
          <Form.Item label="标签颜色">
            <Space wrap align="center">
              <Select
                style={{ width: 140 }}
                value={isHex ? undefined : color}
                placeholder="预设色"
                allowClear
                onChange={v => setColor(v || 'blue')}
                options={TAG_COLOR_CHOICES.map(item => ({
                  value: item.value,
                  label: (
                    <Tag color={item.value} style={{ marginInlineEnd: 0 }}>
                      {item.label}
                    </Tag>
                  ),
                }))}
              />
              <ColorPicker
                value={isHex ? color : '#1677ff'}
                showText
                onChange={c => setColor(c.toHexString())}
              />
              <Tag color={color} style={{ marginInlineEnd: 0 }}>
                {name.trim() || '预览标签'}
              </Tag>
            </Space>
          </Form.Item>

          {editing?.category === 'elective' && (
            <>
              <Divider style={{ margin: '12px 0' }} />
              <Typography.Text strong style={{ display: 'block', marginBottom: 10 }}>
                各年级选科成员维护（原「选科管理」已整合至此）
              </Typography.Text>
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <TagPicker
                  value={electiveGrade || undefined}
                  onChange={gid => gid && loadElectiveGrade(editing.name, gid)}
                  options={activeGrades.map(g => ({ value: g.id, label: g.name, color: gradeColor(g.name) }))}
                />
                <TagPicker
                  value={electiveKind}
                  onChange={v => v && setElectiveKind(v)}
                  options={[
                    { value: 'required', label: '必考（年级全体）' },
                    { value: 'elective', label: '选考（指定学生）' },
                  ]}
                />
                <Space wrap align="center">
                  {electiveKind === 'elective' && (
                    <Button disabled={!electiveGrade || savingElective} onClick={() => setElectivePickerOpen(true)}>
                      选择学生 / Excel 导入（当前 {electiveStudentIds.length} 人）
                    </Button>
                  )}
                  <Button
                    type="primary"
                    ghost
                    loading={savingElective}
                    disabled={!electiveGrade}
                    onClick={() => void saveElectiveMembers()}
                  >
                    保存该年级选科名单
                  </Button>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  支持上传学校多工作表选科矩阵 Excel，自动按「{editing.name}」列或外语列匹配选考学生。
                </Typography.Text>
              </Space>
            </>
          )}

          {(!editing || !editing.builtin) && (
            <>
              <Form.Item label="说明（可选）">
                <Input value={description} maxLength={200} onChange={e => setDescription(e.target.value)} placeholder="简述该标签用途" />
              </Form.Item>
              <Form.Item label="关联班级（班内学生自动继承该标签）">
                <MultipleRecordSelect
                  title="选择班级"
                  kind="classes"
                  value={classIds}
                  onChange={setClassIds}
                  records={classes}
                  label={c => classLabel(c.id)}
                  fields={[{ key: 'grade', label: '年级', options: grades.map(g => ({ value: g.id, label: g.name })), values: c => [c.grade_id] }]}
                  columns={[
                    { title: '年级', render: (_, c) => gradeName(c.grade_id) },
                    { title: '班级', dataIndex: 'name' },
                  ]}
                />
              </Form.Item>
              <Form.Item label="直接关联学生（可选，单名学生可拥有多个标签）">
                <MultipleRecordSelect
                  title="选择学生"
                  kind="students"
                  value={studentIds}
                  onChange={setStudentIds}
                  records={students}
                  label={s => `${s.name}（${s.candidate_number}）`}
                  fields={[
                    { key: 'grade', label: '年级', options: grades.map(g => ({ value: g.id, label: g.name })), values: s => [classes.find(c => c.id === s.class_id)?.grade_id || ''] },
                    { key: 'class', label: '行政班', options: classes.map(c => ({ value: c.id, label: classLabel(c.id) })), values: s => [s.class_id] },
                  ]}
                  columns={[
                    { title: '姓名', dataIndex: 'name' },
                    { title: '考号', dataIndex: 'candidate_number' },
                    { title: '班级', render: (_, s) => classLabel(s.class_id) },
                  ]}
                />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      <RecordPicker<Row>
        open={electivePickerOpen}
        onClose={() => setElectivePickerOpen(false)}
        title={`选择 ${gradeName(electiveGrade)}「${editing?.name || ''}」选考学生`}
        records={electiveGradeStudents}
        value={electiveStudentIds}
        onChange={setElectiveStudentIds}
        label={s => `${s.name}（${s.candidate_number}）`}
        columns={[
          { title: '准考证号', dataIndex: 'candidate_number' },
          { title: '姓名', dataIndex: 'name' },
          {
            title: '行政班',
            render: (_, s) => {
              const cls = electiveGradeClassMap.get(s.class_id)
              return (
                <Space size={6} wrap>
                  <span>{cls?.name || '—'}</span>
                  <ClassTags tags={cls?.tags} empty={null} />
                </Space>
              )
            },
          },
        ]}
        fields={[
          {
            key: 'class',
            label: '行政班',
            options: electiveGradeClasses.map(c => ({ value: c.id, label: c.name })),
            values: s => [s.class_id],
          },
        ]}
        importer={{
          templateUrl: '/selection/students/template',
          templateName: '选考学生导入模板.xlsx',
          upload: async file => {
            const body = new FormData()
            body.append('file', file)
            return await request<string[]>(
              `/electives/match?grade_id=${encodeURIComponent(electiveGrade)}&subject=${encodeURIComponent(editing?.name || '')}`,
              { method: 'POST', body },
            )
          },
        }}
      />
    </Card>
  )
}
