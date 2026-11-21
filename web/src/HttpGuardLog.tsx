import { useState } from 'react'
import { Alert, App, Card, Input, Modal, Radio, Select, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { ApiError, send, useResource } from './api'
import { bytes, checkedLogRows, countryName, dateTime, guardApi, numberFormat, periods, selectedSources, type AccessEvent, type Action, type Decision, type Policy } from './httpGuardData'

const decisions: Record<Decision, string> = { pass: '放行', observed: '观察命中', blocked: '已拦截' }
const reasons: Record<string, string> = {
  allow_ip: 'IP 放行', deny_ip: 'IP 封禁', deny_country: '地区封禁', country_not_allowed: '来源地区未获准',
  sensitive_path: '敏感路径', rate_limit: '请求频率超限', sqli: 'SQL 注入', xss: '跨站脚本',
}
const lifetimes = [{ value: 1, label: '1 小时' }, { value: 24, label: '24 小时' }, { value: 168, label: '7 天' }, { value: 0, label: '长期' }]
type Props = {
  hours: number; setHours: (hours: number) => void; initialIp: string; clientIp?: string
  policy: Policy | null; onSaved: (policy: Policy) => void; reloadPolicy: () => Promise<void>
}
export function HttpGuardLog({ hours, setHours, initialIp, clientIp, policy, onSaved, reloadPolicy }: Props) {
  const { message } = App.useApp()
  const [ip, setIp] = useState(initialIp), [input, setInput] = useState(initialIp)
  const [actor, setActor] = useState(''), [actorInput, setActorInput] = useState(''), [reason, setReason] = useState(''), [statusGroup, setStatusGroup] = useState('')
  const [decision, setDecision] = useState<Decision | ''>(''), [pages, setPages] = useState<number[]>([])
  const [selection, setSelection] = useState<AccessEvent[]>([])
  const [open, setOpen] = useState(false), [action, setAction] = useState<Action>('deny'), [ttl, setTtl] = useState(24)
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false)
  const query = new URLSearchParams({ hours: String(hours), limit: '50' })
  if (ip) query.set('ip', ip)
  if (decision) query.set('decision', decision)
  if (actor) query.set('actor', actor)
  if (reason) query.set('reason', reason)
  if (statusGroup) query.set('status_group', statusGroup)
  const before = pages.at(-1)
  if (before) query.set('before', String(before))
  const events = useResource<{ items: AccessEvent[]; next_before: number | null }>(guardApi + '/events?' + query, { items: [], next_before: null }, { live: false })
  const sources = selectedSources(selection)
  const denyingSelf = action === 'deny' && sources.some(row => row.ip === clientIp)
  function resetFilters() { setPages([]); setSelection([]) }
  function applyIp(value: string) { resetFilters(); setIp(value.trim()) }
  async function save() {
    if (!policy || !sources.length || sources.length > 200 || denyingSelf) return
    setSaving(true); setError(''); setConflict(false)
    try {
      const next = await send<Policy>(guardApi + '/event-policy', {
        revision: policy.revision, event_ids: sources.map(row => row.id), action, ttl_hours: ttl,
      })
      onSaved(next); setOpen(false); setSelection([])
      message.success('已保存 ' + sources.length + ' 个来源 IP 的策略')
    } catch (e) { setError((e as Error).message); setConflict(e instanceof ApiError && e.status === 409) }
    finally { setSaving(false) }
  }
  return <Card title="请求记录" extra={<Button onClick={events.reload} loading={events.loading}>刷新</Button>}>
    <div className="http-guard-stack">
      <div className="http-guard-nav"><Space wrap>
        <Select aria-label="日志时段" value={hours} onChange={value => { resetFilters(); setHours(value) }} options={periods} />
        <Input.Search aria-label="按来源 IP 精确查询" placeholder="输入完整 IPv4 或 IPv6" allowClear value={input}
          onChange={e => { setInput(e.target.value); if (!e.target.value) applyIp('') }} onSearch={applyIp} />
        <Select aria-label="处理结果" value={decision} onChange={value => { resetFilters(); setDecision(value) }}
          options={[{ value: '', label: '全部处理结果' }, ...Object.entries(decisions).map(([value, label]) => ({ value, label }))]} />
        <Input.Search aria-label="按账号或用户 ID 精确查询" placeholder="账号或用户 ID" allowClear value={actorInput}
          onChange={e => { setActorInput(e.target.value); if (!e.target.value) { setActor(''); resetFilters() } }}
          onSearch={value => { setActor(value.trim()); resetFilters() }} />
        <Select aria-label="命中规则" value={reason} onChange={value => { resetFilters(); setReason(value) }}
          options={[{ value: '', label: '全部命中规则' }, ...Object.entries(reasons).filter(([code]) => code !== 'allow_ip').map(([value, label]) => ({ value, label }))]} />
        <Select aria-label="状态码分类" value={statusGroup} onChange={value => { resetFilters(); setStatusGroup(value) }}
          options={['', '2', '3', '4', '5'].map(value => ({ value, label: value ? value + 'xx' : '全部状态码' }))} />
      </Space><Space wrap>
        {!!selection.length && <Button type="text" onClick={() => setSelection([])}>清除选择（{selection.length}）</Button>}
        <Button type="primary" disabled={!sources.length || !policy} onClick={() => { setAction('deny'); setTtl(24); setError(''); setConflict(false); setOpen(true) }}>添加来源策略</Button>
      </Space></div>
      <ErrorNotice error={events.error} retry={events.reload} />
      <Table<AccessEvent> rowKey="id" dataSource={events.error ? [] : events.data.items} loading={events.loading} query="" pagination={false}
        rowSelection={{ selectedRowKeys: selection.map(row => row.id), getCheckboxProps: row => ({ disabled: !row.ip }),
          onChange: keys => setSelection(previous => checkedLogRows(previous, events.data.items, keys)) }}
        columns={[{ title: '时间', dataIndex: 'ts', render: (value: number) => dateTime(value) },
          { title: '来源 IP', dataIndex: 'ip' }, { title: '账号', dataIndex: 'actor_label', render: (label: string | null) => label || '—' },
          { title: 'IP 归属地', dataIndex: 'country', render: countryName }, { title: '方法', dataIndex: 'method' },
          { title: '路由', dataIndex: 'route', width: 240, ellipsis: true,
            render: (route: string) => route === '<blocked>' ? '防护层已拦截' : route === '<unmatched>' ? '未匹配路由' : route },
          { title: 'HTTP 状态', dataIndex: 'status' }, { title: '处理结果', dataIndex: 'decision',
            render: (value: Decision) => <Tag color={value === 'blocked' ? 'red' : value === 'observed' ? 'gold' : 'default'}>{decisions[value]}</Tag> },
          { title: '规则', dataIndex: 'reason', render: (reason: string) => reasons[reason] || reason || '—' },
          { title: '耗时', dataIndex: 'duration_ms', render: (ms: number) => numberFormat.format(ms) + ' ms' }, { title: '响应大小', dataIndex: 'bytes_out', render: bytes }]} />
      <Space wrap><Button disabled={!pages.length || events.loading} onClick={() => setPages(p => p.slice(0, -1))}>较新记录</Button>
        <Button disabled={!events.data.next_before || events.loading || !!events.error} onClick={() => { if (events.data.next_before) setPages([...pages, events.data.next_before]) }}>更早记录</Button>
        <Typography.Text type="secondary">每页 50 条</Typography.Text></Space>
    </div>
    <Modal title="批量添加来源策略" open={open} onCancel={() => { if (!saving) setOpen(false) }} onOk={save}
      okText="保存策略" cancelText="取消" confirmLoading={saving} okButtonProps={{ disabled: !policy || !sources.length || sources.length > 200 || denyingSelf }}>
      <div className="http-guard-stack">
        <div>已选 {selection.length} 条日志，涉及 {sources.length} 个来源 IP。</div>
        {sources.length > 200 && <Alert type="warning" showIcon message="每次最多添加 200 个来源 IP，请减少选择后提交。" />}
        {denyingSelf && <Alert type="warning" showIcon message={'所选来源包含你当前的 IP ' + clientIp + '，请取消该地址后再封禁。'} />}
        <div className="guard-ip-preview">{sources.map(row => <Tag key={row.ip}>{row.ip}</Tag>)}</div>
        <div className="guard-control"><label>策略动作</label><Radio.Group aria-label="策略动作" value={action} onChange={e => setAction(e.target.value)}
          options={[{ value: 'deny', label: '封禁 IP' }, { value: 'allow', label: '放行 IP' }]} /></div>
        <div className="guard-control"><label htmlFor="guard-ttl">有效期</label><Select id="guard-ttl" value={ttl} onChange={setTtl} options={lifetimes} /></div>
        {policy?.mode === 'observe' && <Typography.Text type="secondary">当前为观察模式，来源策略仅记录命中情况。</Typography.Text>}
        {policy?.mode === 'off' && <Typography.Text type="secondary">防护当前已关闭，保存的策略将在启用后参与判断。</Typography.Text>}
        {error && <Alert type="error" message={error} showIcon action={conflict && <Button onClick={reloadPolicy}>刷新策略</Button>} />}
      </div>
    </Modal>
  </Card>
}
