import { useState } from 'react'
import { Alert, App, Card, Form, InputNumber, Popconfirm, Radio, Select, Space, Switch, Tabs, Tag } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { ApiError, send, useResource } from './api'
import { useUnsavedChanges } from './useNavigation'
import { countryName, dateTime, guardApi, type ManagedIp, type Mode, type Policy, type Status } from './httpGuardData'

const modes = [{ value: 'off', label: '关闭' }, { value: 'observe', label: '观察' }, { value: 'enforce', label: '拦截' }]
const modeHelp: Record<Mode, string> = {
  off: '暂停请求采集与防护。', observe: '采集请求并记录规则命中，流量继续放行。',
  enforce: '执行来源、限流和敏感路径策略。内容检测按照各自的模式处理。',
}
const countryCodes = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT ' +
  'JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM ' +
  'MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR ' +
  'PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ ' +
  'TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK').split(' ')
const countryOptions = countryCodes.map(value => ({ value, label: countryName(value) + ' · ' + value })).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
type PolicyForm = Omit<Policy, 'managed_ips' | 'revision'>
type Change = { id: number; ts: number; actor: string; summary: string; ips: string[] }
type Props = { policy: Policy; onSaved: (policy: Policy) => void; reload: () => Promise<void>; status: Status | null }

function PresetNumber({ value, onChange, presets, min, max, unit, id }: {
  value?: number | null; onChange?: (value: number | null) => void; presets: number[]; min: number; max: number; unit: string; id?: string
}) {
  const [custom, setCustom] = useState(value != null && !presets.includes(value))
  const editing = custom || value != null && !presets.includes(value)
  return <Space wrap><Select id={id} value={editing ? 'custom' : value} onChange={next => {
      setCustom(next === 'custom')
      if (typeof next === 'number') onChange?.(next)
    }} options={[...presets.map(n => ({ value: n as number | string, label: n === 0 ? '关闭' : n + ' ' + unit })), { value: 'custom', label: '自定义' }]} />
    {editing && <InputNumber aria-label={'自定义数值（' + unit + '）'} min={min} max={max} precision={0} value={value} onChange={onChange} addonAfter={unit} />}
  </Space>
}

export function HttpGuardRules({ policy, onSaved, reload, status }: Props) {
  const [form] = Form.useForm<PolicyForm>(), { message } = App.useApp()
  const [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [removing, setRemoving] = useState('')
  const [error, setError] = useState(''), [removeError, setRemoveError] = useState(''), [conflict, setConflict] = useState(false)
  const mode: Mode = Form.useWatch('mode', form) || policy.mode
  useUnsavedChanges(dirty)
  const history = useResource<{ items: Change[] }>(guardApi + '/policy-history', { items: [] }, { live: false })
  async function save(values: PolicyForm) {
    setSaving(true); setError(''); setConflict(false)
    try {
      const next = await send<Policy>(guardApi + '/settings', { ...values, revision: policy.revision }, 'PUT')
      setDirty(false); onSaved(next); message.success('防护策略已保存')
    } catch (e) { setError((e as Error).message); setConflict(e instanceof ApiError && e.status === 409) }
    finally { setSaving(false) }
  }
  async function remove(ip: string) {
    setRemoving(ip); setRemoveError('')
    try {
      onSaved(await send<Policy>(guardApi + '/remove-policy', { revision: policy.revision, ip }))
      message.success('已撤销来源策略')
    } catch (e) { setRemoveError((e as Error).message) }
    finally { setRemoving('') }
  }
  const ipOptions = [...new Set([...policy.allow_ips, ...policy.deny_ips, ...policy.managed_ips.map(row => row.ip)])].map(value => ({ value, label: value }))
  const regionOptions = [...countryOptions, ...[...new Set([...policy.allow_countries, ...policy.deny_countries])].filter(value => !countryCodes.includes(value)).map(value => ({ value, label: value }))]
  return <>
    <Card title="策略编辑">
      <Form layout="vertical" form={form} disabled={saving || !!removing} onValuesChange={() => setDirty(true)} onFinish={save} initialValues={policy}>
        <Tabs items={[
          { key: 'access', label: '来源访问', forceRender: true, children: <div className="http-guard-fields">
            {(['allow_ips', 'deny_ips'] as const).map((key, i) => <Form.Item key={key} name={key} label={i ? '封禁 IP / 网段' : '放行 IP / 网段'}
              extra={i ? '选择地址，或输入 IPv4、IPv6 或 CIDR 后按回车。' : '优先放行来源、限流和敏感路径规则。内容检测仍按自身模式执行。'}>
              <Select mode="tags" aria-label={i ? '封禁 IP' : '放行 IP'} options={ipOptions} tokenSeparators={[' ', ',', '，', '\n']} maxTagCount={6} placeholder="选择或添加 IP / CIDR" />
            </Form.Item>)}
            {(['allow_countries', 'deny_countries'] as const).map((key, i) => <Form.Item key={key} name={key}
              label={i ? '封禁的 IP 归属地' : '允许的 IP 归属地'} extra={i ? '来源地区由 GeoIP 数据库解析。' : '留空时允许全部地区。启用后，未列出及未知的地区均会命中规则。'}>
              <Select mode="multiple" allowClear showSearch optionFilterProp="label" options={regionOptions} maxTagCount={6} placeholder="搜索地区名称或代码" />
            </Form.Item>)}
            {!status?.geo.ready && <Alert className="http-guard-form-note" type="info" showIcon message="启用地区拦截前，请先下载 GeoIP 数据库。" />}
          </div> },
          { key: 'content', label: '请求检测', forceRender: true, children: <>
            <Space className="http-guard-form-note" wrap><Tag color={status?.engine?.ready ? 'green' : 'default'}>{status?.engine?.ready ? '引擎已就绪' : '引擎未就绪'}</Tag>
              {status?.engine?.version && <span>libinjection {status.engine.version}</span>}</Space>
            <div className="http-guard-fields">{(['sqli_mode', 'xss_mode'] as const).map((key, i) => <Form.Item key={key} name={key} label={i ? '跨站脚本（XSS）' : 'SQL 注入（SQLi）'}
              extra="全局观察模式下仅记录命中。全局拦截模式下按此选项执行。"><Radio.Group optionType="button" buttonStyle="solid" options={modes} /></Form.Item>)}
            <Form.Item name="block_sensitive_paths" label="敏感路径防护" valuePropName="checked" extra="保护版本库目录、环境配置和凭据文件。"><Switch /></Form.Item></div>
          </> },
          { key: 'global', label: '运行设置', forceRender: true, children: <>
            <Form.Item name="mode" label="全局运行模式" extra={modeHelp[mode]}><Radio.Group optionType="button" buttonStyle="solid" options={modes} /></Form.Item>
            <div className="http-guard-fields">
              <Form.Item name="rate_per_minute" label="单个 IP 每分钟请求上限" extra="每个服务进程独立计数。" rules={[{ required: true, type: 'integer', min: 0, max: 1000000, message: '请输入 0 至 1000000 的整数' }]}>
                <PresetNumber presets={[0, 60, 120, 300, 600, 1200]} min={0} max={1000000} unit="次 / 分钟" />
              </Form.Item>
              <Form.Item name="retention_days" label="日志保留时间" extra="到期日志自动清理。" rules={[{ required: true, type: 'integer', min: 1, max: 365, message: '请输入 1 至 365 的整数' }]}>
                <PresetNumber presets={[7, 30, 60, 90, 180, 365]} min={1} max={365} unit="天" />
              </Form.Item>
            </div>
          </> },
        ]} />
        {error && <Alert className="http-guard-form-note" type="error" showIcon message={error} action={conflict && <Button size="small" onClick={reload}>载入最新策略</Button>} />}
        <Button type="primary" htmlType="submit" disabled={!dirty || conflict || !!removing} loading={saving}>保存策略</Button>
      </Form>
    </Card>
    <Card title="日志来源策略">
      <ErrorNotice error={removeError} retry={reload} />
      <Table<ManagedIp> rowKey="ip" dataSource={policy.managed_ips} query="" columnChooser={false} pagination={{ pageSize: 10, hideOnSinglePage: true }}
        columns={[{ title: '来源 IP', dataIndex: 'ip' }, { title: '动作', dataIndex: 'action', render: action => <Tag color={action === 'allow' ? 'green' : 'red'}>{action === 'allow' ? '放行' : '封禁'}</Tag> },
          { title: '到期时间', dataIndex: 'expires', render: ts => ts ? dateTime(ts) : '长期' },
          { title: '操作', render: (_, row) => <Popconfirm title={'撤销 ' + row.ip + ' 的来源策略？'} okText="撤销" cancelText="取消" onConfirm={() => remove(row.ip)}>
            <Button type="link" disabled={dirty || saving || !!removing} loading={removing === row.ip}>撤销</Button></Popconfirm> }]} />
    </Card>
    <Card title="近期策略变更" extra={<Button loading={history.loading} onClick={history.reload}>刷新</Button>}>
      <ErrorNotice error={history.error} retry={history.reload} />
      <Table<Change> rowKey="id" loading={history.loading} dataSource={history.data.items} query="" columnChooser={false} pagination={{ pageSize: 10, hideOnSinglePage: true }}
        expandable={{ rowExpandable: row => !!row.ips?.length, expandedRowRender: row => <Space wrap>{row.ips.map(ip => <Tag key={ip}>{ip}</Tag>)}</Space> }}
        columns={[{ title: '时间', dataIndex: 'ts', render: ts => dateTime(ts) }, { title: '操作人', dataIndex: 'actor' }, { title: '变更', dataIndex: 'summary' }]} />
    </Card>
  </>
}
