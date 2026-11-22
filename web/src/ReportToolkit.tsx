import { useState, type ReactNode } from 'react'
import { Alert, App, Modal, Select, Space, Tag, Typography, type TableColumnsType } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { MultipleRecordSelect } from './RecordSelect'
import { ApiError, download, useResource, type Row } from './api'

export type ReportColumn = { key: string; label: string }
export type FilterChip = { key: string; label: string; onRemove: () => void }

type FilterSummaryBarProps = {
  chips: FilterChip[]
  onReset?: () => void
  summary?: ReactNode
}

export function FilterSummaryBar({ chips, onReset, summary }: FilterSummaryBarProps) {
  if (!chips.length && !summary) return null
  return (
    <div className="filter-summary-bar">
      {chips.length > 0 && (
        <div className="record-picker-tags" aria-label="当前筛选条件">
          {chips.map(chip => (
            <Tag key={chip.key} closable onClose={chip.onRemove}>
              {chip.label}
            </Tag>
          ))}
          {onReset && (
            <Button type="link" size="small" onClick={onReset}>
              重置条件
            </Button>
          )}
        </div>
      )}
      {summary && <Typography.Text type="secondary" className="filter-summary-count">{summary}</Typography.Text>}
    </div>
  )
}

type PreviewPayload = {
  rows: Row[]
  columns: ReportColumn[]
  total?: number
  version?: string
}

type ExportPreviewModalProps = {
  title: string
  open: boolean
  onClose: () => void
  columns: ReportColumn[]
  previewPath: string
  baseParams: URLSearchParams
  rowKey: string
  filenameBase: string
  initialFormat?: 'xlsx' | 'csv'
  paginated?: boolean
  description?: string
  renderCell?: (value: unknown, row: Row, key: string) => ReactNode
}

const emptyPreview: PreviewPayload = { rows: [], columns: [], total: 0, version: '' }

export function ExportPreviewModal({
  title,
  open,
  onClose,
  columns,
  previewPath,
  baseParams,
  rowKey,
  filenameBase,
  initialFormat = 'xlsx',
  paginated = true,
  description,
  renderCell,
}: ExportPreviewModalProps) {
  const [selected, setSelected] = useState(() => columns.map(c => c.key))
  const [page, setPage] = useState(1)
  const [format, setFormat] = useState<'xlsx' | 'csv'>(initialFormat)
  const [busy, setBusy] = useState(false)
  const [staleNotice, setStaleNotice] = useState('')
  const { message } = App.useApp()

  const params = new URLSearchParams(baseParams)
  params.set('columns', selected.join(','))
  if (paginated) params.set('page', String(page))

  const preview = useResource<PreviewPayload>(open && selected.length ? `${previewPath}?${params}` : null, emptyPreview)
  const rows = preview.data?.rows || []
  const previewColumns = preview.data?.columns || []
  const total = preview.data?.total ?? rows.length
  const version = preview.data?.version || ''

  async function handleDownload() {
    if (!selected.length || !version || busy) return
    setBusy(true)
    setStaleNotice('')
    try {
      const downloadParams = new URLSearchParams(params)
      downloadParams.set('format', format)
      downloadParams.set('preview_version', version)
      await download(`${previewPath}?${downloadParams}`, `${filenameBase}.${format}`)
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : '下载失败'
      if (e instanceof ApiError && e.status === 409) {
        setStaleNotice('数据或条件已更新，已重新拉取最新预览；请核对后再次下载。')
      } else {
        message.error(errorMessage)
      }
      await preview.reload()
    } finally {
      setBusy(false)
    }
  }

  const tableColumns: TableColumnsType<Row> = previewColumns.map(col => ({
    key: col.key,
    title: col.label,
    dataIndex: col.key,
    sorter: false as const,
    render: (value: unknown, row: Row) =>
      renderCell ? renderCell(value, row, col.key) : value === null || value === undefined ? '—' : String(value),
  }))

  return (
    <Modal
      title={title}
      width="90vw"
      open={open}
      onCancel={() => !busy && onClose()}
      onOk={handleDownload}
      okText="下载"
      cancelText="关闭"
      confirmLoading={busy}
      maskClosable={!busy}
      closable={!busy}
      cancelButtonProps={{ disabled: busy }}
      okButtonProps={{ disabled: !selected.length || !preview.loaded || preview.loading || !!preview.error || !version }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap align="center">
          <MultipleRecordSelect
            title="导出列"
            records={columns.map(c => ({ id: c.key, name: c.label }))}
            value={selected}
            disabled={busy}
            onChange={ids => {
              setSelected(ids)
              setPage(1)
              setStaleNotice('')
            }}
          />
          {selected.length < columns.length && (
            <Button
              size="small"
              disabled={busy}
              onClick={() => {
                setSelected(columns.map(c => c.key))
                setPage(1)
                setStaleNotice('')
              }}
            >
              全选列
            </Button>
          )}
          <Select
            aria-label="导出格式"
            value={format}
            disabled={busy}
            onChange={v => setFormat(v)}
            options={[
              { value: 'xlsx', label: 'Excel（.xlsx）' },
              { value: 'csv', label: 'CSV（.csv）' },
            ]}
          />
          <Button size="small" disabled={busy || !selected.length} loading={preview.loading} onClick={() => void preview.reload()}>
            刷新预览
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {description || '预览与下载使用相同的筛选条件、导出列及内容摘要；数据变化后需要重新预览。'}
          {selected.length > 0 ? ` 共 ${total} 行。` : ' 请至少选择一列以预览。'}
        </Typography.Paragraph>
        {!selected.length && <Alert type="info" showIcon message="请至少选择一个导出列。" />}
        {staleNotice && <Alert type="warning" showIcon message={staleNotice} />}
        <ErrorNotice error={preview.error} retry={preview.reload} />
        <Table
          query=""
          columnChooser={false}
          rowKey={rowKey}
          loading={preview.loading}
          dataSource={preview.loading ? [] : rows}
          columns={tableColumns}
          pagination={
            paginated
              ? { current: page, pageSize: 50, total, onChange: setPage, showSizeChanger: false }
              : { defaultPageSize: 50, showSizeChanger: true }
          }
        />
      </Space>
    </Modal>
  )
}
