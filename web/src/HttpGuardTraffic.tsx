import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Card, Input, Select, Space, Spin, Typography } from 'antd'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { useResource } from './api'
import { bytes, guardApi } from './httpGuardData'
import {
  countBuckets, eventsForBucket, intervalLabels, metricLabels, parseShanghaiMinute, presetLabels, presetRange,
  readTrafficRange, shanghaiMinute, trafficHash, type Interval, type Metric, type Preset, type Timeline, type TrafficRange,
} from './httpGuardTime'
import './http-guard-traffic.css'

const formatCount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
const metrics = Object.keys(metricLabels) as Metric[]
const timestamp = (ts: number) => shanghaiMinute(ts).replace('T', ' ')
const shortTime = (ts: number) => timestamp(ts).slice(5)

function metricValue(metric: Metric, value: number | null) {
  if (value === null) return metric === 'avg_ms' ? '无耗时样本' : '未采集'
  if (metric === 'bytes_out') return bytes(value)
  return formatCount.format(value) + (metric === 'avg_ms' ? ' ms' : '')
}
function rangeText(start: number, end: number) {
  const from = timestamp(start), until = timestamp(end)
  return from + ' 至 ' + (from.slice(0, 10) === until.slice(0, 10) ? until.slice(11) : until)
}

function TimeControls({ range, onApply, invalid }: { range: TrafficRange; onApply: (range: TrafficRange) => void; invalid: boolean }) {
  const [editing, setEditing] = useState(range.preset === 'custom' || invalid)
  const [from, setFrom] = useState(shanghaiMinute(range.start)), [until, setUntil] = useState(shanghaiMinute(range.end))
  const [granularity, setGranularity] = useState(range.interval), [error, setError] = useState('')
  const customStart = parseShanghaiMinute(from), customEnd = parseShanghaiMinute(until)
  const draft = editing && customStart !== null && customEnd !== null ? { start: customStart, end: customEnd } : range
  const dense = countBuckets(draft, granularity) > 400
  function choosePreset(key: Preset) {
    setError(''); setEditing(key === 'custom')
    if (key === 'custom') return
    const next = presetRange(key)
    setGranularity(next.interval); setFrom(shanghaiMinute(next.start)); setUntil(shanghaiMinute(next.end))
    onApply(next)
  }
  function applyCustom() {
    if (customStart === null || customEnd === null || customEnd <= customStart) { setError('请选择有效的起止时间，结束须晚于开始。'); return }
    if (customStart >= (Math.floor(Date.now() / 60000) + 1) * 60) { setError('开始时间须在当前分钟或更早。'); return }
    if (customEnd > (Math.floor(Date.now() / 60000) + 1) * 60) { setError('结束时间不能超过当前分钟的结束时间。'); return }
    if (dense) { setError('此范围超过 400 个时段，请调大粒度或缩短范围。'); return }
    setError(''); onApply({ preset: 'custom', start: customStart, end: customEnd, interval: granularity })
  }
  return <Card size="small"><div className="traffic-time-controls">
    <div className="traffic-time-row">
      <div className="traffic-presets" role="group" aria-label="统计时间范围">
        {(Object.keys(presetLabels) as Preset[]).map(key => <Button key={key}
          type={(editing ? 'custom' : range.preset) === key ? 'primary' : 'default'} aria-pressed={(editing ? 'custom' : range.preset) === key}
          onClick={() => choosePreset(key)}>
          {presetLabels[key]}
        </Button>)}
      </div>
      <Space><label htmlFor="traffic-interval">统计粒度</label>
        <Select<Interval> id="traffic-interval" className="traffic-interval" value={granularity}
          onChange={value => { setGranularity(value); setError(''); if (!editing) onApply({ ...range, interval: value }) }}
          options={(Object.keys(intervalLabels) as Interval[]).map(value => {
            const disabled = countBuckets(draft, value) > 400
            return { value, label: intervalLabels[value] + (disabled ? '（超过 400 段）' : ''), disabled }
          })} /></Space>
    </div>
    {editing && <div className="traffic-custom">
      <label>开始（北京时间）<Input type="datetime-local" step={60} value={from} onChange={e => { setFrom(e.target.value); setError('') }} /></label>
      <label>结束（不含该分钟）<Input type="datetime-local" step={60} value={until} onChange={e => { setUntil(e.target.value); setError('') }} /></label>
      <Button onClick={applyCustom} type="primary" disabled={dense}>查询</Button>
    </div>}
    {(error || dense) && <Alert type="warning" showIcon message={error || '所选粒度超过 400 个时段，请调大粒度或缩短范围。'} />}
  </div></Card>
}

function BucketChart({ timeline, metric }: { timeline: Timeline; metric: Metric }) {
  const [active, setActive] = useState(() => Math.max(0, timeline.series.length - 1))
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth
  }, [])
  const { series } = timeline
  if (!series.length) return <Typography.Text type="secondary">所选范围内没有时段。</Typography.Text>
  const index = Math.min(active, series.length - 1)
  const current = series[index]
  const values = series.map(b => b[metric])
  const maximum = Math.max(1, ...values.map(value => value ?? 0))
  const byteUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const magnitude = metric === 'bytes_out' ? Math.min(byteUnits.length - 1, Math.floor(Math.log(maximum) / Math.log(1024))) : 0
  const size = 1024 ** magnitude
  const unit = metric === 'bytes_out' ? byteUnits[magnitude] : metric === 'avg_ms' ? 'ms' :
    metric === 'active_accounts' ? '个账号' : metric === 'uv' ? '个浏览器' : '次'
  const axisMax = Math.ceil(maximum / size)
  const halfway = ['avg_ms', 'bytes_out'].includes(metric) ? axisMax / 2 : Math.round(axisMax / 2)
  const showMid = halfway > 0 && halfway < axisMax
  const allUnknown = values.every(value => value === null)
  return <div className="traffic-plot">
    <div className="traffic-plot-heading"><span>{intervalLabels[timeline.interval]}粒度 · {unit}</span>
      <span>{rangeText(current.start, current.end)}　<strong>{metricValue(metric, current[metric])}</strong></span></div>
    {allUnknown && <Typography.Text type="secondary">{metric === 'avg_ms' ? '这段时间没有请求耗时样本。' : '这段时间未采集可用于去重的完整记录。'}</Typography.Text>}
    <div className="traffic-chart-row">
      <div className="traffic-yaxis" aria-hidden="true">
        <span>{formatCount.format(axisMax)}</span>{showMid && <span>{formatCount.format(halfway)}</span>}<span>0</span>
      </div>
      <div className="traffic-scroll" ref={scroll}><div style={{ minWidth: Math.max(0, series.length * 5) }}>
        <div className="traffic-bars" role="group" aria-label={metricLabels[metric] + '分时统计，按左右方向键切换，回车查看时段 HTTP 日志'}>
          {series.map((bucket, i) => {
            const value = bucket[metric]
            const label = rangeText(bucket.start, bucket.end) + ' · ' + metricLabels[metric] + ' ' + metricValue(metric, value) + ' · 查看时段 HTTP 日志'
            return <a key={bucket.ts} href={eventsForBucket(bucket)} tabIndex={i === index ? 0 : -1}
              className={'traffic-bar' + (i === index ? ' active' : '') + (value === null ? ' unknown' : '')}
              aria-label={label} title={label} onFocus={() => setActive(i)} onMouseEnter={() => setActive(i)}
              onKeyDown={e => {
                const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? series.length - 1 : null
                if (next === null) return
                e.preventDefault()
                const target = e.currentTarget.parentElement?.children[Math.min(series.length - 1, Math.max(0, next))]
                if (target instanceof HTMLElement) target.focus()
              }}>
              {value !== null && value > 0 && <i style={{ height: value / size / axisMax * 100 + '%' }} />}
            </a>
          })}
        </div>
        <div className="traffic-xaxis" aria-hidden="true"><span>{shortTime(series[0].start)}</span><span>{shortTime(series[series.length - 1].end)}</span></div>
      </div></div>
    </div>
    <div className="traffic-chart-foot"><Typography.Text type="secondary">点击柱条查看该时段 HTTP 日志。</Typography.Text>
      {values.some(value => value === null) && <Typography.Text type="secondary">斜纹表示{metric === 'avg_ms' ? '没有耗时样本' : '缺少完整采集记录'}。</Typography.Text>}</div>
  </div>
}

function TrafficResults({ query, range, metric, onMetric, onRefresh }: {
  query: string; range: TrafficRange; metric: Metric; onMetric: (metric: Metric) => void; onRefresh: (reload: () => Promise<void>) => void
}) {
  const resource = useResource<Timeline | null>(guardApi + '/timeline?' + query, null, { live: false })
  const data = resource.data
  const dedupMetric = metric === 'uv' || metric === 'active_accounts' ? metric : null
  const missingHistory = dedupMetric && data && (data.totals[dedupMetric] === null || data.series.some(bucket => bucket[dedupMetric] === null))
  const since = dedupMetric === 'uv' ? data?.uv_since : data?.accounts_since
  return <Card title="时段统计" extra={<Button loading={resource.loading} onClick={() => onRefresh(resource.reload)}>刷新</Button>}>
    <div className="http-guard-stack"><ErrorNotice error={resource.error} retry={resource.reload} />
      {!data && !resource.error && <Spin aria-label="正在读取时段统计" />}
      {data && <>
        <Typography.Text type="secondary">北京时间　{rangeText(data.start, data.end)}（不含结束时刻）
          {data.start !== range.start || data.end !== range.end ? ' · 已按实际可查询范围截取' : ''}</Typography.Text>
        <div className="traffic-metrics" role="group" aria-label="选择趋势图指标">
          {metrics.map(key => <button type="button" key={key} aria-pressed={key === metric} onClick={() => onMetric(key)}>
            <span>{metricLabels[key]}</span><strong>{metricValue(key, data.totals[key])}</strong>
          </button>)}
        </div>
        <h2 className="traffic-chart-title">{metricLabels[metric]}趋势</h2>
        <BucketChart key={metric} metric={metric} timeline={data} />
        {dedupMetric && missingHistory && <Typography.Text type="secondary">
          {metricLabels[dedupMetric]}分时记录{since != null ? '采集起于北京时间 ' + timestamp(since) : '尚未开始采集'}。
          {data.totals[dedupMetric] === null ? '所选区间的完整去重总数暂不可用。' : '区间合计可按最近访问记录去重计算。'}
        </Typography.Text>}
        {metric === 'pv' && data.visits_since != null && data.start < data.visits_since && <Typography.Text type="secondary">页面浏览采集起于北京时间 {timestamp(data.visits_since)}。</Typography.Text>}
        {metric !== 'pv' && !dedupMetric && (data.http_first_record === null || data.start < data.http_first_record) && <Typography.Text type="secondary">
          {data.http_first_record === null ? '尚无留存的 HTTP 记录。' : '首条留存的 HTTP 记录为北京时间 ' + timestamp(data.http_first_record) + '。'}
        </Typography.Text>}
      </>}
    </div>
  </Card>
}

export default function HttpGuardTraffic() {
  const hash = window.location.hash
  const { range, metric, error } = useMemo(() => readTrafficRange(hash), [hash])
  const query = new URLSearchParams({
    start: String(range.start), end: String(range.end), interval: range.interval === 'auto' && range.preset === 'today' ? 'hour' : range.interval,
  }).toString()
  function apply(next: TrafficRange, nextMetric = metric) { window.location.hash = trafficHash(next, nextMetric) }
  function refresh(reload: () => Promise<void>) {
    if (range.preset === 'custom') { void reload(); return }
    const recent = presetRange(range.preset)
    if (recent.start === range.start && recent.end === range.end) { void reload(); return }
    apply({ ...recent, interval: countBuckets(recent, range.interval) > 400 ? 'auto' : range.interval })
  }
  return <div className="http-guard-stack">
    <TimeControls key={range.start + '/' + range.end + '/' + range.preset + '/' + range.interval} range={range} onApply={apply} invalid={!!error} />
    {error ? <Alert type="warning" showIcon message={error} /> :
      <TrafficResults key={query} query={query} range={range} metric={metric} onMetric={value => apply(range, value)} onRefresh={refresh} />}
  </div>
}
