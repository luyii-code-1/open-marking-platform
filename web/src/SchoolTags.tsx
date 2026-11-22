import { Space, Tag } from 'antd'

const colors = ['blue', 'green', 'purple', 'cyan', 'geekblue', 'magenta']
export const DEFAULT_CLASS_TAGS = ['直卓', '卓越', '重点', '实验', '普通']

const presetTagColors: Record<string, string> = {
  直卓: 'purple',
  卓越: 'blue',
  重点: 'geekblue',
  实验: 'cyan',
  普通: 'default',
}

export function gradeColor(name: string) {
  const index = ['高一', '高二', '高三'].indexOf(name)
  return colors[index >= 0 ? index : Array.from(name).reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length]
}

export function classTagColor(tag: string) {
  return presetTagColors[tag] || colors[Array.from(tag).reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length]
}

export function GradeTag({ name }: { name?: string }) {
  return name ? <Tag color={gradeColor(name)}>{name}</Tag> : <>待设置</>
}

export function ClassTags({ tags, empty = '—' }: { tags?: string[]; empty?: string | null }) {
  if (!tags?.length) return empty ? <span style={{ color: '#8c98a9' }}>{empty}</span> : null
  return (
    <Space wrap size={[4, 4]}>
      {tags.map(tag => (
        <Tag key={tag} color={classTagColor(tag)} style={{ marginInlineEnd: 0 }}>
          {tag}
        </Tag>
      ))}
    </Space>
  )
}
