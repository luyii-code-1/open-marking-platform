import { Cascader } from 'antd'
import { useResource, type Row } from './api'
import { groupOptions,rememberExamContext,unassignedGrade } from './examNavigation'

export function HierarchyPicker({ value, onChange, allowClear = false, placeholder = '选择项目 / 科目 / 年级 / 题卡' }: { value?: string; onChange: (id: string) => void; allowClear?: boolean; placeholder?: string }) {
  const projects = useResource<Row[]>('/projects', []), subjects = useResource<Row[]>('/subjects', []), groups = useResource<Row[]>('/groups', [])
  const group = groups.data.find(g => g.id === value), subject = subjects.data.find(s => s.id === group?.subject_id)
  const options = groupOptions(projects.data, subjects.data, groups.data)
  return <Cascader className="hierarchy-picker" aria-label={placeholder} placeholder={placeholder} allowClear={allowClear} showSearch loading={projects.loading || subjects.loading || groups.loading} options={options} notFoundContent={projects.error || subjects.error || groups.error || '暂无可选择的题卡'} value={subject && group ? [subject.project_id, subject.id, group.grade_id||unassignedGrade,group.id] : undefined} onChange={path => {
    const nextGroup = path?.length === 4 ? String(path[3]) : ''
    const nextProject = path?.length === 4 ? String(path[0]) : undefined
    if (nextGroup) rememberExamContext({ projectId: nextProject, groupId: nextGroup })
    onChange(nextGroup)
  }} />
}
