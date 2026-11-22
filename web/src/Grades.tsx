import { useMemo, useState } from 'react'
import { App, Input, Modal, Space, Tag } from 'antd'
import { BatchDeleteButton, DeleteRecord } from './DeleteRecord'
import { GradeTag } from './SchoolTags'
import { Button } from './Button'
import { EntityTable } from './EntityTable'
import { send, useResource, type Row } from './api'

export function Grades({ onChanged }: { onChanged?: () => Promise<unknown> }) {
  const grades = useResource<Row[]>('/grades', [])
  const [editing, setEditing] = useState<Row | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const { message } = App.useApp()

  const validSelected = useMemo(
    () => selectedIds.filter(id => grades.data.some(g => g.id === id)),
    [selectedIds, grades.data],
  )

  const reloadAll = async () => {
    await grades.reload()
    await onChanged?.()
  }

  async function update(row: Row, body: object) {
    setBusy(true)
    try {
      await send(`/grades/${row.id}`, body, 'PUT')
      await reloadAll()
      setEditing(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <EntityTable
        path="/grades"
        title="年级"
        hideTitle
        resource={grades}
        fields={[{ name: 'name', label: '年级名称' }]}
        onCreated={reloadAll}
        rowSelection={{
          selectedRowKeys: validSelected,
          onChange: keys => setSelectedIds(keys.map(String)),
        }}
        selectionBar={
          validSelected.length > 0 && (
            <div className="selection-action-bar">
              <span className="selection-action-summary">已选 {validSelected.length} 个年级</span>
              <Space size={8}>
                <BatchDeleteButton
                  kind="grades"
                  ids={validSelected}
                  onDeleted={async () => {
                    setSelectedIds([])
                    await reloadAll()
                  }}
                />
                <Button size="small" type="text" onClick={() => setSelectedIds([])}>
                  清空选择
                </Button>
              </Space>
            </div>
          )
        }
        columns={[
          { title: '年级', dataIndex: 'name', render: n => <GradeTag name={n} /> },
          { title: '状态', render: (_, row) => <Tag>{row.archived ? '已停用' : '使用中'}</Tag> },
          {
            title: '操作',
            render: (_, row) => (
              <Space>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setEditing(row)
                    setName(row.name)
                  }}
                >
                  修改名称
                </Button>
                <Button disabled={busy} onClick={() => update(row, { archived: !row.archived })}>
                  {row.archived ? '启用' : '停用'}
                </Button>
                <DeleteRecord
                  kind="grades"
                  row={row}
                  reload={async () => {
                    setSelectedIds(ids => ids.filter(id => id !== row.id))
                    await reloadAll()
                  }}
                />
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title="修改年级名称"
        open={!!editing}
        onCancel={() => setEditing(null)}
        confirmLoading={busy}
        okButtonProps={{ disabled: !name.trim() }}
        onOk={() => editing && update(editing, { name: name.trim() })}
      >
        <Input value={name} maxLength={60} onChange={event => setName(event.target.value)} />
      </Modal>
    </>
  )
}
