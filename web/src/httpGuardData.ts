export const guardApi = '/system/http-guard'
export type Mode = 'off' | 'observe' | 'enforce'
export type BusinessContentProfile = 'uniform' | 'verified_business'
export type Decision = 'pass' | 'observed' | 'blocked'
export type Action = 'allow' | 'deny'
export type ManagedIp = { ip: string; action: Action; expires: number }
export type Policy = {
  mode: Mode; retention_days: number; allow_ips: string[]; deny_ips: string[]
  allow_countries: string[]; deny_countries: string[]; rate_per_minute: number
  block_sensitive_paths: boolean; sqli_mode: Mode; xss_mode: Mode
  business_content_profile?: BusinessContentProfile; adaptive_enabled?: boolean
  anonymous_rate_per_minute?: number; authenticated_rate_per_minute?: number
  revision: number; managed_ips: ManagedIp[]
}
export type AccessEvent = {
  id: number; ts: number; ip: string; country: string; method: string; route: string
  status: number; duration_ms: number; bytes_out: number; decision: Decision; reason: string; actor_label: string | null
}
export type Geo = { ready: boolean; updated_at: number | null; source: string }
export type Status = { client_ip: string; geo: Geo; engine: { ready: boolean; version: string | null }; runtime: { queued: number; dropped: number; write_errors: number; settings_errors: number } }
export type Analytics = {
  pv: number; uv: number; active_accounts: number; since: number | null
  series: { ts: number; pv: number }[]; pages: { page: string; pv: number }[]
  routes: { route: string; method: string; requests: number; errors: number; avg_ms: number; p95_ms: number; max_ms: number }[]
}
export const periods = [{ value: 1, label: '近 1 小时' }, { value: 24, label: '近 24 小时' }, { value: 168, label: '近 7 天' }, { value: 720, label: '近 30 天' }, { value: 0, label: '全部保留期' }]
export const modeNames: Record<Mode, string> = { off: '已关闭', observe: '观察模式', enforce: '拦截模式' }
export const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' })
export function countryName(code: string) {
  if (!code || !/^[A-Z]{2}$/.test(code) || code === 'ZZ') return '未知地区'
  return regionNames.of(code) || code
}
export function dateTime(seconds: number, compact = false) {
  return new Date(seconds * 1000).toLocaleString('zh-CN', { year: compact ? undefined : 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: compact ? undefined : '2-digit', hour12: false })
}
export function bytes(value: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return numberFormat.format(value) + ' ' + units[unit]
}
export function selectedSources(rows: Pick<AccessEvent, 'id' | 'ip'>[]) {
  const sources = new Map<string, number>()
  for (const row of rows) if (row.ip && !sources.has(row.ip)) sources.set(row.ip, row.id)
  return [...sources].map(([ip, id]) => ({ ip, id }))
}
export function checkedLogRows<T extends Pick<AccessEvent, 'id' | 'ip'>>(previous: T[], page: T[], keys: readonly (string | number | bigint)[]) {
  const selected = new Set(keys)
  const records = new Map([...previous, ...page].map(row => [row.id, row]))
  return [...records.values()].filter(row => selected.has(row.id) && row.ip)
}
export function removeSelectedIp<T extends Pick<AccessEvent, 'id' | 'ip'>>(rows: T[], ip: string) {
  return rows.filter(row => row.ip !== ip)
}
export function formatRate(part: number, total: number) {
  if (!total || part <= 0) return '0%'
  const pct = (part / total) * 100
  return pct < 0.1 ? '< 0.1%' : numberFormat.format(pct) + '%'
}
export function formatExpiry(expires: number, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!expires) return { label: '长期有效', expired: false }
  const diff = expires - nowSeconds
  if (diff <= 0) return { label: '已过期 · ' + dateTime(expires, true), expired: true }
  const hours = Math.ceil(diff / 3600)
  if (hours < 24) return { label: `剩余 ${hours} 小时 · ${dateTime(expires, true)}`, expired: false }
  const days = Math.ceil(diff / 86400)
  return { label: `剩余 ${days} 天 · ${dateTime(expires, true)}`, expired: false }
}
export function summarizePerformance(routes: Analytics['routes']) {
  let totalRequests = 0
  let totalErrors = 0
  let slowest: Analytics['routes'][number] | null = null
  for (const row of routes) {
    totalRequests += row.requests
    totalErrors += row.errors
    if (!slowest || row.p95_ms > slowest.p95_ms) slowest = row
  }
  return { routeCount: routes.length, totalRequests, totalErrors, slowest }
}
