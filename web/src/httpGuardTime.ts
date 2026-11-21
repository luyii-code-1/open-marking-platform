export type Interval = 'auto' | 'minute' | 'hour' | 'day'
export type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'custom'
export type TimeWindow = { start: number; end: number }
export type TrafficRange = TimeWindow & { preset: Preset; interval: Interval }
export type TrafficTotals = {
  pv: number; uv: number | null; active_accounts: number | null; requests: number; blocked: number
  observed: number; server_errors: number; avg_ms: number | null; bytes_out: number
}
export type Metric = keyof TrafficTotals
export type TimeBucket = TimeWindow & TrafficTotals & { ts: number }
export type Timeline = TimeWindow & {
  interval: Exclude<Interval, 'auto'>; step_seconds: number; uv_since: number | null; accounts_since: number | null
  visits_since: number | null; http_first_record: number | null; series: TimeBucket[]; totals: TrafficTotals
}
export const metricLabels: Record<Metric, string> = {
  pv: '页面浏览量（PV）', uv: '独立浏览器（UV）', active_accounts: '活跃账号', requests: 'HTTP 请求', blocked: '已拦截',
  observed: '观察命中', server_errors: '服务端错误（5xx）', bytes_out: '响应流量', avg_ms: '平均耗时',
}
export const intervalLabels: Record<Interval, string> = { auto: '自动', minute: '分钟', hour: '小时', day: '天' }
export const presetLabels: Record<Preset, string> = { today: '今天', yesterday: '昨天', '7d': '近 7 天', '30d': '近 30 天', custom: '自定义' }
const day = 86400
const shanghaiOffset = 8 * 3600
const steps = { minute: 60, hour: 3600, day }

export function shanghaiMinute(ts: number) {
  return new Date((ts + shanghaiOffset) * 1000).toISOString().slice(0, 16)
}
export function parseShanghaiMinute(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const seconds = Date.parse(value + ':00+08:00') / 1000
  return Number.isFinite(seconds) && seconds >= 0 && shanghaiMinute(seconds) === value ? seconds : null
}
export function presetRange(preset: Exclude<Preset, 'custom'>, now = Date.now()): TrafficRange {
  const end = (Math.floor(now / 60000) + 1) * 60
  const today = Math.floor((now / 1000 + shanghaiOffset) / day) * day - shanghaiOffset
  if (preset === 'yesterday') return { preset, start: today - day, end: today, interval: 'hour' }
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 1
  return { preset, start: today - (days - 1) * day, end, interval: days === 1 ? 'hour' : 'day' }
}
export function countBuckets(range: TimeWindow, interval: Interval) {
  if (interval === 'auto' || range.end <= range.start) return 0
  const step = steps[interval]
  return Math.floor((range.end - 1 + shanghaiOffset) / step) - Math.floor((range.start + shanghaiOffset) / step) + 1
}
function unixMinute(raw: string | null) {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null
  const value = Number(raw)
  return value <= 253402271940 && value % 60 === 0 ? value : null
}
export function readTrafficRange(hash: string, now = Date.now()) {
  const q = new URLSearchParams(hash.split('?')[1] || '')
  const selectedPreset = q.get('preset')
  const preset = selectedPreset && Object.hasOwn(presetLabels, selectedPreset) ? selectedPreset as Preset : 'today'
  const baseline = presetRange(preset === 'custom' ? 'today' : preset, now)
  const chosenInterval = q.get('interval'), metric = q.get('metric')
  const range: TrafficRange = { ...baseline, interval: chosenInterval && Object.hasOwn(intervalLabels, chosenInterval) ? chosenInterval as Interval : baseline.interval }
  let error = ''
  if (q.has('start') || q.has('end') || preset === 'custom') {
    const start = unixMinute(q.get('start')), end = unixMinute(q.get('end'))
    if (start === null || end === null || start >= end) error = '链接中的时间范围无效，请重新选择。'
    else {
      range.start = start
      range.end = end
      range.preset = preset !== 'custom' && selectedPreset && start === baseline.start && end <= baseline.end ? preset : 'custom'
      if (countBuckets(range, range.interval) > 400) error = '所选粒度超过 400 个时段，请调大粒度或缩短范围。'
    }
  }
  return { range, metric: metric && Object.hasOwn(metricLabels, metric) ? metric as Metric : 'pv' as Metric, error }
}
export function trafficHash(range: TrafficRange, metric: Metric) {
  return '#/http-guard/traffic?' + new URLSearchParams({
    preset: range.preset, start: String(range.start), end: String(range.end), interval: range.interval, metric,
  })
}
export function eventsForBucket({ start, end }: TimeWindow) {
  return '#/http-guard/events?start=' + start + '&end=' + end
}
