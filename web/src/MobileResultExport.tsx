import { useState } from 'react'
import { App } from 'antd'
import { Button, Input, List, NoticeBar, Popup, Selector, Space, Stepper } from 'antd-mobile'
import { DownloadOutlined, DownOutlined } from '@ant-design/icons'
import { download, useResource } from './api'
import { useResultFilterOptions } from './ResultFilters'
import {
  formalReports,
  readResultFilters,
  resultExportExtension,
  resultExportRequest,
  withResultFilters,
  type ResultFilterValue,
  type ResultReport,
} from './resultFilterParams'

type ExportScope =
  | { kind: 'card'; id: string; query: URLSearchParams; roomId?: string; studentCount: number }
  | { kind: 'project'; id: string; query?: URLSearchParams; cardCount: number; studentCount?: number }

const reports: Record<ResultReport, string> = {
  workbook: '完整成绩分析（五表）',
  items: '小题分',
  averages: '小题均分对比',
  ranks: '名次段分析',
  bands: '分数段分析',
  students: '考生成绩与排名',
  classes: '班级统计',
  questions: '试题分析',
  distribution: '分数分布',
  summary: '跨科成绩汇总',
  ranking: '单科班级成绩与排名',
  'class-summary': '班级总表',
}
const cardReports: ResultReport[] = [...formalReports, 'ranking', 'students', 'classes', 'distribution']
const projectReports: ResultReport[] = [...formalReports, 'class-summary', 'summary']

export function MobileResultExport({
  scope,
  parts,
  room,
  disabled,
  initialReport = 'workbook',
  quickReport = 'workbook',
}: {
  quickReport?: ResultReport
  scope: ExportScope
  parts: string[]
  room?: string
  disabled: boolean
  initialReport?: ResultReport
}) {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<ResultReport>('items')
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState<ResultFilterValue>(() => readResultFilters(scope.query))
  const [step, setStep] = useState(10)
  const [ranks, setRanks] = useState('10,30,50,100,200')
  const { message } = App.useApp()
  const options = useResultFilterOptions(scope.kind, scope.id, open)

  const formal = formalReports.includes(report)
  const projectBook = scope.kind === 'project' && formal
  const fileFormat: 'xlsx' | 'csv' = formal ? 'xlsx' : format
  const noCards = scope.kind === 'project' && scope.cardCount === 0
  const choices = scope.kind === 'project' ? projectReports : cardReports
  const needsClasses = report === 'ranking' || report === 'class-summary'

  function queryFor(value: ResultFilterValue) {
    const params = withResultFilters(scope.query || new URLSearchParams(), value)
    params.set(scope.kind === 'card' ? 'group_id' : 'project_id', scope.id)
    params.set('score_step', open ? String(step) : scope.query?.get('score_step') || '10')
    params.set('ranks', open ? ranks : scope.query?.get('ranks') || '10,30,50,100,200')
    return params
  }

  const previewQuery = queryFor(filters)
  const previewPath = scope.kind === 'card' ? '/analysis/group' : report === 'class-summary' ? '/analysis/project/class-summary' : '/analysis/project'
  const preview = useResource<any>(open && scope.id ? `${previewPath}?${previewQuery}` : null, null)
  const matched = preview.loading ? undefined : scope.kind === 'card' ? preview.data?.summary?.records : preview.data?.students?.length

  async function exportFile(selected: ResultReport, extension: 'xlsx' | 'csv') {
    if (busy || disabled || (formalReports.includes(selected) && noCards)) return
    const value = open ? filters : readResultFilters(scope.query)
    if ((selected === 'ranking' || selected === 'class-summary') && !value.classIds.length) {
      setError('请先选择要导出的班级')
      return
    }
    setBusy(true)
    setError('')
    try {
      const { path, params } = resultExportRequest(scope.kind, scope.id, queryFor(value), selected, extension)
      const name = [...parts, room, reports[selected]].filter(Boolean).join('-').replace(/[\\/:*?"<>|]/g, '－')
      await download(`${path}?${params}`, `${name}.${resultExportExtension(scope.kind, selected, extension)}`)
      setOpen(false)
    } catch (err) {
      const description = (err as Error).message
      if (open) setError(description)
      else message.error(description)
    } finally {
      setBusy(false)
    }
  }

  function openOptions() {
    setReport(noCards ? 'summary' : initialReport)
    setFormat('xlsx')
    setFilters(readResultFilters(scope.query))
    setStep(Number(scope.query?.get('score_step')) || 10)
    setRanks(scope.query?.get('ranks') || '10,30,50,100,200')
    setError('')
    setOpen(true)
  }

  const classOptions = (options.data.classes || []).map((c: any) => ({ label: c.name, value: c.id }))

  return (
    <>
      <Space style={{ '--gap': '6px' }}>
        <Button size="mini" color="primary" loading={busy && !open} disabled={disabled || noCards} onClick={() => void exportFile(quickReport, 'xlsx')}>
          <DownloadOutlined /> 导出
        </Button>
        <Button size="mini" fill="outline" aria-label="导出选项" disabled={disabled || busy} onClick={openOptions}>
          <DownOutlined />
        </Button>
      </Space>

      <Popup
        visible={open}
        onMaskClick={() => { if (!busy) setOpen(false) }}
        position="bottom"
        bodyStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '82dvh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="m-adm-popup-head">
          <strong>导出成绩报表</strong>
          <Button size="mini" fill="none" disabled={busy} onClick={() => setOpen(false)}>关闭</Button>
        </div>
        <div className="m-adm-popup-body">
          <div style={{ fontSize: 13, color: 'var(--adm-color-text-secondary)' }}>
            {parts.filter(Boolean).join(' / ')}{matched !== undefined ? ` · 匹配 ${matched} 人` : ''}
          </div>

          <div>
            <div style={{ fontSize: 13, color: 'var(--adm-color-text-secondary)', marginBottom: 6 }}>导出内容</div>
            <Selector
              columns={2}
              value={[report]}
              options={choices.map(v => ({ label: reports[v], value: v, disabled: formalReports.includes(v) && noCards }))}
              onChange={arr => { if (arr[0]) { setReport(arr[0] as ResultReport); setError('') } }}
            />
          </div>

          <div>
            <div style={{ fontSize: 13, color: 'var(--adm-color-text-secondary)', marginBottom: 6 }}>文件格式</div>
            {formal ? (
              <div style={{ fontSize: 13, color: 'var(--adm-color-text)' }}>
                {projectBook ? 'ZIP 压缩包（每张题卡一个 Excel 文件）' : 'Excel 工作簿（.xlsx）'}
              </div>
            ) : (
              <Selector
                columns={2}
                value={[fileFormat]}
                options={[{ label: 'Excel (.xlsx)', value: 'xlsx' }, { label: 'CSV', value: 'csv' }]}
                onChange={arr => arr[0] && setFormat(arr[0] as 'xlsx' | 'csv')}
              />
            )}
          </div>

          {classOptions.length > 0 && (
            <div>
              <div style={{ fontSize: 13, color: 'var(--adm-color-text-secondary)', marginBottom: 6 }}>导出班级范围</div>
              <Selector
                multiple
                columns={3}
                value={filters.classIds}
                options={classOptions}
                onChange={classIds => setFilters(prev => ({ ...prev, classIds }))}
              />
            </div>
          )}

          {formal && (
            <List header="统计设置">
              <List.Item
                title="分数段间隔"
                extra={<Stepper min={0.5} max={1000} step={1} value={step} onChange={v => setStep(v || 10)} />}
              />
              <List.Item title="累计名次">
                <Input value={ranks} onChange={setRanks} placeholder="10,30,50,100,200" />
              </List.Item>
            </List>
          )}

          {needsClasses && !filters.classIds.length && (
            <NoticeBar color="info" wrap content="请至少选择一个班级后再导出；Excel 按班级分工作表。" />
          )}
          {(error || preview.error || options.error) && (
            <NoticeBar color="error" wrap content={error || preview.error || options.error} />
          )}

          <Button
            block
            color="primary"
            size="large"
            loading={busy}
            disabled={disabled || (projectBook && noCards) || (needsClasses && !filters.classIds.length) || preview.loading || !!preview.error || !!options.error}
            onClick={() => void exportFile(report, fileFormat)}
          >
            下载文件
          </Button>
        </div>
      </Popup>
    </>
  )
}
