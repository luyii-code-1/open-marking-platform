import { useState } from 'react'
import { Alert, App, Card, Form, Input, InputNumber, Radio, Select, Space, Spin, Switch, Tag, Typography } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { ApiError, send, useResource } from './api'
import { confirmLeaving, useUnsavedChanges } from './useNavigation'
import './http-guard.css'

const root = '/system/http-guard'
type Mode = 'off' | 'observe' | 'enforce'
type Decision = 'pass' | 'observed' | 'blocked'
type Policy = {
  mode: Mode
  retention_days: number
  allow_ips: string[]
  deny_ips: string[]
  allow_countries: string[]
  deny_countries: string[]
  rate_per_minute: number
  block_sensitive_paths: boolean
  revision: number
}
type Geo = { ready: boolean; updated_at: number | null; source: string }
type Status = { client_ip: string; geo: Geo; runtime: { queued: number; dropped: number; write_errors: number; settings_errors: number } }
type Bucket = { ts: number; requests: number; observed: number; blocked: number }
type IpCount = { ip: string; country: string; requests: number; blocked: number }
type CountryCount = { country: string; requests: number }
type Overview = {
  requests: number; unique_ips: number; blocked: number; observed: number; server_errors: number
  avg_ms: number; bytes_out: number; series: Bucket[]; top_ips: IpCount[]; countries: CountryCount[]
}
type AccessEvent = {
  id: number; ts: number; ip: string; country: string; method: string; route: string
  status: number; duration_ms: number; bytes_out: number; decision: Decision; reason: string
}
type EventPage = { items: AccessEvent[]; next_before: number | null }

const modeNames: Record<Mode, string> = { off: '已关闭', observe: '观察模式', enforce: '拦截模式' }
const modeHelp: Record<Mode, string> = {
  off: '停止采集新的 HTTP 日志并停用防护规则。', observe: '记录所有请求，标记命中规则的请求并继续放行。',
  enforce: '规则对访问立即生效，命中拦截条件的请求将被拒绝。',
}
const decisions: Record<Decision, string> = { pass: '放行', observed: '观察命中', blocked: '已拦截' }
const reasons: Record<string, string> = {
  allow_ip: 'IP 放行', deny_ip: 'IP 封禁', deny_country: '地区封禁', country_not_allowed: '来源地区未获准',
  sensitive_path: '敏感路径', rate_limit: '请求频率超限',
}
const periods = [{ value: 1, label: '近 1 小时' }, { value: 24, label: '近 24 小时' }, { value: 168, label: '近 7 天' }, { value: 720, label: '近 30 天' }, { value: 0, label: '全部保留期' }]
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' })
function countryName(code: string) {
  if (!code || !/^[A-Z]{2}$/.test(code) || code === 'ZZ') return '未知地区'
  return regionNames.of(code) || code
}
function dateTime(seconds: number, compact = false) {
  return new Date(seconds * 1000).toLocaleString('zh-CN', { year: compact ? undefined : 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: compact ? undefined : '2-digit', hour12: false })
}
function bytes(value: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return numberFormat.format(value) + ' ' + units[unit]
}
function Period({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  return <Select aria-label="统计时段" value={hours} onChange={onChange} options={periods} />
}
function Trend({ series }: { series: Bucket[] }) {
  const max = Math.max(1, ...series.map(bucket => bucket.requests))
  if (!series.some(bucket => bucket.requests)) return <Typography.Text type="secondary">所选时段暂无请求。</Typography.Text>
  return <figure className="http-guard-trend">
    <figcaption><span>峰值 {numberFormat.format(max)} 次 / 时段</span>
      <span className="http-guard-legend"><i className="pass" />放行<i className="observed" />观察命中<i className="blocked" />已拦截</span>
    </figcaption>
    <div className="http-guard-bars" role="img" aria-label={'各时段请求量，最高 ' + max + ' 次'}>
      {series.map(bucket => <div className="http-guard-bin" key={bucket.ts}
        title={dateTime(bucket.ts) + ' 起 · ' + bucket.requests + ' 次请求 · 观察命中 ' + bucket.observed + ' 次 · 拦截 ' + bucket.blocked + ' 次'}>
        <i className="pass" style={{ height: Math.max(0, bucket.requests - bucket.observed - bucket.blocked) / max * 100 + '%' }} />
        <i className="observed" style={{ height: bucket.observed / max * 100 + '%' }} />
        <i className="blocked" style={{ height: bucket.blocked / max * 100 + '%' }} />
      </div>)}
    </div>
    <div className="http-guard-axis"><span>{dateTime(series[0].ts, true)}</span><span>{dateTime(series[series.length - 1].ts, true)}</span></div>
  </figure>
}

function TrafficOverview({ hours, setHours, inspectIp }: { hours: number; setHours: (hours: number) => void; inspectIp: (ip: string) => void }) {
  const resource = useResource<Overview | null>(root + '/overview?hours=' + hours, null, { live: false })
  const data = resource.data
  return <div className="http-guard-stack">
    <Card title="流量概览" extra={<Space><Period hours={hours} onChange={setHours} /><Button loading={resource.loading} onClick={resource.reload}>刷新</Button></Space>}>
      <ErrorNotice error={resource.error} retry={resource.reload} />
      {data ? <dl className="http-guard-metrics">{[
        ['请求总数', numberFormat.format(data.requests)], ['来源 IP 数', numberFormat.format(data.unique_ips)],
        ['观察命中', numberFormat.format(data.observed)], ['已拦截', numberFormat.format(data.blocked)],
        ['服务端错误（5xx）', numberFormat.format(data.server_errors)], ['平均耗时', numberFormat.format(data.avg_ms) + ' ms'],
        ['响应流量', bytes(data.bytes_out)],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : !resource.error && <Spin />}
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
          <Typography.Text type="secondary">地区按来源 IP 统计。使用 VPN 时显示出口 IP 的归属地。</Typography.Text></Card>
      </div>
    </>}
  </div>
}

function AccessLog({ hours, setHours, initialIp }: { hours: number; setHours: (hours: number) => void; initialIp: string }) {
  const [ip, setIp] = useState(initialIp), [input, setInput] = useState(initialIp)
  const [decision, setDecision] = useState<Decision | ''>(''), [pages, setPages] = useState<number[]>([])
  const before = pages.at(-1)
  const query = new URLSearchParams({ hours: String(hours), limit: '50' })
  if (ip) query.set('ip', ip)
  if (decision) query.set('decision', decision)
  if (before) query.set('before', String(before))
  const events = useResource<EventPage>(root + '/events?' + query, { items: [], next_before: null }, { live: false })
  function applyIp(value: string) { setPages([]); setIp(value.trim()) }
  return <Card title="访问日志" extra={<Button onClick={events.reload} loading={events.loading}>刷新</Button>}>
    <div className="http-guard-stack">
      <Space wrap><Period hours={hours} onChange={value => { setPages([]); setHours(value) }} />
        <Input.Search aria-label="按来源 IP 精确查询" placeholder="输入完整 IPv4 或 IPv6" allowClear value={input}
          onChange={e => { setInput(e.target.value); if (!e.target.value) { setPages([]); setIp('') } }} onSearch={applyIp} />
        <Select aria-label="按处理结果筛选" value={decision} onChange={value => { setPages([]); setDecision(value) }}
          options={[{ value: '', label: '全部处理结果' }, ...Object.entries(decisions).map(([value, label]) => ({ value, label }))]} />
      </Space>
      <ErrorNotice error={events.error} retry={events.reload} />
      <Table<AccessEvent> rowKey="id" dataSource={events.error ? [] : events.data.items} loading={events.loading} query="" pagination={false}
        columns={[{ title: '时间', dataIndex: 'ts', render: (value: number) => dateTime(value) },
          { title: '来源 IP', dataIndex: 'ip' }, { title: 'IP 归属地', dataIndex: 'country', render: countryName },
          { title: '方法', dataIndex: 'method' }, { title: '路由', dataIndex: 'route', width: 240, ellipsis: true,
            render: (route: string) => route === '<blocked>' ? '防护层已拦截' : route === '<unmatched>' ? '未匹配路由' : route },
          { title: 'HTTP 状态', dataIndex: 'status' },
          { title: '处理结果', dataIndex: 'decision', render: (value: Decision) => <Tag color={value === 'blocked' ? 'red' : value === 'observed' ? 'gold' : 'default'}>{decisions[value]}</Tag> },
          { title: '规则', dataIndex: 'reason', render: (reason: string) => reasons[reason] || reason || '—' },
          { title: '耗时', dataIndex: 'duration_ms', render: (ms: number) => numberFormat.format(ms) + ' ms' },
          { title: '响应大小', dataIndex: 'bytes_out', render: bytes }]} />
      <Space wrap><Button disabled={!pages.length || events.loading} onClick={() => setPages(p => p.slice(0, -1))}>较新记录</Button>
        <Button disabled={!events.data.next_before || events.loading || !!events.error} onClick={() => { if (events.data.next_before) setPages([...pages, events.data.next_before]) }}>更早记录</Button>
        <Typography.Text type="secondary">每页 50 条</Typography.Text></Space>
    </div>
  </Card>
}

type ListKey = 'allow_ips' | 'deny_ips' | 'allow_countries' | 'deny_countries'
type PolicyForm = Omit<Policy, ListKey | 'revision'> & Record<ListKey, string>
const listFields: { key: ListKey; label: string; hint: string }[] = [
  { key: 'allow_ips', label: '放行 IP / 网段', hint: '每行一个 IP 或 CIDR 网段。命中后优先放行。' },
  { key: 'deny_ips', label: '封禁 IP / 网段', hint: '每行一个 IPv4、IPv6 或 CIDR 网段。' },
  { key: 'allow_countries', label: '允许的 IP 归属国家 / 地区', hint: '填写两位地区代码，如 CN、SG。留空时允许所有地区。填写后，未知地区也会命中规则。' },
  { key: 'deny_countries', label: '封禁的 IP 归属国家 / 地区', hint: '填写两位地区代码，以换行、空格或逗号分隔。' },
]
function splitList(text: string, upper = false) {
  return [...new Set((upper ? text.toUpperCase() : text).split(/[\s,，]+/).filter(Boolean))]
}
function GuardPolicy({ policy, onSaved, reload, geoReady }: { policy: Policy; onSaved: (policy: Policy) => void; reload: () => Promise<void>; geoReady: boolean }) {
  const [form] = Form.useForm<PolicyForm>(), { message } = App.useApp()
  const [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState(''), [conflict, setConflict] = useState(false)
  const mode = Form.useWatch('mode', form) || policy.mode
  useUnsavedChanges(dirty)
  async function save(value: PolicyForm) {
    setSaving(true); setError(''); setConflict(false)
    try {
      const next = await send<Policy>(root + '/settings', {
        ...value, revision: policy.revision, allow_ips: splitList(value.allow_ips), deny_ips: splitList(value.deny_ips),
        allow_countries: splitList(value.allow_countries, true), deny_countries: splitList(value.deny_countries, true),
      }, 'PUT')
      setDirty(false); onSaved(next); message.success('HTTP 防护设置已保存')
    } catch (e) { setError((e as Error).message); setConflict(e instanceof ApiError && e.status === 409) }
    finally { setSaving(false) }
  }
  return <Card title="防护策略">
    <Form layout="vertical" form={form} disabled={saving} onValuesChange={() => setDirty(true)} onFinish={save}
      initialValues={{ ...policy, allow_ips: policy.allow_ips.join('\n'), deny_ips: policy.deny_ips.join('\n'),
        allow_countries: policy.allow_countries.join(' '), deny_countries: policy.deny_countries.join(' ') }}>
      <Form.Item name="mode" label="运行模式" extra={modeHelp[mode as Mode]}>
        <Radio.Group optionType="button" buttonStyle="solid" options={[{ value: 'off', label: '关闭' }, { value: 'observe', label: '观察' }, { value: 'enforce', label: '拦截' }]} />
      </Form.Item>
      <div className="http-guard-fields">
        {listFields.map(({ key, label, hint }) => <Form.Item key={key} name={key} label={label} extra={hint}
          rules={key.endsWith('countries') ? [{ validator: (_, value: string) => splitList(value || '', true).every(code => /^[A-Z]{2}$/.test(code))
            ? Promise.resolve() : Promise.reject(new Error('请使用两位英文字母地区代码')) }] : undefined}>
          <Input.TextArea rows={2} spellCheck={false} />
        </Form.Item>)}
        <Form.Item name="rate_per_minute" label="单个 IP 每分钟请求上限" extra="每个服务进程独立计数。填 0 关闭限流。"
          rules={[{ required: true, message: '请输入请求上限' }]}>
          <InputNumber min={0} max={1000000} precision={0} />
        </Form.Item>
        <Form.Item name="retention_days" label="日志保留天数" extra="可设为 1 至 365 天。到期日志将自动清理。"
          rules={[{ required: true, message: '请输入保留天数' }]}>
          <InputNumber min={1} max={365} precision={0} addonAfter="天" />
        </Form.Item>
      </div>
      <Form.Item name="block_sensitive_paths" label="敏感路径防护" valuePropName="checked" extra="对访问版本库目录、环境配置和凭据文件的请求应用防护规则。"><Switch /></Form.Item>
      {!geoReady && <Alert className="http-guard-form-note" type="info" showIcon message="启用地区策略前，请先下载 GeoIP 数据库。" />}
      {error && <Alert className="http-guard-form-note" type="error" showIcon message={error}
        action={conflict && <Button size="small" onClick={reload}>载入最新设置</Button>} />}
      <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty || conflict}>保存防护设置</Button>
    </Form>
  </Card>
}

export default function HttpGuard() {
  const [view, setView] = useState('overview'), [hours, setHours] = useState(24), [initialIp, setInitialIp] = useState('')
  const [updating, setUpdating] = useState(false), [updateError, setUpdateError] = useState('')
  const policy = useResource<Policy | null>(root + '/settings', null, { live: false })
  const status = useResource<Status | null>(root + '/status', null, { live: false })
  const { message } = App.useApp()
  function changeView(next: string) { if (next !== view && confirmLeaving()) { setInitialIp(''); setView(next) } }
  async function updateGeo() {
    setUpdating(true); setUpdateError('')
    try {
      const geo = await send<Geo>(root + '/geoip/update')
      status.setData(value => value ? { ...value, geo } : value)
      await status.reload()
      message.success('GeoIP 数据库已更新')
    } catch (e) { setUpdateError((e as Error).message) }
    finally { setUpdating(false) }
  }
  const info = status.data
  return <section className="http-guard-stack">
    <div className="http-guard-nav">
      <Radio.Group aria-label="HTTP 防护视图" optionType="button" buttonStyle="solid" value={view} onChange={e => changeView(e.target.value)}
        options={[{ value: 'overview', label: '概览' }, { value: 'events', label: '访问日志' }, { value: 'policy', label: '防护设置' }]} />
      <Space wrap>{policy.data && <Tag color={{ off: 'default', observe: 'blue', enforce: 'green' }[policy.data.mode]}>{modeNames[policy.data.mode]}</Tag>}
        {info?.client_ip && <Typography.Text type="secondary">当前访问 IP <Typography.Text code>{info.client_ip}</Typography.Text></Typography.Text>}</Space>
    </div>
    <ErrorNotice error={policy.error || status.error} retry={() => { void policy.reload(); void status.reload() }} />
    {view === 'overview' && <TrafficOverview hours={hours} setHours={setHours} inspectIp={ip => { setInitialIp(ip); setView('events') }} />}
    {view === 'events' && <AccessLog initialIp={initialIp} hours={hours} setHours={setHours} />}
    {view === 'policy' && <>
      {policy.data && !policy.error ? <GuardPolicy key={policy.data.revision} policy={policy.data} onSaved={policy.setData} reload={policy.reload} geoReady={!!info?.geo.ready} />
        : policy.loading && <Spin />}
      {info && <Card title="GeoIP 数据库" extra={<Button disabled={updating} loading={updating} onClick={updateGeo}>{info.geo.ready ? '更新数据库' : '下载数据库'}</Button>}>
        <Space direction="vertical">
          <Space wrap><Tag color={info.geo.ready ? 'green' : 'default'}>{info.geo.ready ? '已就绪' : '待下载'}</Tag>
            {info.geo.updated_at && <span>最近更新 {dateTime(info.geo.updated_at)}</span>}</Space>
          {info.geo.source && <Typography.Text type="secondary" className="http-guard-source">数据源 {info.geo.source}</Typography.Text>}
          {updateError && <Alert type="error" showIcon message={updateError} />}
        </Space>
      </Card>}
      {info && <Card title="当前进程日志写入" extra={<Button loading={status.loading} onClick={status.reload}>刷新</Button>}>
        <Space wrap size="large"><span>排队 {info.runtime.queued} 条</span><span>已丢弃 {info.runtime.dropped} 条</span><span>写入失败 {info.runtime.write_errors} 次</span>
          {info.runtime.settings_errors > 0 && <span>配置刷新失败 {info.runtime.settings_errors} 次</span>}</Space>
      </Card>}
    </>}
  </section>
}
