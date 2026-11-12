import { Cascader } from 'antd'
import { useResource, type Row } from './api'
import { groupOptions } from './examNavigation'

export function HierarchyPicker({ value, onChange, allowClear = false, placeholder = '选择考试 / 科目 / 题卡组' }: { value?: string; onChange: (id: string) => void; allowClear?: boolean; placeholder?: string }) {
  const projects = useResource<Row[]>('/projects', []), subjects = useResource<Row[]>('/subjects', []), groups = useResource<Row[]>('/groups', [])
  const group = groups.data.find(g => g.id === value), subject = subjects.data.find(s => s.id === group?.subject_id)
  const options = groupOptions(projects.data, subjects.data, groups.data)
  return <Cascader className="hierarchy-picker" aria-label={placeholder} placeholder={placeholder} allowClear={allowClear} showSearch loading={projects.loading || subjects.loading || groups.loading} options={options} notFoundContent={projects.error || subjects.error || groups.error || '暂无可选择的题卡组'} value={subject && group ? [subject.project_id, subject.id, group.id] : undefined} onChange={path => onChange(path?.length === 3 ? String(path[2]) : '')} />
}
