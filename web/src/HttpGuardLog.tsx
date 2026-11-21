import { useMemo, useState } from 'react'
import { Alert, App, Card, Input, Modal, Radio, Select, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { ApiError, send, useResource } from './api'
import {
  bytes,
  checkedLogRows,
  countryName,
  dateTime,
  guardApi,
  numberFormat,
  periods,
  removeSelectedIp,
  selectedSources,
  type AccessEvent,
  type Action,
  type Decision,
  type Policy,
} from './httpGuardData'

const decisions: Record<Decision, string> = { pass: '放行', observed: '观察命中', blocked: '已拦截' }
const reasons: Record<string, string> = {
  allow_ip: 'IP 放行',
  deny_ip: 'IP 封禁',
  deny_country: '地区封禁',
  country_not_allowed: '来源地区未获准',
  sensitive_path: '敏感路径',
  rate_limit: '请求频率超限',
  sqli: 'SQL 注入',
  xss: '跨站脚本',
}
const lifetimes = [
  { value: 1, label: '1 小时' },
  { value: 24, label: '24 小时' },
  { value: 168, label: '7 天' },
  { value: 0, label: '长期' },
]

function statusTone(code: number) {
  if (code >= 500) return 'red'
  if (code >= 400) return 'orange'
  if (code >= 300) return 'blue'
  return 'default'
}

type Props = {
  hours: number
  setHours: (hours: number) => void
  initialIp: string
  clientIp?: string
  policy: Policy | null
  onSaved: (policy: Policy) => void
  reloadPolicy: () => Promise<void>
}

export function HttpGuardLog({ hours, setHours, initialIp, clientIp, policy, onSaved, reloadPolicy }: Props) {
  const { message } = App.useApp()
  const [ip, setIp] = useState(initialIp)
  const [input, setInput] = useState(initialIp)
  const [actor, setActor] = useState('')
  const [actorInput, setActorInput] = useState('')
  const [reason, setReason] = useState('')
  const [statusGroup, setStatusGroup] = useState('')
  const [decision, setDecision] = useState<Decision | ''>('')
  const [pages, setPages] = useState<number[]>([])
  const [selection, setSelection] = useState<AccessEvent[]>([])
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<Action>('deny')
  const [ttl, setTtl] = useState(24)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)

  const query = new URLSearchParams({ hours: String(hours), limit: '50' })
  if (ip) query.set('ip', ip)
  if (decision) query.set('decision', decision)
  if (actor) query.set('actor', actor)
  if (reason) query.set('reason', reason)
  if (statusGroup) query.set('status_group', statusGroup)
  const before = pages.at(-1)
  if (before) query.set('before', String(before))

  const events = useResource<{ items: AccessEvent[]; next_before: number | null }>(
    guardApi + '/events?' + query,
    { items: [], next_before: null },
    { live: false },
  )

  const sources = useMemo(() => selectedSources(selection), [selection])
  const denyingSelf = action === 'deny' && !!clientIp && sources.some(row => row.ip === clientIp)
  const hasFilters = !!(ip || actor || decision || reason || statusGroup)

  const existingIpState = useMemo(() => {
    const map = new Map<string, string>()
    if (!policy) return map
    for (const addr of policy.allow_ips) map.set(addr, '静态放行')
    for (const addr of policy.deny_ips) map.set(addr, '静态封禁')
    for (const item of policy.managed_ips) map.set(item.ip, item.action === 'allow' ? '已放行' : '已封禁')
    return map
  }, [policy])

  function resetPagination() {
    setPages([])
    setSelection([])
  }

  function applyIp(value: string) {
    const trimmed = value.trim()
    setInput(trimmed)
    setIp(trimmed)
    resetPagination()
  }

  function applyActor(value: string) {
    const trimmed = value.trim()
    setActorInput(trimmed)
    setActor(trimmed)
    resetPagination()
  }

  function clearAllFilters() {
    setIp('')
    setInput('')
    setActor('')
    setActorInput('')
    setReason('')
    setStatusGroup('')
    setDecision('')
    resetPagination()
  }

  function openBatchModal() {
    setAction('deny')
    setTtl(24)
    setError('')
    setConflict(false)
    setOpen(true)
  }

  async function save() {
    if (!policy || !sources.length || sources.length > 200 || denyingSelf) return
    setSaving(true)
    setError('')
    setConflict(false)
    try {
      const next = await send<Policy>(guardApi + '/event-policy', {
        revision: policy.revision,
        event_ids: sources.map(row => row.id),
        action,
        ttl_hours: ttl,
      })
      onSaved(next)
      setOpen(false)
      setSelection([])
      message.success('已保存 ' + sources.length + ' 个来源 IP 的策略')
    } catch (e) {
      setError((e as Error).message)
      setConflict(e instanceof ApiError && e.status === 409)
    } finally {
      setSaving(false)
    }
  }

  const ttlLabel = lifetimes.find(item => item.value === ttl)?.label || `${ttl} 小时`

  return (
    <Card title="请求记录" extra={<Button onClick={events.reload} loading={events.loading}>刷新</Button>}>
      <div className="http-guard-stack">
        <div className="guard-log-filters">
          <Select
            aria-label="日志时段"
            value={hours}
            onChange={value => {
              resetPagination()
              setHours(value)
            }}
            options={periods}
          />
          <Input.Search
            aria-label="按来源 IP 精确查询"
            placeholder="精确 IPv4 / IPv6"
            allowClear
            value={input}
            onChange={e => {
              setInput(e.target.value)
              if (!e.target.value) applyIp('')
            }}
            onSearch={applyIp}
          />
          <Input.Search
            aria-label="按账号或用户 ID 精确查询"
            placeholder="账号或用户 ID"
            allowClear
            value={actorInput}
            onChange={e => {
              setActorInput(e.target.value)
              if (!e.target.value) applyActor('')
            }}
            onSearch={applyActor}
          />
          <Select
            aria-label="处理结果"
            value={decision}
            onChange={value => {
              resetPagination()
              setDecision(value)
            }}
            options={[
              { value: '', label: '全部处理结果' },
              ...Object.entries(decisions).map(([value, label]) => ({ value, label })),
            ]}
          />
          <Select
            aria-label="命中规则"
            value={reason}
            onChange={value => {
              resetPagination()
              setReason(value)
            }}
            options={[
              { value: '', label: '全部命中规则' },
              ...Object.entries(reasons)
                .filter(([code]) => code !== 'allow_ip')
                .map(([value, label]) => ({ value, label })),
            ]}
          />
          <Select
            aria-label="状态码分类"
            value={statusGroup}
            onChange={value => {
              resetPagination()
              setStatusGroup(value)
            }}
            options={['', '2', '3', '4', '5'].map(value => ({
              value,
              label: value ? value + 'xx' : '全部状态码',
            }))}
          />
        </div>

        {hasFilters && (
          <div className="guard-active-filters">
            <span className="guard-filter-label">当前筛选：</span>
            {ip && <Tag closable onClose={() => applyIp('')}>IP：{ip}</Tag>}
            {actor && <Tag closable onClose={() => applyActor('')}>账号：{actor}</Tag>}
            {decision && (
              <Tag closable onClose={() => { setDecision(''); resetPagination() }}>
                结果：{decisions[decision]}
              </Tag>
            )}
            {reason && (
              <Tag closable onClose={() => { setReason(''); resetPagination() }}>
                规则：{reasons[reason] || reason}
              </Tag>
            )}
            {statusGroup && (
              <Tag closable onClose={() => { setStatusGroup(''); resetPagination() }}>
                状态码：{statusGroup}xx
              </Tag>
            )}
            <Button type="link" size="small" onClick={clearAllFilters}>重置筛选</Button>
          </div>
        )}

        {selection.length > 0 && (
          <div className="guard-selection-bar" role="region" aria-label="跨页勾选操作栏">
            <div className="guard-selection-summary">
              <strong>
                已跨页勾选 {selection.length} 条日志，去重后涉及 {sources.length} 个来源 IP
              </strong>
              {sources.length > 200 && (
                <Tag color="warning">已超出单次 200 个 IP 上限，请减少勾选</Tag>
              )}
              <div className="guard-selection-chips">
                {sources.slice(0, 8).map(row => (
                  <Tag
                    key={row.ip}
                    closable
                    onClose={e => {
                      e.preventDefault()
                      setSelection(prev => removeSelectedIp(prev, row.ip))
                    }}
                  >
                    <span className="guard-mono">{row.ip}</span>
                  </Tag>
                ))}
                {sources.length > 8 && <Tag>+{sources.length - 8} 个 IP</Tag>}
              </div>
            </div>
            <Space wrap>
              <Button size="small" onClick={() => setSelection([])}>清除选择</Button>
              <Button type="primary" disabled={!sources.length || !policy} onClick={openBatchModal}>
                批量添加来源策略（{sources.length}）
              </Button>
            </Space>
          </div>
        )}

        <ErrorNotice error={events.error} retry={events.reload} />

        <Table<AccessEvent>
          rowKey="id"
          dataSource={events.error ? [] : events.data.items}
          loading={events.loading}
          query=""
          pagination={false}
          rowSelection={{
            selectedRowKeys: selection.map(row => row.id),
            getCheckboxProps: row => ({ disabled: !row.ip }),
            onChange: keys => setSelection(previous => checkedLogRows(previous, events.data.items, keys)),
          }}
          columns={[
            { title: '时间', dataIndex: 'ts', render: (value: number) => <span className="guard-mono">{dateTime(value)}</span> },
            {
              title: '来源 IP',
              dataIndex: 'ip',
              render: (value: string) =>
                value ? (
                  <Button type="link" size="small" className="guard-ip-link" onClick={() => applyIp(value)} title="点击按此 IP 筛选">
                    <span className="guard-mono">{value}</span>
                  </Button>
                ) : '—',
            },
            { title: '账号', dataIndex: 'actor_label', render: (label: string | null) => label || '—' },
            { title: 'IP 归属地', dataIndex: 'country', render: countryName },
            { title: '方法', dataIndex: 'method', render: (m: string) => <span className="guard-mono">{m}</span> },
            {
              title: '路由',
              dataIndex: 'route',
              width: 240,
              ellipsis: true,
              render: (route: string) =>
                route === '<blocked>'
                  ? '防护层已拦截'
                  : route === '<unmatched>'
                    ? '未匹配路由'
                    : <span className="guard-mono">{route}</span>,
            },
            {
              title: 'HTTP 状态',
              dataIndex: 'status',
              render: (code: number) => <Tag color={statusTone(code)} className="guard-mono">{code}</Tag>,
            },
            {
              title: '处理结果',
              dataIndex: 'decision',
              render: (value: Decision) => (
                <Tag color={value === 'blocked' ? 'red' : value === 'observed' ? 'gold' : 'default'}>
                  {decisions[value]}
                </Tag>
              ),
            },
            { title: '规则', dataIndex: 'reason', render: (value: string) => reasons[value] || value || '—' },
            {
              title: '耗时',
              dataIndex: 'duration_ms',
              align: 'right',
              render: (ms: number) => <span className="guard-mono">{numberFormat.format(ms)} ms</span>,
            },
            {
              title: '响应大小',
              dataIndex: 'bytes_out',
              align: 'right',
              render: (v: number) => <span className="guard-mono">{bytes(v)}</span>,
            },
          ]}
        />

        <div className="http-guard-nav">
          <Space wrap>
            <Button disabled={!pages.length || events.loading} onClick={() => setPages(p => p.slice(0, -1))}>
              较新记录
            </Button>
            <Button
              disabled={!events.data.next_before || events.loading || !!events.error}
              onClick={() => {
                if (events.data.next_before) setPages([...pages, events.data.next_before])
              }}
            >
              更早记录
            </Button>
            <Typography.Text type="secondary">
              第 {pages.length + 1} 页 · 每页 50 条
              {selection.length > 0 ? ` · 已跨页选中 ${selection.length} 条` : ''}
            </Typography.Text>
          </Space>
        </div>
      </div>

      <Modal
        title="批量添加来源策略"
        open={open}
        width={600}
        onCancel={() => { if (!saving) setOpen(false) }}
        onOk={save}
        okText={action === 'deny' ? '确认封禁' : '确认放行'}
        cancelText="取消"
        confirmLoading={saving}
        okButtonProps={{
          danger: action === 'deny',
          disabled: !policy || !sources.length || sources.length > 200 || denyingSelf,
        }}
      >
        <div className="http-guard-stack">
          <div className="guard-modal-summary">
            <span>已选 <strong>{selection.length}</strong> 条日志，去重后涉及 <strong>{sources.length}</strong> 个精确来源 IP</span>
            {sources.length > 0 && (
              <Typography.Text type="secondary">
                将执行精确 IP {action === 'deny' ? '封禁' : '放行'}（{ttlLabel}）
              </Typography.Text>
            )}
          </div>

          {sources.length > 200 && (
            <Alert type="warning" showIcon message="每次最多添加 200 个来源 IP，请减少选择后提交。" />
          )}

          {denyingSelf && clientIp && (
            <Alert
              type="warning"
              showIcon
              message={`所选来源包含你当前的 IP ${clientIp}，请移除该地址后再封禁。`}
              action={
                <Button size="small" onClick={() => setSelection(prev => removeSelectedIp(prev, clientIp))}>
                  移除当前 IP
                </Button>
              }
            />
          )}

          <div className="guard-ip-preview" aria-label="待处理来源 IP 预览">
            {sources.map(row => {
              const isSelf = !!clientIp && row.ip === clientIp
              const current = existingIpState.get(row.ip)
              return (
                <Tag
                  key={row.ip}
                  color={isSelf && action === 'deny' ? 'error' : current ? 'processing' : undefined}
                  closable={sources.length > 1}
                  onClose={e => {
                    e.preventDefault()
                    setSelection(prev => removeSelectedIp(prev, row.ip))
                  }}
                >
                  <span className="guard-mono">{row.ip}</span>
                  {isSelf ? '（当前）' : current ? `（${current}）` : ''}
                </Tag>
              )
            })}
          </div>

          <div className="guard-modal-controls">
            <div className="guard-control">
              <label>策略动作</label>
              <Radio.Group
                aria-label="策略动作"
                optionType="button"
                buttonStyle="solid"
                value={action}
                onChange={e => setAction(e.target.value)}
                options={[
                  { value: 'deny', label: '封禁 IP' },
                  { value: 'allow', label: '放行 IP' },
                ]}
              />
            </div>
            <div className="guard-control">
              <label htmlFor="guard-ttl">有效期</label>
              <Radio.Group
                id="guard-ttl"
                optionType="button"
                value={ttl}
                onChange={e => setTtl(e.target.value)}
                options={lifetimes}
              />
            </div>
          </div>

          {policy?.mode === 'observe' && (
            <Typography.Text type="secondary">当前为观察模式，来源策略仅记录命中情况，不会实际阻断请求。</Typography.Text>
          )}
          {policy?.mode === 'off' && (
            <Typography.Text type="secondary">防护当前已关闭，保存的策略将在启用后参与判断。</Typography.Text>
          )}
          {error && (
            <Alert
              type="error"
              message={error}
              showIcon
              action={conflict && <Button size="small" onClick={reloadPolicy}>刷新策略</Button>}
            />
          )}
        </div>
      </Modal>
    </Card>
  )
}
