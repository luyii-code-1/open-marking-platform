import { useEffect, useState } from 'react'
import { Form, InputNumber, Radio, Typography } from 'antd'
import { Button } from './Button'
import { scannerCall } from './scanner-bridge'
import { jpegSize, loadJpegEstimate, totalJpegBytes, type EstimateContext, type JpegQuality, type SampleResult } from './scannerJpegEstimate'

type Props = {
  quality: JpegQuality
  context: EstimateContext
  active: boolean
  locked: boolean
  onChange: (quality: JpegQuality) => void
}

function SampleSizes({ quality, context, count }: Pick<Props, 'quality' | 'context'> & { count: number | null }) {
  const { paper, batch_id, group_id, template_id } = context
  const [result, setResult] = useState<SampleResult>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => loadJpegEstimate(
    { quality, paper, batch_id, group_id, template_id },
    args => scannerCall('jpegEstimate', args), setResult,
  ), [quality, paper, batch_id, group_id, template_id, attempt])

  if (!result) return <Typography.Text type="secondary" role="status">正在计算样张大小…</Typography.Text>
  if ('error' in result) return <div role="alert" className="scanner-jpeg-error">
    <Typography.Text type="danger">{result.error}</Typography.Text>
    <Button size="small" onClick={() => { setResult(undefined); setAttempt(attempt + 1) }}>重新估算</Button>
  </div>
  const { sample } = result
  const total = totalJpegBytes(sample.size, count)
  return <div aria-live="polite">
    <dl className="scanner-jpeg-sizes">
      <div><dt>单图大小</dt><dd>{jpegSize(sample.size, true)}</dd></div>
      <div><dt>预计 JPEG 总量</dt><dd>{total === null ? '—' : jpegSize(total)}</dd></div>
    </dl>
    <Typography.Text type="secondary">{sample.source === 'scan' ? `样张取自本机最近校正页（${sample.paper}）` : `样张取自内置 ${sample.paper} 参考页`}。估算仅含 JPEG 文件，实际大小随卷面内容变化。</Typography.Text>
  </div>
}

export function ScannerJpegSettings({ quality, context, active, locked, onChange }: Props) {
  const [count, setCount] = useState<number | null>(100)
  const sampleKey = JSON.stringify([quality, context.paper, context.batch_id, context.group_id, context.template_id])
  return <>
    <Form.Item label="上传图像质量（JPEG）">
      <Radio.Group className="scanner-jpeg-quality" aria-label="上传图像质量（JPEG）" value={quality} disabled={locked} onChange={event => onChange(event.target.value)}>
        <Radio.Button value={60}>省空间 Q60</Radio.Button>
        <Radio.Button value={80}>标准 Q80</Radio.Button>
        <Radio.Button value={90}>精细 Q90</Radio.Button>
      </Radio.Group>
    </Form.Item>
    <Form.Item label="预计上传图片张数" htmlFor="jpeg-image-count">
      <InputNumber id="jpeg-image-count" min={1} max={Number.MAX_SAFE_INTEGER} precision={0} value={count} onChange={setCount} suffix="张" />
      <Typography.Text type="secondary" className="scanner-jpeg-count-hint">双面纸每张按两张图片计。</Typography.Text>
      {active && <div className="scanner-jpeg-estimate"><SampleSizes key={sampleKey} quality={quality} context={context} count={count} /></div>}
    </Form.Item>
  </>
}
