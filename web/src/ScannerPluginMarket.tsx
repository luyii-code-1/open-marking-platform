import { Collapse, Space, Typography } from 'antd'
import { useState } from 'react'
import { Button } from './Button'

type MarketPlugin = {
  id: string; hash: string; name: string; version: string; description: string
  builtin: boolean; installed: boolean; latest: boolean
}
export type MarketCatalog = { source: string; revision: number; plugins: MarketPlugin[] }
type Props = {
  catalog: MarketCatalog; activeHash?: string; legacyHi: boolean; locked: boolean
  action: (method: string, args?: Record<string, unknown>) => Promise<unknown>
}

export function ScannerPluginMarket({ catalog, activeHash, legacyHi, locked, action }: Props) {
  const [pending, setPending] = useState('')
  async function run(key: string, method: string, args?: Record<string, unknown>) {
    setPending(key)
    try { await action(method, args) } finally { setPending('') }
  }
  const disabled = locked || !!pending
  return <Collapse items={[{ key: 'market', label: '扫描插件市场', children:
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Typography.Text type="secondary">{catalog.source} · 目录 v{catalog.revision}</Typography.Text>
        <Button size="small" disabled={disabled} loading={pending === 'refresh'}
          onClick={() => run('refresh', 'marketRefresh')}>刷新官方清单</Button>
      </Space>
      {catalog.plugins.map(p => {
        const active = activeHash === p.hash || (legacyHi && p.builtin && p.id === 'hi5100s')
        const enable = () => run(p.hash, 'selectDriver', { driver: 'market', plugin_id: p.hash })
        return <section key={p.hash} aria-label={p.name + ' ' + p.version}>
          <Typography.Text strong>{p.name}</Typography.Text>
          <div><Typography.Text type="secondary">v{p.version} · {p.builtin ? '内置' : p.installed ? '已安装' : '可下载'}{!p.latest && ' · 历史版本'}</Typography.Text></div>
          <Typography.Paragraph>{p.description}</Typography.Paragraph>
          <Space>
            <Button size="small" disabled={disabled || active} loading={pending === p.hash}
              onClick={p.installed ? enable : () => run(p.hash, 'marketInstall', { hash: p.hash })}>
              {active ? '使用中' : p.installed ? '启用' : '安装'}
            </Button>
            {p.installed && !p.builtin && !active && <Button size="small" disabled={disabled}
              onClick={() => run('remove-' + p.hash, 'marketRemove', { hash: p.hash })}>移除</Button>}
          </Space>
        </section>
      })}
    </Space>
  }]} />
}
