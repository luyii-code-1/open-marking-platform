import { useMemo, useState } from 'react'
import { App, Card, ColorPicker, Form, Input, Modal, Segmented, Select, Space, Tag, Typography } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { Table } from './DataTable'
import { Button } from './Button'
import { BatchDeleteButton, DeleteRecord } from './DeleteRecord'
import { ErrorNotice } from './EntityTable'
import { MultipleRecordSelect } from './RecordSelect'
import { TAG_COLOR_CHOICES } from './SchoolTags'
import { send, useResource, type Row } from './api'

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
}: {
  classes: Row[]
  students: Row[]
  grades: Row[]
  onChanged: () => Promise<unknown>
}) {
  const tags = useResource<Row[]>('/tags', [])
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
  const { message } = App.useApp()

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
    setModalOpen(true)
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
      await Promise.all([tags.reload(), onChanged()])
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isHex = /^#[0-9a-fA-F]{6}$/.test(color)

  return (
    <Card>
      <ErrorNotice error={tags.error} retry={tags.reload} />
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
              <Button onClick={() => void tags.reload()} loading={tags.loading}>
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
            title: '标签',
            dataIndex: 'name',
            render: (value: string, row: Row) => (
              <Tag color={row.color || 'blue'} style={{ marginInlineEnd: 0 }}>
                {value}
              </Tag>
            ),
          },
          {
            title: '类别',
            dataIndex: 'category',
            render: (value: string) => <Tag>{categoryLabels[value] || value}</Tag>,
          },
          {
            title: '关联班级',
            dataIndex: 'class_count',
            align: 'right',
            render: (n: number) => (n ? `${n} 个` : '—'),
          },
          {
            title: '覆盖学生',
            dataIndex: 'student_count',
            align: 'right',
            render: (n: number) => `${n || 0} 人`,
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
                <Button onClick={() => openEdit(row)}>编辑</Button>
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
        width={620}
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
            <Input value={name} maxLength={30} onChange={e => setName(e.target.value)} placeholder="如：直卓、卓越、重点、实验、普通、竞赛班" />
          </Form.Item>
          <Form.Item label="标签颜色">
            <Space wrap align="center">
              <Select
                style={{ width: 150 }}
                value={isHex ? undefined : color}
                placeholder="预设色"
                allowClear
                onChange={v => setColor(v || 'blue')}
                options={TAG_COLOR_CHOICES.map(item => ({
                  value: item.value,
                  label: (
                    <Space size={6}>
                      <Tag color={item.value} style={{ marginInlineEnd: 0 }}>
                        {item.label}
                      </Tag>
                    </Space>
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
    </Card>
  )
}
