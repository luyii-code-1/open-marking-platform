import { useId, useState } from 'react'
import { Alert, App, Form, Modal, Radio, Select, Space, Typography } from 'antd'
import { DownOutlined, DownloadOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { download } from './api'

type Report = 'items' | 'students' | 'classes' | 'questions' | 'distribution' | 'summary'
type ExportScope =
  | { kind: 'card'; id: string; query: URLSearchParams; roomId?: string; studentCount: number }
  | { kind: 'project'; id: string; cardCount: number }

const reports: Record<Report, string> = {
  items: '小题分明细', students: '考生成绩与排名', classes: '班级统计',
  questions: '单题分析', distribution: '分数分布', summary: '跨科成绩汇总',
}
const cardReports: Report[] = ['items', 'students', 'classes', 'questions', 'distribution']
const projectReports: Report[] = ['items', 'summary']

export function ResultExport({ scope, parts, room, disabled }: {
  scope: ExportScope
  parts: string[]
  room?: string
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<Report>('items')
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { message } = App.useApp()
  const reportId = useId()
  const projectBook = scope.kind === 'project' && report === 'items'
  const fileFormat = projectBook ? 'xlsx' : format
  const noCards = scope.kind === 'project' && scope.cardCount === 0
  const choices = scope.kind === 'project' ? projectReports : cardReports
  const detail = scope.kind === 'card' ? `${room || '全部考场'} · ${scope.studentCount} 名学生`
    : `${scope.cardCount} 张题卡${projectBook && scope.cardCount ? ' · 每张题卡一张工作表' : ''}`

  async function exportFile(selected: Report, extension: 'xlsx' | 'csv') {
    if (busy || disabled || (selected === 'items' && noCards)) return
    setBusy(true)
    setError('')
    try {
      let path: string
      let params: URLSearchParams
      if (scope.kind === 'project') {
        path = '/analysis/project/export'
        params = new URLSearchParams({ project_id: scope.id, view: selected })
      } else if (selected === 'items') {
        path = '/results/export'
        params = new URLSearchParams({ group_id: scope.id })
        if (scope.roomId) params.set('room_tag_id', scope.roomId)
      } else {
        path = '/analysis/group/export'
        params = new URLSearchParams(scope.query)
        params.set('view', selected)
      }
      params.set('format', extension)
      const name = [...parts, room, reports[selected]].filter(Boolean).join('-').replace(/[\\/:*?"<>|]/g, '－')
      await download(`${path}?${params}`, `${name}.${extension}`)
      setOpen(false)
    } catch (e) {
      const description = (e as Error).message
      if (open) setError(description)
      else message.error(description)
    } finally {
      setBusy(false)
    }
  }

  return <>
    <Space.Compact>
      <Button type="primary" icon={<DownloadOutlined />} loading={busy && !open} disabled={disabled || noCards}
        onClick={() => exportFile('items', 'xlsx')}>导出小题分</Button>
      <Button type="primary" icon={<DownOutlined />} aria-label="导出选项" aria-haspopup="dialog" title="导出选项"
        disabled={disabled || busy} onClick={() => {
          setReport(noCards ? 'summary' : 'items')
          setFormat('xlsx')
          setError('')
          setOpen(true)
        }}/>
    </Space.Compact>
    <Modal title="导出选项" open={open} width={460} okText="下载文件" cancelText="取消"
      onOk={() => exportFile(report, fileFormat)} confirmLoading={busy} okButtonProps={{ disabled: disabled || (projectBook && noCards) }} cancelButtonProps={{ disabled: busy }}
      maskClosable={!busy} keyboard={!busy} closable={!busy} onCancel={() => { if (!busy) setOpen(false) }}>
      <Form layout="vertical" component="div" className="result-export-form">
        <div className="result-export-scope">
          <Typography.Text strong>{parts.filter(Boolean).join(' / ')}</Typography.Text>
          <Typography.Text type="secondary">{detail}</Typography.Text>
        </div>
        <Form.Item label="导出内容" htmlFor={reportId}>
          <Select id={reportId} value={report} disabled={busy} onChange={value => { setReport(value); setError('') }}
            options={choices.map(value => ({ value, label: reports[value], disabled: value === 'items' && noCards }))} />
        </Form.Item>
        <Form.Item label="文件格式">
          {projectBook ? <Typography.Text>Excel 工作簿（.xlsx）</Typography.Text> :
            <Radio.Group aria-label="文件格式" value={fileFormat} disabled={busy} onChange={e => setFormat(e.target.value)}
              options={[{ label: 'Excel（.xlsx）', value: 'xlsx' }, { label: 'CSV', value: 'csv' }]} />}
        </Form.Item>
        {error && <Alert type="error" showIcon message={error} />}
      </Form>
    </Modal>
  </>
}
