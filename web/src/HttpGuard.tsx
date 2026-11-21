import { useState } from 'react'
import { Alert, App, Card, Select, Space, Spin, Tag, Typography } from 'antd'
import { ApartmentOutlined, ArrowLeftOutlined, AuditOutlined, FileSearchOutlined, ReadOutlined, SettingOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { send, useResource } from './api'
import type { GuardView } from './examNavigation'
import { HttpGuardLog } from './HttpGuardLog'
import { HttpGuardRules } from './HttpGuardRules'
import { bytes, countryName, dateTime, guardApi, modeNames, numberFormat, periods, type Analytics, type Geo, type Policy, type Status } from './httpGuardData'
import './http-guard.css'

type Bucket = { ts: number; requests: number; observed: number; blocked: number }
type IpCount = { ip: string; country: string; requests: number; blocked: number }
type CountryCount = { country: string; requests: number }
type Overview = {
  requests: number; unique_ips: number; blocked: number; observed: number; server_errors: number
  avg_ms: number; bytes_out: number; series: Bucket[]; top_ips: IpCount[]; countries: CountryCount[]
}
const views = [
  { key: 'overview', name: '防护概览', icon: <ApartmentOutlined /> }, { key: 'events', name: '访问日志', icon: <FileSearchOutlined /> },
  { key: 'policies', name: '防护策略', icon: <SettingOutlined /> }, { key: 'performance', name: '接口性能', icon: <ReadOutlined /> },
] as const
const pageNames: Record<string, string> = {
  dashboard: '工作概览', scanner: '扫描台', 'subject-catalog': '科目管理', electives: '选科管理', exams: '考试项目', marking: '阅卷中心',
  exceptions: '异常总览', results: '成绩分析', people: '人员与班级', conversions: '赋分方案', settings: '系统设置',
  account: '个人账号', login: '登录入口', 'login/admin': '管理后台登录', 'login/marking': '阅卷台登录', archives: '归档文件',
  ...Object.fromEntries(views.map(view => ['http-guard/' + view.key, '防护工作台 / ' + view.name])),
}
function Period({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  return <Select aria-label="统计时段" value={hours} onChange={onChange} options={periods} />
}
function Trend({ series, visits = false }: { series: Bucket[]; visits?: boolean }) {
  const max = Math.max(1, ...series.map(bucket => bucket.requests))
  if (!series.some(bucket => bucket.requests)) return <Typography.Text type="secondary">{visits ? '所选时段暂无页面浏览记录。' : '所选时段暂无请求。'}</Typography.Text>
  return <figure className="http-guard-trend">
    <figcaption><span>峰值 {numberFormat.format(max)} 次 / 时段</span>
      {!visits && <span className="http-guard-legend"><i className="pass" />放行<i className="observed" />观察命中<i className="blocked" />已拦截</span>}
    </figcaption>
    <div className="http-guard-bars" role="img" aria-label={(visits ? '页面浏览趋势' : '请求趋势') + '，峰值 ' + max}>
      {series.map(bucket => <div className="http-guard-bin" key={bucket.ts}
        title={dateTime(bucket.ts) + ' 起 · ' + bucket.requests + (visits ? ' 次浏览' : ' 次请求 · 观察命中 ' + bucket.observed + ' 次 · 拦截 ' + bucket.blocked + ' 次')}>
        <i className="pass" style={{ height: Math.max(0, bucket.requests - bucket.observed - bucket.blocked) / max * 100 + '%' }} />
        <i className="observed" style={{ height: bucket.observed / max * 100 + '%' }} />
        <i className="blocked" style={{ height: bucket.blocked / max * 100 + '%' }} />
      </div>)}
    </div>
    <div className="http-guard-axis"><span>{dateTime(series[0].ts, true)}</span><span>{dateTime(series[series.length - 1].ts, true)}</span></div>
  </figure>
}
function Metrics({ values, primary = false }: { values: [string, string | number][]; primary?: boolean }) {
  return <dl className={'http-guard-metrics' + (primary ? ' guard-primary-metrics' : '')}>
    {values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === 'number' ? numberFormat.format(value) : value}</dd></div>)}
  </dl>
}
type TimeProps = { hours: number; setHours: (value: number) => void }
function TrafficOverview({ hours, setHours, inspectIp }: TimeProps & { inspectIp: (ip: string) => void }) {
  const resource = useResource<Overview | null>(guardApi + '/overview?hours=' + hours, null, { live: false })
  const activity = useResource<Analytics | null>(guardApi + '/analytics?hours=' + hours, null, { live: false })
  const data = resource.data, visits = activity.data
  return <div className="http-guard-stack">
    <Card title="站点访问" extra={<Space><Period hours={hours} onChange={setHours} />
      <Button loading={resource.loading || activity.loading} onClick={() => Promise.all([resource.reload(), activity.reload()])}>刷新</Button></Space>}>
      <ErrorNotice error={activity.error} retry={activity.reload} />
      {visits ? <><Metrics primary values={[['页面浏览量（PV）', visits.pv], ['独立访客（UV）', visits.uv], ['活跃账号', visits.active_accounts]]} />
        <Typography.Text type="secondary">UV 按浏览器标识去重。活跃账号按已认证请求中的用户去重。{visits.since ? '统计起于 ' + dateTime(visits.since) + '。' : ''}</Typography.Text></> : !activity.error && <Spin />}
    </Card>
    {visits && <div className="http-guard-rankings">
      <Card title="页面浏览趋势"><Trend visits series={visits.series.map(row => ({ ts: row.ts, requests: row.pv, observed: 0, blocked: 0 }))} /></Card>
      <Card title="热门页面"><Table rowKey="page" dataSource={visits.pages} query="" columnChooser={false} pagination={{ pageSize: 5, hideOnSinglePage: true }}
        columns={[{ title: '页面', dataIndex: 'page', render: (code: string) => pageNames[code] || code }, { title: '浏览次数', dataIndex: 'pv', align: 'right' }]} /></Card>
    </div>}
    <Card title="HTTP 流量"><ErrorNotice error={resource.error} retry={resource.reload} />
      {data ? <Metrics values={[['HTTP 请求', data.requests], ['来源 IP', data.unique_ips], ['观察命中', data.observed], ['已拦截', data.blocked],
        ['服务端错误（5xx）', data.server_errors], ['平均耗时', numberFormat.format(data.avg_ms) + ' ms'], ['响应流量', bytes(data.bytes_out)]]} /> : !resource.error && <Spin />}
    </Card>
    {data && <>
      <Card title="请求趋势"><Trend series={data.series} /></Card>
      <div className="http-guard-rankings">
        <Card title="访问量最高的 IP"><Table<IpCount> rowKey="ip" dataSource={data.top_ips} pagination={false} query="" columnChooser={false}
          columns={[{ title: '来源 IP', dataIndex: 'ip', render: (ip: string) => <Button type="link" size="small" onClick={() => inspectIp(ip)}>{ip}</Button> },
            { title: 'IP 归属地', dataIndex: 'country', render: countryName }, { title: '请求数', dataIndex: 'requests', align: 'right' },
            { title: '拦截数', dataIndex: 'blocked', align: 'right' }]} /></Card>
        <Card title="IP 归属国家 / 地区"><Table<CountryCount> rowKey="country" dataSource={data.countries} pagination={false} query="" columnChooser={false}
          columns={[{ title: '国家 / 地区', dataIndex: 'country', render: countryName }, { title: '请求数', dataIndex: 'requests', align: 'right' }]} />
          <Typography.Text type="secondary">使用 VPN 时显示出口 IP 的归属地。</Typography.Text></Card>
      </div>
    </>}
  </div>
}
function Performance({ hours, setHours }: TimeProps) {
  const activity = useResource<Analytics | null>(guardApi + '/analytics?hours=' + hours, null, { live: false })
  const ms = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' ms'
  return <Card title="业务接口耗时" extra={<Space><Period hours={hours} onChange={setHours} /><Button loading={activity.loading} onClick={activity.reload}>刷新</Button></Space>}>
    <div className="http-guard-stack">
      <Typography.Text type="secondary">按 HTTP 方法和路由模板统计。P95 上界取第 95 百分位所在耗时区间内的实测最大值。</Typography.Text>
      <ErrorNotice error={activity.error} retry={activity.reload} />
      <Table rowKey={row => row.method + ' ' + row.route} dataSource={activity.data?.routes || []} loading={activity.loading}
        columns={[{ title: '方法', dataIndex: 'method' }, { title: '接口', dataIndex: 'route' },
          { title: '样本数', dataIndex: 'requests', align: 'right' }, { title: '5xx 错误', dataIndex: 'errors', align: 'right' },
          { title: '平均耗时', dataIndex: 'avg_ms', align: 'right', render: ms }, { title: 'P95 上界', dataIndex: 'p95_ms', align: 'right', render: ms },
          { title: '最大耗时', dataIndex: 'max_ms', align: 'right', render: ms }]} />
    </div>
  </Card>
}

export default function HttpGuard({ view, onView, onExit, account }: { view: GuardView; onView: (view: GuardView) => void; onExit: () => void; account: string }) {
  const [hours, setHours] = useState(24), [initialIp, setInitialIp] = useState('')
  const [updating, setUpdating] = useState(false), [updateError, setUpdateError] = useState('')
  const policy = useResource<Policy | null>(guardApi + '/settings', null, { live: false })
  const status = useResource<Status | null>(guardApi + '/status', null, { live: false })
  const { message } = App.useApp()
  async function updateGeo() {
    setUpdating(true); setUpdateError('')
    try {
      const geo = await send<Geo>(guardApi + '/geoip/update')
      status.setData(value => value ? { ...value, geo } : value)
      await status.reload(); message.success('GeoIP 数据库已更新')
    } catch (e) { setUpdateError((e as Error).message) }
    finally { setUpdating(false) }
  }
  const info = status.data
  return <div className="guard-workspace">
    <aside className="guard-rail"><div className="guard-identity"><AuditOutlined /><strong>HTTP 防护工作台</strong></div>
      <nav aria-label="防护导航">{views.map(item => <a key={item.key} href={'#/http-guard/' + item.key} aria-current={view === item.key ? 'page' : undefined}
        onClick={() => setInitialIp('')}>{item.icon}<span>{item.name}</span></a>)}</nav>
      <button type="button" className="guard-return" onClick={onExit}><ArrowLeftOutlined />返回管理后台</button>
    </aside>
    <main className="guard-main"><header className="guard-header"><h1>{views.find(item => item.key === view)?.name}</h1>
      <Space wrap>{policy.data && <Tag color={{ off: 'default', observe: 'blue', enforce: 'green' }[policy.data.mode]}>{modeNames[policy.data.mode]}</Tag>}
        <span>{account}</span></Space></header>
      <section className="http-guard-stack">
        <ErrorNotice error={policy.error || status.error} retry={() => { void policy.reload(); void status.reload() }} />
        {view === 'overview' && <TrafficOverview hours={hours} setHours={setHours} inspectIp={ip => { setInitialIp(ip); onView('events') }} />}
        {view === 'events' && <HttpGuardLog hours={hours} setHours={setHours} initialIp={initialIp} clientIp={info?.client_ip} policy={policy.data} onSaved={policy.setData} reloadPolicy={policy.reload} />}
        {view === 'performance' && <Performance hours={hours} setHours={setHours} />}
        {view === 'policies' && <>
          {info?.client_ip && <Typography.Text type="secondary">当前访问 IP <Typography.Text code>{info.client_ip}</Typography.Text></Typography.Text>}
          {policy.data && !policy.error ? <HttpGuardRules key={policy.data.revision} policy={policy.data} onSaved={policy.setData} reload={policy.reload} status={info} /> : policy.loading && <Spin />}
          {info && <div className="http-guard-rankings"><Card title="GeoIP 数据库" extra={<Button disabled={updating} loading={updating} onClick={updateGeo}>{info.geo.ready ? '更新数据库' : '下载数据库'}</Button>}>
            <Space direction="vertical"><Space wrap><Tag color={info.geo.ready ? 'green' : 'default'}>{info.geo.ready ? '已就绪' : '待下载'}</Tag>
              {info.geo.updated_at && <span>最近更新 {dateTime(info.geo.updated_at)}</span>}</Space>
              {info.geo.source && <Typography.Text type="secondary" className="http-guard-source">数据源 {info.geo.source}</Typography.Text>}
              {updateError && <Alert type="error" showIcon message={updateError} />}</Space>
          </Card><Card title="当前进程日志写入" extra={<Button loading={status.loading} onClick={status.reload}>刷新</Button>}>
            <Space wrap size="large"><span>排队 {info.runtime.queued} 条</span><span>已丢弃 {info.runtime.dropped} 条</span><span>写入失败 {info.runtime.write_errors} 次</span>
              {info.runtime.settings_errors > 0 && <span>配置刷新失败 {info.runtime.settings_errors} 次</span>}</Space>
          </Card></div>}
        </>}
      </section>
    </main>
  </div>
}
