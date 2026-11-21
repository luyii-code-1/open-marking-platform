import { useEffect, useState } from 'react'
import { Alert, App, Card, Form, InputNumber, Popconfirm, Radio, Select, Space, Switch, Tabs, Tag, Typography } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { ApiError, send, useResource } from './api'
import { useUnsavedChanges } from './useNavigation'
import { countryName, dateTime, formatExpiry, guardApi, type ManagedIp, type Mode, type Policy, type Status } from './httpGuardData'

const modes = [
  { value: 'off', label: '关闭' },
  { value: 'observe', label: '观察' },
  { value: 'enforce', label: '拦截' },
]

const modeHelp: Record<Mode, string> = {
  off: '暂停请求采集与防护。',
  observe: '采集请求并记录规则命中，流量继续放行。',
  enforce: '执行来源、限流和敏感路径策略。内容检测按照各自的模式处理。',
}
const contentProfiles = [
  { value: 'uniform', label: '统一按规则处理' },
  { value: 'verified_business', label: '已认证业务文本仅观察' },
]
const adaptiveRates = [60, 120, 300, 600, 1200, 3000]
const adaptiveRateRules = [{ required: true, type: 'integer' as const, min: 1, max: 1000000, message: '请输入 1 至 1000000 的整数' }]

const countryCodes = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT ' +
  'JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM ' +
  'MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR ' +
  'PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ ' +
  'TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK'
).split(' ')

const countryOptions = countryCodes
  .map(value => ({ value, label: countryName(value) + ' · ' + value }))
  .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))

type PolicyForm = Omit<Policy, 'managed_ips' | 'revision'>
type Change = { id: number; ts: number; actor: string; summary: string; ips: string[] }
type Props = { policy: Policy; onSaved: (policy: Policy) => void; reload: () => Promise<void>; status: Status | null }

function PresetNumber({
  value,
  onChange,
  presets,
  min,
  max,
  unit,
  id,
}: {
  value?: number | null
  onChange?: (value: number | null) => void
  presets: number[]
  min: number
  max: number
  unit: string
  id?: string
}) {
  const [custom, setCustom] = useState(value != null && !presets.includes(value))

  useEffect(() => {
    if (value != null && presets.includes(value)) setCustom(false)
  }, [value, presets])

  const editing = custom || (value != null && !presets.includes(value))

  return (
    <Space wrap>
      <Select
        id={id}
        style={{ minWidth: 136 }}
        value={editing ? 'custom' : value}
        onChange={next => {
          setCustom(next === 'custom')
          if (typeof next === 'number') onChange?.(next)
        }}
        options={[
          ...presets.map(n => ({ value: n as number | string, label: n === 0 ? '关闭' : n + ' ' + unit })),
          { value: 'custom', label: '自定义' },
        ]}
      />
      {editing && (
        <InputNumber
          aria-label={'自定义数值（' + unit + '）'}
          min={min}
          max={max}
          precision={0}
          value={value}
          onChange={onChange}
          addonAfter={unit}
        />
      )}
    </Space>
  )
}

export function HttpGuardRules({ policy, onSaved, reload, status }: Props) {
  const [form] = Form.useForm<PolicyForm>()
  const { message } = App.useApp()
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState('')
  const [error, setError] = useState('')
  const [removeError, setRemoveError] = useState('')
  const [conflict, setConflict] = useState(false)
  const mode: Mode = Form.useWatch('mode', form) || policy.mode
  const profile = Form.useWatch('business_content_profile', form) ?? policy.business_content_profile ?? 'uniform'
  const adaptive = Form.useWatch('adaptive_enabled', form) ?? policy.adaptive_enabled ?? false
  const allowIps: string[] = Form.useWatch('allow_ips', form) || policy.allow_ips
  useUnsavedChanges(dirty)

  const history = useResource<{ items: Change[] }>(guardApi + '/policy-history', { items: [] }, { live: false })
  const clientIp = status?.client_ip
  const selfAllowed = !!clientIp && allowIps.includes(clientIp)

  async function save(values: PolicyForm) {
    setSaving(true)
    setError('')
    setConflict(false)
    try {
      const next = await send<Policy>(guardApi + '/settings', { ...values, revision: policy.revision }, 'PUT')
      setDirty(false)
      onSaved(next)
      message.success('防护策略已保存')
    } catch (e) {
      setError((e as Error).message)
      setConflict(e instanceof ApiError && e.status === 409)
    } finally {
      setSaving(false)
    }
  }

  function resetForm() {
    form.resetFields()
    setDirty(false)
    setError('')
    setConflict(false)
  }

  function addSelfToAllowList() {
    if (!clientIp || selfAllowed) return
    const current = form.getFieldValue('allow_ips') || []
    form.setFieldValue('allow_ips', [...current, clientIp])
    setDirty(true)
  }

  async function remove(ip: string) {
    setRemoving(ip)
    setRemoveError('')
    try {
      onSaved(await send<Policy>(guardApi + '/remove-policy', { revision: policy.revision, ip }))
      message.success('已撤销来源策略')
    } catch (e) {
      setRemoveError((e as Error).message)
    } finally {
      setRemoving('')
    }
  }

  const ipOptions = [...new Set([...policy.allow_ips, ...policy.deny_ips, ...policy.managed_ips.map(row => row.ip)])].map(value => ({
    value,
    label: value,
  }))
  const regionOptions = [
    ...countryOptions,
    ...[...new Set([...policy.allow_countries, ...policy.deny_countries])]
      .filter(value => !countryCodes.includes(value))
      .map(value => ({ value, label: value })),
  ]

  return (
    <>
      <Card
        title="策略编辑"
        extra={
          <Space wrap>
            {dirty && <Tag color="warning">有未保存的更改</Tag>}
            <Tag>修订 #{policy.revision}</Tag>
          </Space>
        }
      >
        <Form
          layout="vertical"
          form={form}
          disabled={saving || !!removing}
          onValuesChange={() => setDirty(true)}
          onFinish={save}
          initialValues={{
            ...policy,
            business_content_profile: policy.business_content_profile ?? 'uniform',
            adaptive_enabled: policy.adaptive_enabled ?? false,
            anonymous_rate_per_minute: policy.anonymous_rate_per_minute ?? 120,
            authenticated_rate_per_minute: policy.authenticated_rate_per_minute ?? 600,
          }}
        >
          <Tabs
            items={[
              {
                key: 'access',
                label: '来源访问',
                forceRender: true,
                children: (
                  <div className="http-guard-stack">
                    {clientIp && (
                      <div className="guard-self-ip-bar">
                        <span>
                          当前访问 IP：<Typography.Text code>{clientIp}</Typography.Text>
                        </span>
                        {!selfAllowed ? (
                          <Button size="small" onClick={addSelfToAllowList}>加入放行列表</Button>
                        ) : (
                          <Tag color="green">已在放行列表</Tag>
                        )}
                      </div>
                    )}
                    <div className="http-guard-fields">
                      {(['allow_ips', 'deny_ips'] as const).map((key, i) => (
                        <Form.Item
                          key={key}
                          name={key}
                          label={i ? '封禁 IP / 网段' : '放行 IP / 网段'}
                          extra={i ? '选择地址，或输入 IPv4、IPv6 或 CIDR 后按回车。' : '优先放行来源、限流和敏感路径规则。内容检测仍按自身模式执行。'}
                        >
                          <Select
                            mode="tags"
                            aria-label={i ? '封禁 IP' : '放行 IP'}
                            options={ipOptions}
                            tokenSeparators={[' ', ',', '，', '\n']}
                            maxTagCount={6}
                            placeholder="选择或添加 IP / CIDR，如 192.0.2.0/24"
                          />
                        </Form.Item>
                      ))}
                      {(['allow_countries', 'deny_countries'] as const).map((key, i) => (
                        <Form.Item
                          key={key}
                          name={key}
                          label={i ? '封禁的 IP 归属地' : '允许的 IP 归属地'}
                          extra={i ? '来源地区由 GeoIP 数据库解析。' : '留空时允许全部地区。启用后，未列出及未知的地区均会命中规则。'}
                        >
                          <Select
                            mode="multiple"
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            options={regionOptions}
                            maxTagCount={6}
                            placeholder="搜索地区名称或代码"
                          />
                        </Form.Item>
                      ))}
                    </div>
                    {!status?.geo.ready && (
                      <Alert className="http-guard-form-note" type="info" showIcon message="启用地区拦截前，请先在下方下载 GeoIP 数据库。" />
                    )}
                  </div>
                ),
              },
              {
                key: 'content',
                label: '请求检测',
                forceRender: true,
                children: (
                  <div className="http-guard-stack">
                    <div className="guard-engine-banner">
                      <Space wrap>
                        <Tag color={status?.engine?.ready ? 'green' : 'default'}>
                          {status?.engine?.ready ? '检测引擎已就绪' : '检测引擎未就绪'}
                        </Tag>
                        {status?.engine?.version && <span className="guard-mono">libinjection {status.engine.version}</span>}
                      </Space>
                      <Typography.Text type="secondary">全局观察模式仅记录命中。全局拦截模式按各规则及业务文本策略处理。</Typography.Text>
                    </div>
                    <div className="guard-rule-box">
                      <Form.Item
                        name="business_content_profile"
                        label="业务文本检测策略"
                        extra={profile === 'verified_business'
                          ? '具备接口权限的账号提交题卡富文本、重阅原因等指定字段时，SQLi、XSS 命中只记日志。查询参数、其他字段和未登录请求继续按下方规则处理。'
                          : '沿用各规则的统一处置方式，保留题卡富文本等原有字段例外。'}
                      >
                        <Select options={contentProfiles} aria-label="业务文本检测策略" style={{ maxWidth: 360 }} />
                      </Form.Item>
                    </div>
                    <div className="http-guard-fields">
                      {(['sqli_mode', 'xss_mode'] as const).map((key, i) => (
                        <div key={key} className="guard-rule-box">
                          <Form.Item
                            name={key}
                            label={i ? '跨站脚本（XSS）' : 'SQL 注入（SQLi）'}
                            extra={i ? '检测查询参数和支持的请求正文中的跨站脚本特征。' : '检测查询参数和支持的请求正文中的 SQL 注入特征。'}
                          >
                            <Radio.Group optionType="button" buttonStyle="solid" options={modes} />
                          </Form.Item>
                        </div>
                      ))}
                      <div className="guard-rule-box">
                        <Form.Item
                          name="block_sensitive_paths"
                          label="敏感路径防护"
                          valuePropName="checked"
                          extra="保护版本库目录（.git）、环境配置（.env）和凭据文件。"
                        >
                          <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                        </Form.Item>
                      </div>
                    </div>
                  </div>
                ),
              },
              {
                key: 'global',
                label: '运行设置',
                forceRender: true,
                children: (
                  <div className="http-guard-stack">
                    <div className="guard-rule-box">
                      <Form.Item name="mode" label="全局运行模式" extra={modeHelp[mode]}>
                        <Radio.Group optionType="button" buttonStyle="solid" options={modes} />
                      </Form.Item>
                    </div>
                    <div className="http-guard-fields">
                      <div className="guard-rule-box">
                        <Form.Item
                          name="rate_per_minute"
                          label="单个 IP 每分钟固定上限"
                          extra="每个服务进程独立计数。设为 0 关闭固定上限，可与动态限流同时使用。"
                          rules={[{ required: true, type: 'integer', min: 0, max: 1000000, message: '请输入 0 至 1000000 的整数' }]}
                        >
                          <PresetNumber presets={[0, 60, 120, 300, 600, 1200]} min={0} max={1000000} unit="次 / 分钟" />
                        </Form.Item>
                      </div>
                      <div className="guard-rule-box">
                        <Form.Item
                          name="retention_days"
                          label="日志保留时间"
                          extra="到期访问日志将自动清理。"
                          rules={[{ required: true, type: 'integer', min: 1, max: 365, message: '请输入 1 至 365 的整数' }]}
                        >
                          <PresetNumber presets={[7, 30, 60, 90, 180, 365]} min={1} max={365} unit="天" />
                        </Form.Item>
                      </div>
                    </div>
                    <div className="guard-rule-box">
                      <Form.Item
                        name="adaptive_enabled"
                        label="动态限流"
                        valuePropName="checked"
                        extra={(adaptive ? '' : '可提前设置下方额度，开启后生效。') + '每个服务进程独立计数。空闲时可积攒 10 秒的额度用于短时突发，请求数向上取整。'}
                      >
                        <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                      </Form.Item>
                      <div className="http-guard-fields">
                        <Form.Item name="anonymous_rate_per_minute" label="未登录来源的基准额度"
                          extra="按 IP 计数。10 秒内连续 3 次额度不足时，补充速度减半 60 秒。持续超额会延长收紧时间，期满自动恢复。" rules={adaptiveRateRules}>
                          <PresetNumber presets={adaptiveRates} min={1} max={1000000} unit="次 / 分钟" />
                        </Form.Item>
                        <Form.Item name="authenticated_rate_per_minute" label="已登录账号或设备的基准额度"
                          extra="服务器验证身份后按账号或设备分别计数。共用 IP 的不同账号各用自己的额度，按配置的基准速度补充。" rules={adaptiveRateRules}>
                          <PresetNumber presets={adaptiveRates} min={1} max={1000000} unit="次 / 分钟" />
                        </Form.Item>
                      </div>
                      <Typography.Text type="secondary">
                        公开的页面、脚本、字体等静态资源按 IP 单独计数，额度为未登录基准的 20 倍，每个进程最高 100 万次 / 分钟。
                      </Typography.Text>
                    </div>
                  </div>
                ),
              },
            ]}
          />

          {error && (
            <Alert
              className="http-guard-form-note"
              type="error"
              showIcon
              message={error}
              action={conflict && <Button size="small" onClick={reload}>载入最新策略</Button>}
            />
          )}

          <div className="guard-form-actions">
            <Space wrap>
              <Button type="primary" htmlType="submit" disabled={!dirty || conflict || !!removing} loading={saving}>
                保存策略
              </Button>
              {dirty && (
                <Button onClick={resetForm} disabled={saving}>
                  重置更改
                </Button>
              )}
            </Space>
            <Typography.Text type="secondary">
              {dirty ? '请保存更改以使策略生效' : '当前表单与已生效策略一致'}
            </Typography.Text>
          </div>
        </Form>
      </Card>

      <Card title="日志来源策略" extra={<Typography.Text type="secondary">共 {policy.managed_ips.length} 条</Typography.Text>}>
        <ErrorNotice error={removeError} retry={reload} />
        <Table<ManagedIp>
          rowKey="ip"
          dataSource={policy.managed_ips}
          query=""
          columnChooser={false}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          columns={[
            { title: '来源 IP', dataIndex: 'ip', render: (ip: string) => <span className="guard-mono">{ip}</span> },
            {
              title: '动作',
              dataIndex: 'action',
              render: action => <Tag color={action === 'allow' ? 'green' : 'red'}>{action === 'allow' ? '放行' : '封禁'}</Tag>,
            },
            {
              title: '到期时间',
              dataIndex: 'expires',
              render: (ts: number) => {
                const info = formatExpiry(ts)
                return <span className={info.expired ? 'guard-muted' : undefined}>{info.label}</span>
              },
            },
            {
              title: '操作',
              render: (_, row) => (
                <Popconfirm
                  title={'撤销 ' + row.ip + ' 的来源策略？'}
                  okText="撤销"
                  cancelText="取消"
                  onConfirm={() => remove(row.ip)}
                >
                  <Button type="link" disabled={dirty || saving || !!removing} loading={removing === row.ip}>
                    撤销
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      <Card title="近期策略变更" extra={<Button loading={history.loading} onClick={history.reload}>刷新</Button>}>
        <ErrorNotice error={history.error} retry={history.reload} />
        <Table<Change>
          rowKey="id"
          loading={history.loading}
          dataSource={history.data.items}
          query=""
          columnChooser={false}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          expandable={{
            rowExpandable: row => !!row.ips?.length,
            expandedRowRender: row => (
              <Space wrap>
                {row.ips.map(ip => (
                  <Tag key={ip}><span className="guard-mono">{ip}</span></Tag>
                ))}
              </Space>
            ),
          }}
          columns={[
            { title: '时间', dataIndex: 'ts', render: ts => <span className="guard-mono">{dateTime(ts)}</span> },
            { title: '操作人', dataIndex: 'actor' },
            { title: '变更', dataIndex: 'summary' },
          ]}
        />
      </Card>
    </>
  )
}
