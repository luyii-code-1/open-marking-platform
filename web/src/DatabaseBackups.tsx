import { useState } from 'react'
import { App, Card, Popconfirm, Space, Switch, Typography } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { download, send, useResource } from './api'

type Backup = { id: string; filename: string; origin: string; size: number; created_at: number; available: boolean }
type Policy = { enabled: boolean; next_run: number | null }
const origins: Record<string, string> = {
  manual: '手动备份', automatic: '自动备份', registered: '已登记备份', deployment: '发布前备份', external: '外部备份',
}
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

export function DatabaseBackups() {
  const backups = useResource<Backup[]>('/system/backups', [], { live: false })
  const policy = useResource<Policy | null>('/system/backup-settings', null, { live: false })
  const { message } = App.useApp()
  const [busy, setBusy] = useState('')

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key)
    try { await action() }
    catch (e) { message.error((e as Error).message) }
    finally { setBusy('') }
  }
  async function setAutomatic(enabled: boolean) {
    const value = await send<Policy>('/system/backup-settings', { enabled }, 'PUT')
    policy.setData(value)
  }
  async function create() {
    await send('/system/backup')
    await backups.reload()
    message.success('备份已创建')
  }
  async function remove(row: Backup) {
    await send('/system/backups/' + row.id, undefined, 'DELETE')
    await backups.reload()
    message.success('备份已删除')
  }
  return <Card title="数据库备份" extra={<Space><Button disabled={!!busy} loading={backups.loading} onClick={() => { void policy.reload(); void backups.reload() }}>刷新</Button><Button type="primary" loading={busy === 'create'} disabled={!!busy} onClick={() => run('create', create)}>立即备份</Button></Space>}>
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <ErrorNotice error={policy.error || backups.error} retry={() => Promise.all([policy.reload(), backups.reload()])} />
      <Space wrap>
        <label htmlFor="automatic-database-backup">每日自动备份</label>
        <Switch id="automatic-database-backup" checked={!!policy.data?.enabled} loading={busy === 'policy'}
          disabled={!!busy || !policy.data || !!policy.error}
          onChange={enabled => run('policy', () => setAutomatic(enabled))} />
        <Typography.Text type="secondary">每天 03:00（北京时间）{policy.data?.next_run ? '，下次备份 ' + date(policy.data.next_run) : ''}</Typography.Text>
      </Space>
      <Table<Backup> rowKey="id" size="small" loading={backups.loading} dataSource={backups.data}
        pagination={{ defaultPageSize: 50, hideOnSinglePage: true }} scroll={{ x: 760 }} columns={[
          { title: '文件名', dataIndex: 'filename', ellipsis: true },
          { title: '来源', width: 110, dataIndex: 'origin', render: (value: string) => origins[value] || value },
          { title: '时间（北京）', width: 175, dataIndex: 'created_at', render: date },
          { title: '大小', width: 100, dataIndex: 'size', render: (size: number) => (size / 1048576).toFixed(1) + ' MiB' },
          { title: '操作', width: 150, render: (_, row) => <Space size={4}>
            <Button type="link" disabled={!!busy || !row.available} loading={busy === 'get-' + row.id}
              onClick={() => run('get-' + row.id, () => download('/system/backups/' + row.id + '/download', row.filename))}>
              {row.available ? '下载' : '文件缺失'}
            </Button>
            <Popconfirm title="删除这份数据库备份？" description={row.filename} okText="删除" cancelText="取消"
              onConfirm={() => run('delete-' + row.id, () => remove(row))}>
              <Button type="text" danger disabled={!!busy} loading={busy === 'delete-' + row.id}>删除</Button>
            </Popconfirm>
          </Space> },
        ]} />
    </Space>
  </Card>
}
