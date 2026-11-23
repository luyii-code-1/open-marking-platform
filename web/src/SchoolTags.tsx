import { Space, Tag } from 'antd'

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

export function GradeTag({ name, colorMap }: { name?: string; colorMap?: Record<string, string> }) {
  return name ? <Tag color={gradeColor(name, colorMap)}>{name}</Tag> : <>待设置</>
}

export function ClassTags({
  tags,
  colorMap,
  empty = '—',
  max,
}: {
  tags?: string[]
  colorMap?: Record<string, string>
  empty?: string | null
  max?: number
}) {
  if (!tags?.length) return empty ? <span style={{ color: '#8c98a9' }}>{empty}</span> : null
  const visible = max && tags.length > max ? tags.slice(0, max) : tags
  const hiddenCount = tags.length - visible.length
  return (
    <Space wrap size={[4, 4]}>
      {visible.map(tag => (
        <Tag key={tag} color={classTagColor(tag, colorMap)} style={{ marginInlineEnd: 0 }}>
          {tag}
        </Tag>
      ))}
      {hiddenCount > 0 && <Tag style={{ marginInlineEnd: 0 }}>+{hiddenCount}</Tag>}
    </Space>
  )
}
