import { useMemo, useState } from 'react'
import { Segmented, Select, Space, Tag, Typography } from 'antd'
import { ExportPreviewModal, type ReportColumn } from './ReportToolkit'
import type { Row } from './api'

const fields: [string, string][] = [
  ['project', '考试'],
  ['subject', '科目'],
  ['grade', '年级'],
  ['label', '范围'],
  ['analyzed', '统计人数'],
  ['average', '平均分'],
  ['score_rate', '平均得分率%'],
  ['pass_rate', '及格率%'],
  ['excellent_rate', '优秀率%'],
  ['full_score', '满分'],
]

const columns: ReportColumn[] = fields.map(([key, label]) => ({ key, label }))
const chartMetrics = new Set(['average', 'analyzed', 'score_rate', 'pass_rate', 'excellent_rate'])
const isRateMetric = (metric: string) => metric === 'score_rate' || metric === 'pass_rate' || metric === 'excellent_rate'

function shortScopeLabel(row: Row, index: number) {
  const parts = [row.project, row.label && row.label !== row.subject ? row.label : row.subject].filter(Boolean)
  const raw = parts.join(' · ') || `第 ${index + 1} 项`
  return raw.length > 14 ? `${raw.slice(0, 13)}…` : raw
}

function formatMetricValue(value: unknown, metric: string) {
  if (value === null || value === undefined) return '—'
  return isRateMetric(metric) ? `${value}%` : String(value)
}

export function ComparisonExport({ ids, onClose, initialFormat = 'xlsx' }: { ids: string[]; onClose: () => void; initialFormat?: string }) {
  const baseParams = useMemo(() => new URLSearchParams({ scope_ids: ids.join(',') }), [ids])
  return (
    <ExportPreviewModal
      title="对比导出预览"
      open
      onClose={onClose}
      columns={columns}
      previewPath="/comparison"
      baseParams={baseParams}
      rowKey="id"
      filenameBase="多次对比"
      initialFormat={initialFormat === 'csv' ? 'csv' : 'xlsx'}
      paginated={false}
      description="预览与下载使用相同的对比范围顺序、导出列及内容摘要；数据变化后需要重新预览。"
    />
  )
}

export function ComparisonChart({ rows }: { rows: Row[] }) {
  const [metric, setMetric] = useState('score_rate')
  const [mode, setMode] = useState<'bar' | 'line'>('bar')
  const [hovered, setHovered] = useState<number | null>(null)

  const numericValues = rows.map(r => (r[metric] === null || r[metric] === undefined ? null : Number(r[metric])))
  const validValues = numericValues.filter((v): v is number => v !== null && Number.isFinite(v))
  const rawMax = validValues.length ? Math.max(...validValues) : 1
  const max = isRateMetric(metric) ? Math.max(100, rawMax) : Math.max(1, rawMax * 1.1)

  const slotWidth = Math.max(88, Math.min(140, 820 / Math.max(1, rows.length)))
  const leftPad = 58
  const rightPad = 24
  const topPad = 28
  const bottomPad = rows.length > 6 ? 78 : 58
  const plotHeight = 210
  const width = Math.max(760, leftPad + rightPad + rows.length * slotWidth)
  const height = topPad + plotHeight + bottomPad

  const point = (value: number | null, i: number) => ({
    x: leftPad + (i + 0.5) * ((width - leftPad - rightPad) / Math.max(1, rows.length)),
    y: topPad + plotHeight - (plotHeight * Math.max(0, value ?? 0)) / max,
  })

  const activeIndex = hovered !== null && hovered < rows.length ? hovered : 0
  const activeRow = rows[activeIndex]
  const metricLabel = fields.find(([key]) => key === metric)?.[1] || metric

  return (
    <div className="comparison-chart-box">
      <div className="comparison-chart-header">
        <Space wrap>
          <Select
            aria-label="对比指标"
            value={metric}
            onChange={setMetric}
            options={fields.filter(([key]) => chartMetrics.has(key)).map(([value, label]) => ({ value, label }))}
          />
          <Segmented<'bar' | 'line'>
            aria-label="图表类型"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'bar', label: '柱状图 · 横向对比' },
              { value: 'line', label: '折线图 · 纵向趋势' },
            ]}
          />
        </Space>
        {activeRow && (
          <Space size={6} wrap className="comparison-chart-focus">
            <Tag color="blue">#{activeIndex + 1}</Tag>
            <Typography.Text type="secondary">
              {[activeRow.project, activeRow.subject, activeRow.grade, activeRow.label].filter(Boolean).join(' / ')}
            </Typography.Text>
            <Typography.Text strong className="numeric-cell">
              {metricLabel}：{formatMetricValue(activeRow[metric], metric)}
            </Typography.Text>
          </Space>
        )}
      </div>

      <div className="comparison-chart-scroll">
        <svg role="img" aria-label="考试成绩对比图" viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', minWidth: Math.min(width, 640), height: 320 }}>
          {[0, 0.25, 0.5, 0.75, 1].map(t => {
            const y = topPad + plotHeight * (1 - t)
            const tick = max * t
            return (
              <g key={t}>
                <line x1={leftPad} x2={width - rightPad} y1={y} y2={y} stroke="#e6ebf2" strokeDasharray={t === 0 ? undefined : '3 3'} />
                <text x={leftPad - 8} y={y + 4} textAnchor="end" fontSize={11} fill="#595959">
                  {isRateMetric(metric) ? `${Math.round(tick)}%` : tick.toFixed(tick >= 100 ? 0 : 1)}
                </text>
              </g>
            )
          })}

          {mode === 'line' &&
            rows.slice(1).map((r, i) => {
              const prev = numericValues[i]
              const curr = numericValues[i + 1]
              if (prev === null || curr === null) return null
              const a = point(prev, i)
              const b = point(curr, i + 1)
              return <line key={r.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#0866ff" strokeWidth={2.5} />
            })}

          {rows.map((r, i) => {
            const val = numericValues[i]
            const p = point(val, i)
            const barWidth = Math.min(44, ((width - leftPad - rightPad) / Math.max(1, rows.length)) * 0.52)
            const isHighlighted = hovered === i
            const xLabel = shortScopeLabel(r, i)
            const rotate = rows.length > 6
            return (
              <g
                key={r.id}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              >
                <title>
                  #{i + 1} {[r.project, r.subject, r.grade, r.label].filter(Boolean).join(' / ')}：{formatMetricValue(r[metric], metric)}
                </title>
                {val !== null &&
                  (mode === 'bar' ? (
                    <rect
                      x={p.x - barWidth / 2}
                      y={p.y}
                      width={barWidth}
                      height={Math.max(2, topPad + plotHeight - p.y)}
                      rx={3}
                      fill={isHighlighted ? '#004fc4' : '#0866ff'}
                    />
                  ) : (
                    <circle cx={p.x} cy={p.y} r={isHighlighted ? 6.5 : 5} fill="#0866ff" stroke="#fff" strokeWidth={2} />
                  ))}
                <text x={p.x} y={Math.max(16, p.y - 8)} textAnchor="middle" fontSize={12} fontWeight={isHighlighted ? 600 : 500} fill="#141414">
                  {formatMetricValue(r[metric], metric)}
                </text>
                <g transform={rotate ? `translate(${p.x}, ${topPad + plotHeight + 16}) rotate(-22)` : `translate(${p.x}, ${topPad + plotHeight + 18})`}>
                  <text textAnchor={rotate ? 'end' : 'middle'} fontSize={11} fill={isHighlighted ? '#0866ff' : '#434343'}>
                    {`${i + 1}. ${xLabel}`}
                  </text>
                </g>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
