import { useMemo, useState } from 'react'
import { Alert, App, Card, Segmented, Select, Space, Spin, Tag, Typography } from 'antd'
import { ApartmentOutlined, ArrowLeftOutlined, AuditOutlined, FileSearchOutlined, ReadOutlined, SettingOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { send, useResource } from './api'
import type { GuardView } from './examNavigation'
import { HttpGuardLog } from './HttpGuardLog'
import { HttpGuardRules } from './HttpGuardRules'
import {
  bytes,
  countryName,
  dateTime,
  formatRate,
  guardApi,
  modeNames,
  numberFormat,
  periods,
  summarizePerformance,
  type Analytics,
  type Geo,
  type Mode,
  type Policy,
  type Status,
} from './httpGuardData'
import './http-guard.css'

type Bucket = { ts: number; requests: number; observed: number; blocked: number }
type IpCount = { ip: string; country: string; requests: number; blocked: number }
type CountryCount = { country: string; requests: number }
type Overview = {
  requests: number; unique_ips: number; blocked: number; observed: number; server_errors: number
  avg_ms: number; bytes_out: number; series: Bucket[]; top_ips: IpCount[]; countries: CountryCount[]
}
type PerfFilter = 'all' | 'slow' | 'errors'

const views = [
  { key: 'overview', name: '防护概览', icon: <ApartmentOutlined /> },
  { key: 'events', name: '访问日志', icon: <FileSearchOutlined /> },
  { key: 'policies', name: '防护策略', icon: <SettingOutlined /> },
  { key: 'performance', name: '接口性能', icon: <ReadOutlined /> },
] as const

const modeColors: Record<Mode, string> = { off: 'default', observe: 'blue', enforce: 'green' }
const methodColors: Record<string, string> = { GET: 'blue', POST: 'green', PUT: 'gold', PATCH: 'orange', DELETE: 'red' }

const pageNames: Record<string, string> = {
  dashboard: '工作概览', scanner: '扫描台', 'subject-catalog': '科目管理', electives: '选科管理', exams: '考试项目', marking: '阅卷中心',
  exceptions: '异常总览', results: '成绩分析', people: '人员与班级', conversions: '赋分方案', settings: '系统设置',
  account: '个人账号', login: '登录入口', 'login/admin': '管理后台登录', 'login/marking': '阅卷台登录', archives: '归档文件',
  ...Object.fromEntries(views.map(view => ['http-guard/' + view.key, '防护工作台 / ' + view.name])),
}

function Period({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  return <Select aria-label="统计时段" value={hours} onChange={onChange} options={periods} style={{ minWidth: 120 }} />
}

function TrendChart({ series, visits = false }: { series: Bucket[]; visits?: boolean }) {
  const [activeTs, setActiveTs] = useState<number | null>(null)
  const hasData = series.some(bucket => bucket.requests > 0)
  const max = Math.max(1, ...series.map(bucket => bucket.requests))
  const total = series.reduce((sum, b) => sum + b.requests, 0)
  const totalBlocked = series.reduce((sum, b) => sum + b.blocked, 0)
  const totalObserved = series.reduce((sum, b) => sum + b.observed, 0)

  if (!hasData) {
    return <Typography.Text type="secondary">{visits ? '所选时段暂无页面浏览记录。' : '所选时段暂无请求。'}</Typography.Text>
  }

  const activeBucket = (activeTs !== null ? series.find(b => b.ts === activeTs) : null) || null
  const midBucket = series.length >= 3 ? series[Math.floor(series.length / 2)] : null
  const yTicks = [max, Math.round(max * 0.5), 0]

  return (
    <figure className="http-guard-trend" onMouseLeave={() => setActiveTs(null)}>
      <figcaption className="guard-trend-head">
        <div className="guard-trend-summary">
          <span>{visits ? '总浏览 ' : '总请求 '}<strong>{numberFormat.format(total)}</strong></span>
          <span>峰值 <strong>{numberFormat.format(max)}</strong> / 时段</span>
          {!visits && totalBlocked > 0 && <span className="guard-text-danger">已拦截 <strong>{numberFormat.format(totalBlocked)}</strong></span>}
          {!visits && totalObserved > 0 && <span className="guard-text-warn">观察命中 <strong>{numberFormat.format(totalObserved)}</strong></span>}
        </div>
        {!visits && (
          <span className="http-guard-legend">
            <i className="pass" />放行
            <i className="observed" />观察命中
            <i className="blocked" />已拦截
          </span>
        )}
      </figcaption>

      <div className="guard-trend-readout" aria-live="polite">
        {activeBucket ? (
          <>
            <span className="guard-readout-time">{dateTime(activeBucket.ts)} 起</span>
            <span className="guard-readout-vals">
              {visits ? (
                <>浏览 <strong>{numberFormat.format(activeBucket.requests)}</strong> 次</>
              ) : (
                <>
                  请求 <strong>{numberFormat.format(activeBucket.requests)}</strong>
                  <span>放行 {numberFormat.format(Math.max(0, activeBucket.requests - activeBucket.observed - activeBucket.blocked))}</span>
                  {activeBucket.observed > 0 && <span className="guard-text-warn">观察 {numberFormat.format(activeBucket.observed)}</span>}
                  {activeBucket.blocked > 0 && <span className="guard-text-danger">拦截 {numberFormat.format(activeBucket.blocked)}</span>}
                </>
              )}
            </span>
          </>
        ) : (
          <span className="guard-readout-hint">悬停或聚焦柱条查看时段明细</span>
        )}
      </div>

      <div className="guard-chart-frame">
        <div className="guard-chart-yaxis" aria-hidden="true">
          {yTicks.map((tick, idx) => <span key={idx}>{numberFormat.format(tick)}</span>)}
        </div>
        <div className="guard-chart-plot">
          <div className="http-guard-bars" role="img" aria-label={(visits ? '页面浏览趋势' : '请求趋势') + '，峰值 ' + max}>
            {series.map(bucket => {
              const passed = Math.max(0, bucket.requests - bucket.observed - bucket.blocked)
              const passPct = (passed / max) * 100
              const obsPct = (bucket.observed / max) * 100
              const blkPct = (bucket.blocked / max) * 100
              const isActive = activeTs === bucket.ts
              return (
                <button
                  type="button"
                  className={'http-guard-bin' + (isActive ? ' is-active' : '')}
                  key={bucket.ts}
                  onMouseEnter={() => setActiveTs(bucket.ts)}
                  onFocus={() => setActiveTs(bucket.ts)}
                  aria-label={dateTime(bucket.ts) + ' 起，' + bucket.requests + (visits ? ' 次浏览' : ` 次请求，观察命中 ${bucket.observed} 次，拦截 ${bucket.blocked} 次`)}
                >
                  {passed > 0 && <i className="pass" style={{ height: passPct + '%' }} />}
                  {bucket.observed > 0 && <i className="observed" style={{ height: `max(2px, ${obsPct}%)` }} />}
                  {bucket.blocked > 0 && <i className="blocked" style={{ height: `max(2px, ${blkPct}%)` }} />}
                </button>
              )
            })}
          </div>
          <div className="http-guard-axis">
            <span>{dateTime(series[0].ts, true)}</span>
            {midBucket && <span className="guard-axis-mid">{dateTime(midBucket.ts, true)}</span>}
            <span>{dateTime(series[series.length - 1].ts, true)}</span>
          </div>
        </div>
      </div>
    </figure>
  )
}

type KpiItem = {
  label: string
  value: string | number
  hint?: string
  tone?: 'neutral' | 'primary' | 'success' | 'warn' | 'danger'
}

function KpiGrid({ items, primary = false }: { items: KpiItem[]; primary?: boolean }) {
  return (
    <dl className={'guard-kpi-grid' + (primary ? ' guard-kpi-primary' : '')}>
      {items.map(item => (
        <div key={item.label} className={'guard-kpi-tile' + (item.tone ? ` is-${item.tone}` : '')}>
          <dt>{item.label}</dt>
          <dd>{typeof item.value === 'number' ? numberFormat.format(item.value) : item.value}</dd>
          {item.hint && <span className="guard-kpi-hint">{item.hint}</span>}
        </div>
      ))}
    </dl>
  )
}

function RankValue({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0
  return (
    <div className="guard-rank-cell">
      <span className="guard-rank-num">{numberFormat.format(value)}</span>
      <span className="guard-rank-track" aria-hidden="true"><i style={{ width: width + '%' }} /></span>
    </div>
  )
}

type TimeProps = { hours: number; setHours: (value: number) => void }

function TrafficOverview({ hours, setHours, inspectIp }: TimeProps & { inspectIp: (ip: string) => void }) {
  const resource = useResource<Overview | null>(guardApi + '/overview?hours=' + hours, null, { live: false })
  const activity = useResource<Analytics | null>(guardApi + '/analytics?hours=' + hours, null, { live: false })
  const data = resource.data
  const visits = activity.data

  const maxPagePv = Math.max(1, ...(visits?.pages.map(p => p.pv) || [1]))
  const maxIpReq = Math.max(1, ...(data?.top_ips.map(i => i.requests) || [1]))
  const maxCountryReq = Math.max(1, ...(data?.countries.map(c => c.requests) || [1]))

  return (
    <div className="http-guard-stack">
      <Card
        title="站点访问"
        extra={
          <Space wrap>
            <Period hours={hours} onChange={setHours} />
            <Button loading={resource.loading || activity.loading} onClick={() => Promise.all([resource.reload(), activity.reload()])}>刷新</Button>
          </Space>
        }
      >
        <ErrorNotice error={activity.error} retry={activity.reload} />
        {visits ? (
          <div className="guard-card-body-stack">
            <KpiGrid
              primary
              items={[
                { label: '页面浏览量（PV）', value: visits.pv, hint: '页面访问总次数', tone: 'primary' },
                { label: '独立浏览器（UV）', value: visits.uv, hint: '按浏览器标识去重', tone: 'neutral' },
                { label: '活跃账号', value: visits.active_accounts, hint: '按已认证用户去重', tone: 'success' },
              ]}
            />
            {visits.since && <Typography.Text type="secondary" className="guard-footnote">统计起于 {dateTime(visits.since)}。</Typography.Text>}
          </div>
        ) : !activity.error && <Spin />}
      </Card>

      {visits && (
        <div className="http-guard-rankings">
          <Card title="页面浏览趋势">
            <TrendChart visits series={visits.series.map(row => ({ ts: row.ts, requests: row.pv, observed: 0, blocked: 0 }))} />
          </Card>
          <Card title="热门页面">
            <Table
              rowKey="page"
              dataSource={visits.pages}
              query=""
              columnChooser={false}
              pagination={{ pageSize: 5, hideOnSinglePage: true }}
              columns={[
                { title: '页面', dataIndex: 'page', render: (code: string) => pageNames[code] || code },
                { title: '浏览次数', dataIndex: 'pv', align: 'right', width: 130, render: (pv: number) => <RankValue value={pv} max={maxPagePv} /> },
              ]}
            />
          </Card>
        </div>
      )}

      <Card title="HTTP 流量与拦截">
        <ErrorNotice error={resource.error} retry={resource.reload} />
        {data ? (
          <KpiGrid
            items={[
              { label: 'HTTP 请求', value: data.requests, tone: 'primary' },
              { label: '来源 IP', value: data.unique_ips, tone: 'neutral' },
              { label: '已拦截', value: data.blocked, hint: '占比 ' + formatRate(data.blocked, data.requests), tone: data.blocked > 0 ? 'danger' : 'neutral' },
              { label: '观察命中', value: data.observed, hint: '占比 ' + formatRate(data.observed, data.requests), tone: data.observed > 0 ? 'warn' : 'neutral' },
              { label: '服务端错误（5xx）', value: data.server_errors, hint: '占比 ' + formatRate(data.server_errors, data.requests), tone: data.server_errors > 0 ? 'danger' : 'neutral' },
              { label: '平均耗时', value: numberFormat.format(data.avg_ms) + ' ms', tone: data.avg_ms >= 200 ? 'warn' : 'neutral' },
              { label: '响应流量', value: bytes(data.bytes_out), tone: 'neutral' },
            ]}
          />
        ) : !resource.error && <Spin />}
      </Card>

      {data && (
        <>
          <Card title="请求趋势">
            <TrendChart series={data.series} />
          </Card>
          <div className="http-guard-rankings">
            <Card title="访问量最高的 IP" extra={<Typography.Text type="secondary">点击 IP 查看访问日志</Typography.Text>}>
              <Table<IpCount>
                rowKey="ip"
                dataSource={data.top_ips}
                pagination={false}
                query=""
                columnChooser={false}
                columns={[
                  {
                    title: '来源 IP',
                    dataIndex: 'ip',
                    render: (ip: string) => (
                      <Button type="link" size="small" className="guard-ip-link" onClick={() => inspectIp(ip)}>
                        <span className="guard-mono">{ip}</span>
                      </Button>
                    ),
                  },
                  { title: 'IP 归属地', dataIndex: 'country', render: countryName },
                  { title: '请求数', dataIndex: 'requests', align: 'right', width: 120, render: (req: number) => <RankValue value={req} max={maxIpReq} /> },
                  {
                    title: '拦截数',
                    dataIndex: 'blocked',
                    align: 'right',
                    render: (blk: number) => blk > 0 ? <Tag color="red">{numberFormat.format(blk)}</Tag> : <span className="guard-muted">0</span>,
                  },
                ]}
              />
            </Card>
            <Card title="IP 归属国家 / 地区" className="guard-country-ranking">
              <div className="guard-card-body-stack">
                <Table<CountryCount>
                  rowKey="country"
                  dataSource={data.countries}
                  tableLayout="fixed"
                  scroll={{ x: undefined, y: undefined }}
                  pagination={false}
                  query=""
                  columnChooser={false}
                  columns={[
                    { title: '国家 / 地区', dataIndex: 'country', render: countryName },
                    { title: '请求数', dataIndex: 'requests', align: 'right', width: 120, render: (req: number) => <RankValue value={req} max={maxCountryReq} /> },
                  ]}
                />
                <Typography.Text type="secondary" className="guard-footnote">使用 VPN 时显示出口 IP 的归属地。</Typography.Text>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

function Performance({ hours, setHours }: TimeProps) {
  const activity = useResource<Analytics | null>(guardApi + '/analytics?hours=' + hours, null, { live: false })
  const [filter, setFilter] = useState<PerfFilter>('all')
  const routes = activity.data?.routes || []
  const summary = useMemo(() => summarizePerformance(routes), [routes])

  const filteredRoutes = useMemo(() => {
    if (filter === 'slow') return routes.filter(r => r.p95_ms >= 200)
    if (filter === 'errors') return routes.filter(r => r.errors > 0)
    return routes
  }, [routes, filter])

  const ms = (value: number) => <span className="guard-mono">{value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ms</span>
  const latencyCell = (value: number) => (
    <span className={'guard-mono ' + (value >= 500 ? 'guard-text-danger' : value >= 200 ? 'guard-text-warn' : '')}>
      {value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ms
    </span>
  )

  return (
    <div className="http-guard-stack">
      <Card
        title="业务接口耗时"
        extra={
          <Space wrap>
            <Period hours={hours} onChange={setHours} />
            <Button loading={activity.loading} onClick={activity.reload}>刷新</Button>
          </Space>
        }
      >
        <div className="http-guard-stack">
          <ErrorNotice error={activity.error} retry={activity.reload} />
          <KpiGrid
            items={[
              { label: '接口数量', value: summary.routeCount, tone: 'primary' },
              { label: '样本总数', value: summary.totalRequests, tone: 'neutral' },
              { label: '5xx 错误总数', value: summary.totalErrors, hint: '占比 ' + formatRate(summary.totalErrors, summary.totalRequests), tone: summary.totalErrors > 0 ? 'danger' : 'neutral' },
              {
                label: '最高 P95 上界',
                value: summary.slowest ? summary.slowest.p95_ms.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' ms' : '—',
                hint: summary.slowest ? `${summary.slowest.method} ${summary.slowest.route}` : '暂无样本',
                tone: summary.slowest && summary.slowest.p95_ms >= 500 ? 'danger' : summary.slowest && summary.slowest.p95_ms >= 200 ? 'warn' : 'neutral',
              },
            ]}
          />
          <div className="http-guard-nav">
            <Typography.Text type="secondary">按 HTTP 方法和路由模板统计。P95 上界取第 95 百分位所在耗时区间内的实测最大值。</Typography.Text>
            <Segmented
              value={filter}
              onChange={value => setFilter(value as PerfFilter)}
              options={[
                { value: 'all', label: `全部接口 (${routes.length})` },
                { value: 'slow', label: `慢接口 ≥200ms (${routes.filter(r => r.p95_ms >= 200).length})` },
                { value: 'errors', label: `含 5xx 错误 (${routes.filter(r => r.errors > 0).length})` },
              ]}
            />
          </div>
          <Table
            rowKey={row => row.method + ' ' + row.route}
            dataSource={filteredRoutes}
            loading={activity.loading}
            columns={[
              {
                title: '方法',
                dataIndex: 'method',
                width: 90,
                render: (method: string) => <Tag color={methodColors[method] || 'default'}>{method}</Tag>,
              },
              { title: '接口', dataIndex: 'route', render: (route: string) => <span className="guard-mono">{route}</span> },
              { title: '样本数', dataIndex: 'requests', align: 'right', render: (v: number) => <span className="guard-mono">{numberFormat.format(v)}</span> },
              {
                title: '5xx 错误',
                dataIndex: 'errors',
                align: 'right',
                render: (errors: number, row: Analytics['routes'][number]) =>
                  errors > 0 ? (
                    <span className="guard-text-danger guard-mono">
                      {numberFormat.format(errors)} ({formatRate(errors, row.requests)})
                    </span>
                  ) : (
                    <span className="guard-muted">0</span>
                  ),
              },
              { title: '平均耗时', dataIndex: 'avg_ms', align: 'right', render: ms },
              { title: 'P95 上界', dataIndex: 'p95_ms', align: 'right', defaultSortOrder: 'descend', render: latencyCell },
              { title: '最大耗时', dataIndex: 'max_ms', align: 'right', render: latencyCell },
            ]}
          />
        </div>
      </Card>
    </div>
  )
}

export default function HttpGuard({ view, onView, onExit, account }: { view: GuardView; onView: (view: GuardView) => void; onExit: () => void; account: string }) {
  const [hours, setHours] = useState(24)
  const [initialIp, setInitialIp] = useState('')
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const policy = useResource<Policy | null>(guardApi + '/settings', null, { live: false })
  const status = useResource<Status | null>(guardApi + '/status', null, { live: false })
  const { message } = App.useApp()

  async function updateGeo() {
    setUpdating(true)
    setUpdateError('')
    try {
      const geo = await send<Geo>(guardApi + '/geoip/update')
      status.setData(value => value ? { ...value, geo } : value)
      await status.reload()
      message.success('GeoIP 数据库已更新')
    } catch (e) {
      setUpdateError((e as Error).message)
    } finally {
      setUpdating(false)
    }
  }

  const info = status.data
  const currentMode = policy.data?.mode

  return (
    <div className="guard-workspace">
      <aside className="guard-rail">
        <div className="guard-identity">
          <AuditOutlined />
          <div className="guard-identity-text">
            <strong>HTTP 防护工作台</strong>
            {currentMode && <span className={'guard-rail-mode is-' + currentMode}>{modeNames[currentMode]}</span>}
          </div>
        </div>
        <nav aria-label="防护导航">
          {views.map(item => (
            <a
              key={item.key}
              href={'#/http-guard/' + item.key}
              aria-current={view === item.key ? 'page' : undefined}
              onClick={() => setInitialIp('')}
            >
              {item.icon}
              <span>{item.name}</span>
            </a>
          ))}
        </nav>
        <button type="button" className="guard-return" onClick={onExit}>
          <ArrowLeftOutlined />
          <span>返回管理后台</span>
        </button>
      </aside>
      <main className="guard-main">
        <header className="guard-header">
          <div>
            <h1>{views.find(item => item.key === view)?.name}</h1>
          </div>
          <Space wrap className="guard-header-meta">
            {currentMode && <Tag color={modeColors[currentMode]}>{modeNames[currentMode]}</Tag>}
            {info && <Tag color={info.engine?.ready ? 'green' : 'default'}>{info.engine?.ready ? '检测引擎就绪' : '检测引擎未就绪'}</Tag>}
            <span className="guard-account-pill">{account}</span>
          </Space>
        </header>
        <section className="http-guard-stack">
          <ErrorNotice error={policy.error || status.error} retry={() => { void policy.reload(); void status.reload() }} />
          {view === 'overview' && <TrafficOverview hours={hours} setHours={setHours} inspectIp={ip => { setInitialIp(ip); onView('events') }} />}
          {view === 'events' && (
            <HttpGuardLog
              hours={hours}
              setHours={setHours}
              initialIp={initialIp}
              clientIp={info?.client_ip}
              policy={policy.data}
              onSaved={policy.setData}
              reloadPolicy={policy.reload}
            />
          )}
          {view === 'performance' && <Performance hours={hours} setHours={setHours} />}
          {view === 'policies' && (
            <>
              {policy.data && !policy.error ? (
                <HttpGuardRules key={policy.data.revision} policy={policy.data} onSaved={policy.setData} reload={policy.reload} status={info} />
              ) : policy.loading && <Spin />}
              {info && (
                <div className="http-guard-rankings">
                  <Card
                    title="GeoIP 数据库"
                    extra={
                      <Button disabled={updating} loading={updating} onClick={updateGeo}>
                        {info.geo.ready ? '更新数据库' : '下载数据库'}
                      </Button>
                    }
                  >
                    <Space direction="vertical">
                      <Space wrap>
                        <Tag color={info.geo.ready ? 'green' : 'default'}>{info.geo.ready ? '已就绪' : '待下载'}</Tag>
                        {info.geo.updated_at && <span>最近更新 {dateTime(info.geo.updated_at)}</span>}
                      </Space>
                      {info.geo.source && <Typography.Text type="secondary" className="http-guard-source">数据源 {info.geo.source}</Typography.Text>}
                      {updateError && <Alert type="error" showIcon message={updateError} />}
                    </Space>
                  </Card>
                  <Card title="当前进程日志写入" extra={<Button loading={status.loading} onClick={status.reload}>刷新</Button>}>
                    <Space wrap size="large">
                      <span>排队 {info.runtime.queued} 条</span>
                      <span>已丢弃 {info.runtime.dropped} 条</span>
                      <span>写入失败 {info.runtime.write_errors} 次</span>
                      {info.runtime.settings_errors > 0 && <span>配置刷新失败 {info.runtime.settings_errors} 次</span>}
                    </Space>
                  </Card>
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  )
}
