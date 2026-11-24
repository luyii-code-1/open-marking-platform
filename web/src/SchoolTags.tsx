import { useEffect, useRef, useState } from 'react'
import { Space, Tag, Tooltip } from 'antd'

const colors = ['blue', 'green', 'purple', 'cyan', 'geekblue', 'magenta']
export const DEFAULT_CLASS_TAGS = ['直卓', '卓越', '重点', '实验', '普通']

export const TAG_COLOR_CHOICES = [
  { value: 'blue', label: '蓝色' },
  { value: 'purple', label: '紫色' },
  { value: 'geekblue', label: '深蓝' },
  { value: 'cyan', label: '青色' },
  { value: 'green', label: '绿色' },
  { value: 'gold', label: '金色' },
  { value: 'orange', label: '橙色' },
  { value: 'volcano', label: '赤橙' },
  { value: 'red', label: '红色' },
  { value: 'magenta', label: '品红' },
  { value: 'lime', label: '青柠' },
  { value: 'default', label: '中性灰' },
]

const presetTagColors: Record<string, string> = {
  班主任: 'gold',
  直卓: 'purple',
  卓越: 'blue',
  重点: 'geekblue',
  实验: 'cyan',
  普通: 'default',
}

export function gradeColor(name: string, colorMap?: Record<string, string>) {
  if (colorMap?.[name]) return colorMap[name]
  const index = ['高一', '高二', '高三'].indexOf(name)
  return colors[index >= 0 ? index : Array.from(name).reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length]
}

export function classTagColor(tag: string, colorMap?: Record<string, string>) {
  if (colorMap?.[tag]) return colorMap[tag]
  return presetTagColors[tag] || colors[Array.from(tag).reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length]
}

export function GradeTag({ name, colorMap, onClick }: { name?: string; colorMap?: Record<string, string>; onClick?: (name: string) => void }) {
  return name ? (
    <Tag
      color={gradeColor(name, colorMap)}
      style={onClick ? { cursor: 'pointer', marginInlineEnd: 0 } : undefined}
      onClick={onClick ? e => { e.stopPropagation(); onClick(name) } : undefined}
    >
      {name}
    </Tag>
  ) : (
    <>待设置</>
  )
}

function estimateTagWidth(text: string) {
  let width = 18
  for (const ch of text) {
    width += ch.charCodeAt(0) > 127 ? 13 : 7.5
  }
  return Math.ceil(width)
}

export function ClassTags({
  tags,
  colorMap,
  empty = '—',
  max,
  onTagClick,
}: {
  tags?: string[]
  colorMap?: Record<string, string>
  empty?: string | null
  max?: number
  onTagClick?: (tag: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [fitCount, setFitCount] = useState<number>(max ?? tags?.length ?? 0)
  const list = tags || []
  const sig = list.join('\u0001')

  useEffect(() => {
    if (!list.length) return
    if (max !== undefined) {
      setFitCount(max)
      return
    }
    const compute = () => {
      const el = containerRef.current
      if (!el) return
      const available = el.clientWidth || el.parentElement?.clientWidth || 0
      if (available <= 0) {
        setFitCount(list.length)
        return
      }
      const gap = 4
      const widths = list.map(estimateTagWidth)
      const totalWidth = widths.reduce((sum, w, i) => sum + w + (i > 0 ? gap : 0), 0)
      if (totalWidth <= available) {
        setFitCount(list.length)
        return
      }
      const plusReserve = 40
      let used = 0
      let count = 0
      for (let i = 0; i < widths.length; i++) {
        const next = used + widths[i] + (count > 0 ? gap : 0)
        if (next + gap + plusReserve <= available) {
          used = next
          count += 1
        } else {
          break
        }
      }
      setFitCount(Math.max(1, count))
    }
    compute()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      ro = new ResizeObserver(compute)
      ro.observe(containerRef.current)
      if (containerRef.current.parentElement) ro.observe(containerRef.current.parentElement)
    }
    return () => ro?.disconnect()
  }, [sig, max])

  if (!list.length) return empty ? <span style={{ color: '#8c98a9' }}>{empty}</span> : null

  const visible = fitCount < list.length ? list.slice(0, fitCount) : list
  const hiddenCount = list.length - visible.length

  const content = (
    <div
      ref={containerRef}
      style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'nowrap', overflow: 'hidden', width: '100%', minWidth: 0 }}
    >
      {visible.map(tag => (
        <Tag
          key={tag}
          color={classTagColor(tag, colorMap)}
          style={{ marginInlineEnd: 0, flexShrink: 0, ...(onTagClick ? { cursor: 'pointer' } : {}) }}
          onClick={onTagClick ? e => { e.stopPropagation(); onTagClick(tag) } : undefined}
        >
          {tag}
        </Tag>
      ))}
      {hiddenCount > 0 && (
        <Tag style={{ marginInlineEnd: 0, flexShrink: 0, cursor: 'default' }}>+{hiddenCount}</Tag>
      )}
    </div>
  )

  if (hiddenCount > 0) {
    return (
      <Tooltip
        color="#fff"
        styles={{ body: { padding: '8px 10px' } }}
        title={
          <Space wrap size={[4, 4]}>
            {list.map(tag => (
              <Tag
                key={tag}
                color={classTagColor(tag, colorMap)}
                style={{ marginInlineEnd: 0, ...(onTagClick ? { cursor: 'pointer' } : {}) }}
                onClick={onTagClick ? e => { e.stopPropagation(); onTagClick(tag) } : undefined}
              >
                {tag}
              </Tag>
            ))}
          </Space>
        }
      >
        {content}
      </Tooltip>
    )
  }

  return content
}
