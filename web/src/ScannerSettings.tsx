import { Collapse, Form, Radio, Select, Space, Typography } from 'antd'
import { Button } from './Button'

type Row = Record<string, any>
type Props = {
  state: Row; locked: boolean; discovering: boolean; firstSide: string; manualSide?: string
  onFirstSide: (value: string) => void; onManualSide: (value: string) => void
  action: (method: string, args?: Record<string, unknown>) => Promise<unknown>
}

export function ScannerSettings({ state, locked, discovering, firstSide, manualSide, onFirstSide, onManualSide, action }: Props) {
  const prefs = state.device_preferences, driver = prefs?.driver || 'Twain'
  const dpi = state.scan_settings?.dpi === 600 ? 600 : 300, color = state.scan_settings?.color || 'gray'
  return <Form layout="vertical" className="scanner-settings">
    <Form.Item label="扫描清晰度">
      <Radio.Group className="scanner-resolution" value={dpi} disabled={locked} onChange={e => action('scanSettings', { dpi: e.target.value, color })}>
        <Radio.Button value={300}><strong>标清</strong><span>300 DPI · 日常扫描</span></Radio.Button>
        <Radio.Button value={600}><strong>高清</strong><span>600 DPI · 扫描较慢</span></Radio.Button>
      </Radio.Group>
    </Form.Item>
    <Form.Item label="扫描颜色">
      <Select disabled={locked} aria-label="扫描颜色" value={color} onChange={color => action('scanSettings', { dpi, color })}
        options={[{ value: 'gray', label: '灰度（推荐）' }, { value: 'bw', label: '黑白' }, { value: 'color', label: '彩色' }]} />
    </Form.Item>
    <Form.Item label="当前扫描仪">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select aria-label="选择扫描仪" placeholder="选择扫描仪" disabled={locked} value={prefs?.device?.id || undefined}
          options={prefs?.devices?.map((d: Row) => ({ value: d.id, label: d.name }))} onChange={id => action('selectDevice', { id })} />
        <Button loading={discovering} disabled={locked} onClick={() => action('devices', { driver })}>查找扫描仪</Button>
      </Space>
    </Form.Item>
    {manualSide && <Form.Item label="本次扫描哪一面"><Select value={manualSide} disabled={locked} onChange={onManualSide} options={[{ value: 'front', label: '正面' }, { value: 'back', label: '背面' }]} /></Form.Item>}
    <Typography.Paragraph type="secondary">设置会自动保存在本机，下次打开继续使用。</Typography.Paragraph>
    <Collapse items={[{ key: 'advanced', label: '高级设置', children: <>
      <Form.Item label="扫描仪驱动"><Select aria-label="扫描仪驱动" value={driver} disabled={locked} onChange={driver => action('selectDriver', { driver })}
        options={[{ value: 'Hi5100S', label: 'Hi-5100S（内置）' }, { value: 'Twain', label: 'TWAIN' }, { value: 'Wia', label: 'WIA' }, { value: 'Escl', label: 'eSCL' }, { value: 'external', label: '外部插件' }]} /></Form.Item>
      {driver === 'external' && <Form.Item label="扫描插件"><Space direction="vertical" style={{ width: '100%' }}>
        <Select aria-label="扫描插件" placeholder="选择插件" value={prefs?.plugin_id || undefined} disabled={locked}
          options={prefs?.plugins?.map((p: Row) => ({ value: p.id, label: p.name + (p.available ? '' : '（文件缺失）') }))} onChange={plugin_id => action('selectDriver', { driver, plugin_id })} />
        <Space><Button disabled={locked} onClick={() => action('choosePlugin')}>添加插件</Button>{prefs?.plugin_id && <Button disabled={locked} onClick={() => action('forgetPlugin')}>移除插件</Button>}</Space>
      </Space></Form.Item>}
      <Form.Item label="自动双面出图顺序"><Select value={firstSide} disabled={locked} onChange={onFirstSide}
        options={[{ value: 'front', label: '先正面，后背面' }, { value: 'back', label: '先背面，后正面' }]} /></Form.Item>
    </> }]} />
  </Form>
}
