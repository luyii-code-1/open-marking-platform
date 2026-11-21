export type JpegQuality = 60 | 80 | 90
export type EstimateContext = { paper: 'A3' | 'A4'; batch_id?: string; group_id?: string; template_id?: string }
type EstimateRequest = EstimateContext & { quality: JpegQuality }
type Sample = { size: number; quality: JpegQuality; source: 'scan' | 'reference'; paper: 'A3' | 'A4' }
export type SampleResult = { sample: Sample } | { error: string }

export function isJpegQuality(value: unknown): value is JpegQuality {
  return value === 60 || value === 80 || value === 90
}

export function loadJpegEstimate(
  request: EstimateRequest,
  load: (args: EstimateRequest) => Promise<Sample>,
  publish: (result: SampleResult) => void,
) {
  let active = true
  load(request).then(sample => {
    if (!active) return
    if (sample.quality !== request.quality || !Number.isSafeInteger(sample.size) || sample.size <= 0) {
      throw new Error('客户端返回的样张大小无效')
    }
    publish({ sample })
  }).catch(error => {
    if (active) publish({ error: error instanceof Error ? error.message : '读取样张大小失败' })
  })
  return () => { active = false }
}

export function totalJpegBytes(size: number, count: number | null) {
  if (count === null || !Number.isSafeInteger(count) || count < 1) return null
  const total = size * count
  return Number.isSafeInteger(total) ? total : null
}

const sizeFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })

export function jpegSize(bytes: number, single = false) {
  if (!single && bytes >= 1024 ** 3) return `${sizeFormat.format(bytes / 1024 ** 3)} GB`
  if (!single && bytes >= 1024 ** 2) return `${sizeFormat.format(bytes / 1024 ** 2)} MB`
  return `${sizeFormat.format(bytes / 1024)} KB`
}
