import { useEffect, useState } from 'react'
import { App, Card, Col, InputNumber, Popconfirm, Progress, Row as GridRow, Space, Statistic, Typography } from 'antd'
import { DeleteOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { Table } from './DataTable'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { download, send, useResource } from './api'

type StorageSummary = {
  disk: { total: number; used: number; free: number }
  data_root: string
  tracked_bytes: number
  breakdown: { key: string; label: string; bytes: number; files: number }[]
  logs: {
    request_log_count: number
    request_log_oldest?: string | null
    audit_count: number
    retention_days: number
  }
}

const emptySummary: StorageSummary = {
  disk: { total: 0, used: 0, free: 0 },
  data_root: '',
  tracked_bytes: 0,
  breakdown: [],
  logs: { request_log_count: 0, audit_count: 0, retention_days: 30 },
}

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let idx = 0
  let val = bytes
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`
}

export function SystemStorage() {
  const resource = useResource<StorageSummary>('/system/storage-summary', emptySummary)
  const [retentionDays, setRetentionDays] = useState<number>(30)
  const [exportDays, setExportDays] = useState<number>(30)
  const [busy, setBusy] = useState('')
  const { message } = App.useApp()

  useEffect(() => {
    if (resource.loaded) {
      setRetentionDays(resource.data.logs.retention_days ?? 30)
    }
  }, [resource.loaded, resource.data.logs.retention_days])

  const disk = resource.data.disk
  const usedPercent = disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : 0

  async function saveRetention() {
    setBusy('save')
    try {
      await send('/system/log-retention', { retention_days: retentionDays }, 'PUT')
      message.success(retentionDays === 0 ? '已设为不限制日志保留天数' : `已设置仅保留最近 ${retentionDays} 天日志`)
      await resource.reload()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function cleanup(days: number) {
    setBusy(days === 0 ? 'clear-all' : 'clear-old')
    try {
      const res = await send<{ deleted_request_logs: number; deleted_files: number; freed_bytes: number }>('/system/logs/cleanup', { days })
      message.success(`清理完成：移除 ${res.deleted_request_logs} 条访问日志、${res.deleted_files} 个日志文件（释放 ${formatBytes(res.freed_bytes)}）`)
      await resource.reload()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function downloadLogs() {
    setBusy('export')
    try {
      await download(`/system/logs/export?days=${exportDays}`, `omp-logs-${exportDays}d.zip`)
      message.success('日志包已开始下载')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <ErrorNotice error={resource.error} retry={resource.reload} />
      <Card
        title="磁盘与数据目录占用"
        extra={
          <Button icon={<ReloadOutlined />} loading={resource.loading} onClick={() => void resource.reload()}>
            刷新
          </Button>
        }
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <GridRow gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Statistic title="磁盘总容量" value={formatBytes(disk.total)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="已用空间" value={formatBytes(disk.used)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="剩余可用" value={formatBytes(disk.free)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="数据目录已追踪" value={formatBytes(resource.data.tracked_bytes)} />
            </Col>
          </GridRow>
          <Progress percent={usedPercent} status={usedPercent >= 90 ? 'exception' : 'normal'} />
          <Table<{ key: string; label: string; bytes: number; files: number }>
            rowKey="key"
            pagination={false}
            loading={resource.loading}
            dataSource={resource.data.breakdown}
            columns={[
              { title: '目录类别', dataIndex: 'label' },
              { title: '文件数', dataIndex: 'files', align: 'right' },
              { title: '占用空间', dataIndex: 'bytes', align: 'right', render: (b: number) => formatBytes(b) },
            ]}
          />
        </Space>
      </Card>

      <Card title="系统日志管理（清理、保留策略与打包下载）">
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <GridRow gutter={[16, 16]}>
            <Col xs={12} md={8}>
              <Statistic title="HTTP 访问日志条数" value={resource.data.logs.request_log_count} />
            </Col>
            <Col xs={12} md={8}>
              <Statistic title="业务审计记录条数" value={resource.data.logs.audit_count} />
            </Col>
            <Col xs={24} md={8}>
              <Statistic title="当前日志保留策略" value={retentionDays === 0 ? '不限制' : `${retentionDays} 天`} />
            </Col>
          </GridRow>

          <Space wrap align="center">
            <Typography.Text>只保留最近天数：</Typography.Text>
            <InputNumber min={0} max={3650} value={retentionDays} onChange={v => setRetentionDays(typeof v === 'number' ? v : 30)} />
            <Typography.Text type="secondary">天（设为 0 表示不限制）</Typography.Text>
            <Button type="primary" loading={busy === 'save'} disabled={!!busy && busy !== 'save'} onClick={saveRetention}>
              保存保留天数
            </Button>
          </Space>

          <Space wrap align="center">
            <Popconfirm
              title={`清理 ${retentionDays} 天前的历史日志？`}
              description="将清理超过保留天数的 HTTP 访问日志与日志文件，业务审计记录保持完整。"
              onConfirm={() => cleanup(retentionDays)}
            >
              <Button icon={<DeleteOutlined />} disabled={!!busy || retentionDays === 0} loading={busy === 'clear-old'}>
                立即清理 {retentionDays} 天前日志
              </Button>
            </Popconfirm>
            <Popconfirm
              title="清空全部 HTTP 访问日志与日志文件？"
              description="操作不可恢复（业务审计记录仍保留），建议先打包下载备份。"
              onConfirm={() => cleanup(0)}
            >
              <Button danger icon={<DeleteOutlined />} disabled={!!busy} loading={busy === 'clear-all'}>
                清空全部访问日志
              </Button>
            </Popconfirm>
          </Space>

          <Space wrap align="center">
            <Typography.Text>打包下载最近：</Typography.Text>
            <InputNumber min={0} max={3650} value={exportDays} onChange={v => setExportDays(typeof v === 'number' ? v : 30)} />
            <Typography.Text type="secondary">天日志（0 为全部）</Typography.Text>
            <Button icon={<DownloadOutlined />} loading={busy === 'export'} disabled={!!busy && busy !== 'export'} onClick={downloadLogs}>
              打包并下载日志（.zip）
            </Button>
          </Space>
        </Space>
      </Card>
    </Space>
  )
}
