import { useMemo, useState } from 'react'
import { Alert, App, Card, Form, Modal, Popconfirm, Select, Space, Switch, Tag, Upload } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { RecordSelect } from './RecordSelect'
import { download, request, send, useResource, type Row } from './api'

type TeachingRow = {
  id: string
  class_id: string
  teacher_id: string
  teacher?: string
  className: string
  subjects?: string[]
  homeroom?: boolean | null
}

export function Teaching({
  classes,
  users,
  grades,
  reload,
}: {
  classes: Row[]
  users: Row[]
  grades: Row[]
  reload: () => Promise<any>
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [removingBatch, setRemovingBatch] = useState(false)

  const subjects = useResource<Row[]>('/subjects', [])
  const subjectTags = useResource<Row[]>('/subject-tags', [])
  const subjectChoices = [...new Set([...subjectTags.data.map(t => t.name), ...subjects.data.map(s => s.name)].filter(Boolean))].map(value => ({
    value,
  }))
  const label = (c: Row) => [grades.find(g => g.id === c.grade_id)?.name || c.grade, c.name].filter(Boolean).join(' · ')
  const rows: TeachingRow[] = useMemo(
    () =>
      classes.flatMap(c =>
        (c.teacher_ids || []).map((id: string) => ({
          id: `${c.id}:${id}`,
          class_id: c.id,
          teacher_id: id,
          teacher: users.find(u => u.id === id)?.name,
          className: label(c),
          ...c.teaching?.[id],
        })),
      ),
    [classes, users, grades],
  )
  const validSelected = useMemo(
    () => rows.filter(r => selectedIds.includes(r.id)),
    [rows, selectedIds],
  )

  function edit(row?: TeachingRow) {
    form.resetFields()
    form.setFieldsValue({ subjects: [], ...row, homeroom: row?.homeroom === true })
    setEditing(!!row)
    setOpen(true)
  }

  async function removeBatch() {
    if (!validSelected.length || busy) return
    setBusy(true)
    try {
      const result = await send<{ removed: number }>('/teaching/relations/remove', {
        items: validSelected.map(r => ({ teacher_id: r.teacher_id, class_id: r.class_id })),
      })
      message.success(`已移除 ${result.removed} 条任教关系`)
      setSelectedIds([])
      setRemovingBatch(false)
      await reload()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      {validSelected.length > 0 && (
        <div className="selection-action-bar">
          <span className="selection-action-summary">已选 {validSelected.length} 条任教关系</span>
          <Space size={8}>
            <Button danger size="small" onClick={() => setRemovingBatch(true)}>
              批量移除（{validSelected.length}）
            </Button>
            <Button size="small" type="text" onClick={() => setSelectedIds([])}>
              清空选择
            </Button>
          </Space>
        </div>
      )}
      <Table
        toolbar={
          <Space wrap>
            <Button onClick={() => download('/teaching/template', '教师任教关系.xlsx').catch(e => message.error(e.message))}>
              下载模板
            </Button>
            <TeacherImport classes={classes} users={users} grades={grades} reload={reload} />
            <Button type="primary" onClick={() => edit()}>
              设置任教关系
            </Button>
          </Space>
        }
        rowSelection={{
          selectedRowKeys: validSelected.map(r => r.id),
          onChange: keys => setSelectedIds(keys.map(String)),
        }}
        filterFields={[
          {
            key: 'grade',
            label: '年级',
            options: grades.map(g => ({ value: g.id, label: g.name })),
            values: r => [classes.find(c => c.id === r.class_id)?.grade_id || ''],
          },
          {
            key: 'class',
            label: '行政班',
            options: classes.map(c => ({ value: c.id, label: label(c) })),
            values: r => [r.class_id],
          },
          {
            key: 'subject',
            label: '科目',
            options: [...new Set(rows.flatMap(r => r.subjects || []))].map(name => ({ value: String(name), label: String(name) })),
            values: r => r.subjects || [],
          },
        ]}
        dataSource={rows}
        rowKey="id"
        columns={[
          { title: '教师', dataIndex: 'teacher' },
          { title: '行政班', dataIndex: 'className' },
          { title: '学科', render: (_, r) => r.subjects?.join('、') || '—' },
          { title: '班主任', render: (_, r) => (r.homeroom == null ? '待设置' : r.homeroom ? '是' : '否') },
          {
            title: '操作',
            render: (_, r) => (
              <Space>
                <Button onClick={() => edit(r)}>编辑</Button>
                <Popconfirm
                  title="移除这条任教关系？"
                  onConfirm={async () => {
                    try {
                      await send('/teaching/relation', { ...r, subjects: [], homeroom: false }, 'DELETE')
                      setSelectedIds(ids => ids.filter(id => id !== r.id))
                      await reload()
                    } catch (e) {
                      message.error((e as Error).message)
                    }
                  }}
                >
                  <Button danger>移除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={open}
        title="设置任教关系"
        confirmLoading={busy}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async v => {
            setBusy(true)
            try {
              await send('/teaching/relation', v, 'PUT')
              await reload()
              setOpen(false)
            } catch (e) {
              message.error((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Form.Item name="teacher_id" label="教师" rules={[{ required: true }]}>
            <RecordSelect
              title="教师"
              kind="users"
              disabled={editing}
              records={users.filter(u => u.role === 'teacher')}
              columns={[
                { title: '姓名', dataIndex: 'name' },
                { title: '账号', dataIndex: 'username' },
              ]}
              label={u => `${u.name} · ${u.username}`}
            />
          </Form.Item>
          <Form.Item name="class_id" label="行政班" rules={[{ required: true }]}>
            <RecordSelect
              title="行政班"
              kind="classes"
              disabled={editing}
              records={classes}
              label={label}
              fields={[{ key: 'grade', label: '年级', options: grades.map(g => ({ value: g.id, label: g.name })), values: c => [c.grade_id] }]}
              columns={[
                { title: '班级', dataIndex: 'name' },
                { title: '年级', render: (_, c) => grades.find(g => g.id === c.grade_id)?.name || c.grade },
              ]}
            />
          </Form.Item>
          <Form.Item name="subjects" label="任教学科">
            <Select mode="tags" options={subjectChoices} />
          </Form.Item>
          <Form.Item name="homeroom" label="担任该班班主任" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        open={removingBatch}
        title={`批量移除任教关系（${validSelected.length} 条）`}
        okText="确认移除"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: !validSelected.length }}
        confirmLoading={busy}
        onCancel={() => !busy && setRemovingBatch(false)}
        onOk={() => void removeBatch()}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Alert type="warning" showIcon message="移除后将解除所选教师与行政班的任教及班主任关系，教师账号与班级资料保留。" />
          <div className="delete-ref-list">
            {validSelected.slice(0, 80).map(item => (
              <div key={item.id} className="delete-ref-item">
                <div className="delete-ref-head">
                  <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
                    {item.teacher || item.teacher_id}
                  </Tag>
                  <span className="delete-ref-name">{item.className}</span>
                  {item.subjects?.length ? <Tag style={{ marginInlineEnd: 0 }}>{item.subjects.join('、')}</Tag> : null}
                </div>
              </div>
            ))}
          </div>
        </Space>
      </Modal>
    </Card>
  )
}

export function TeacherImport({
  classes,
  users,
  grades,
  reload,
}: {
  classes: Row[]
  users: Row[]
  grades: Row[]
  reload: () => Promise<any>
}) {
  const { message } = App.useApp()
  const [file, setFile] = useState<File>()
  const [report, setReport] = useState<any>()
  const [busy, setBusy] = useState(false)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [credentials, setCredentials] = useState<any[]>([])
  const label = (c: Row) => [grades.find(g => g.id === c.grade_id)?.name || c.grade, c.name].filter(Boolean).join(' · ')

  async function apply(next: File, commit: boolean) {
    setBusy(true)
    try {
      const data = new FormData()
      data.append('file', next)
      data.append('decisions', JSON.stringify(commit ? choices : {}))
      const res = await request('/teaching/import?commit=' + commit, { method: 'POST', body: data })
      if (res.saved) {
        setCredentials(res.created || [])
        setReport(undefined)
        await reload()
        message.success('任教关系已导入')
      } else {
        if (!commit) setChoices({})
        setFile(next)
        setReport(res)
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Upload
        showUploadList={false}
        accept=".csv,.xlsx"
        beforeUpload={f => {
          void apply(f, false)
          return false
        }}
      >
        <Button loading={busy}>导入任课表</Button>
      </Upload>
      <Modal
        open={!!report}
        title="任教关系导入预览"
        onCancel={() => setReport(undefined)}
        okText="创建账号并导入已匹配关系"
        confirmLoading={busy}
        okButtonProps={{
          disabled: !!report?.errors.length || !(report?.count || report?.planned?.length || Object.values(choices).some(Boolean)),
        }}
        onOk={() => file && apply(file, true)}
      >
        {!!report?.planned?.length && <p>预计新建 {report.planned.length} 个普通教师账号，初始密码在导入完成后下载。</p>}
        {!!report?.pending?.length && (
          <Table<Row>
            rowKey="cell"
            size="small"
            dataSource={report.pending}
            columns={[
              { title: '重名教师', dataIndex: 'name' },
              { title: '原表安排', dataIndex: 'description' },
              {
                title: '确认身份',
                render: (_, r) => (
                  <Select
                    style={{ minWidth: 180 }}
                    value={choices[r.cell] || ''}
                    onChange={v => setChoices({ ...choices, [r.cell]: v })}
                    options={[
                      { value: '', label: '暂缓导入' },
                      ...r.accounts.map((a: any) => ({ value: a.id, label: a.username })),
                      { value: 'new', label: '同名行共建一个账号' },
                      { value: 'separate', label: '为此行单独建号' },
                    ]}
                  />
                ),
              },
            ]}
          />
        )}
        <p>共匹配 {report?.count} 条教师与行政班关系。导入后更新这些关系的任教学科。</p>
        <Table
          rowKey={r => r.teacher_id + r.class_id}
          size="small"
          dataSource={report?.relations || []}
          pagination={{ defaultPageSize: 50 }}
          columns={[
            {
              title: '教师',
              render: (_, r) =>
                users.find(u => u.id === r.teacher_id)?.name || report.planned?.find((u: any) => u.id === r.teacher_id)?.name,
            },
            {
              title: '行政班',
              render: (_, r) => {
                const c = classes.find(v => v.id === r.class_id)
                return c ? label(c) : ''
              },
            },
            { title: '学科', render: (_, r) => r.subjects.join('、') },
            { title: '班主任', render: (_, r) => (r.homeroom == null ? '待设置' : r.homeroom ? '是' : '否') },
          ]}
        />
        {!!report?.skipped?.length && <p>跳过 {report.skipped.length} 项</p>}
        <div style={{ maxHeight: 300, overflow: 'auto' }}>
          {[...(report?.errors || []), ...(report?.skipped || [])].map((s, i) => (
            <div key={i}>{s}</div>
          ))}
        </div>
      </Modal>
      <Modal
        open={!!credentials.length}
        title="教师账号已创建"
        closable={false}
        maskClosable={false}
        footer={
          <Button
            onClick={() => {
              const text = credentials
                .map(c => [c.name, c.username, c.password].map(v => '"' + String(v).replaceAll('"', '""') + '"').join(','))
                .join('\r\n')
              const url = URL.createObjectURL(new Blob(['\ufeff姓名,账号,初始密码\r\n' + text], { type: 'text/csv;charset=utf-8' }))
              const link = document.createElement('a')
              link.href = url
              link.download = '新建教师账号.csv'
              link.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
              setCredentials([])
            }}
          >
            下载账号清单
          </Button>
        }
      >
        本次新建 {credentials.length} 个账号。请保存清单后分别交给相应教师。
      </Modal>
    </>
  )
}
