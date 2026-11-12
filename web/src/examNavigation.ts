import type { Row } from './api'

export const groupSections = [
  ['overview', '工作台'], ['template', '题卡设计'], ['roster', '应考名单'],
  ['scans', '扫描与补扫'], ['marking', '阅卷'], ['exceptions', '异常核查'], ['results', '成绩'],
] as const
export type GroupSection = typeof groupSections[number][0]
export type ExamLocation = { projectId?: string; subjectId?: string; groupId?: string; section?: string }
export type Location = ExamLocation & { page: string }
const pages = new Set(['dashboard', 'scanner', 'exams', 'marking', 'exceptions', 'results', 'people', 'settings', 'account', 'login', 'archives'])

export function examPath(location: ExamLocation = {}) {
  const { projectId, subjectId, groupId, section } = location
  let path = '#/exams'
  if (!projectId) return path
  path += '/' + encodeURIComponent(projectId)
  if (subjectId) path += '/subjects/' + encodeURIComponent(subjectId)
  if (subjectId && groupId) path += '/groups/' + encodeURIComponent(groupId)
  if (section && section !== 'overview') path += '/' + encodeURIComponent(section)
  return path
}

export function readLocation(hash: string): Location {
  try {
    const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
    const page = parts[0] || 'dashboard'
    if (!pages.has(page)) return { page: 'dashboard' }
    if (page === 'login') return { page, section: ['admin', 'marking'].includes(parts[1]) ? parts[1] : undefined }
    if (page !== 'exams') return { page }
    if (!parts[1]) return { page }
    const location: Location = { page, projectId: parts[1] }
    if (parts[2] !== 'subjects') return { ...location, section: ['archives', 'summary', 'storage', 'rooms'].includes(parts[2]) ? parts[2] : undefined }
    if (!parts[3]) return location
    location.subjectId = parts[3]
    if (parts[4] === 'groups' && parts[5]) {
      location.groupId = parts[5]
      location.section = groupSections.some(([key]) => key === parts[6]) ? parts[6] : 'overview'
    }
    return location
  } catch { return { page: 'dashboard' } }
}

export function resolveExam(location: ExamLocation, projects: Row[], subjects: Row[], groups: Row[]) {
  const project = projects.find(p => p.id === location.projectId)
  const subject = subjects.find(s => s.id === location.subjectId && s.project_id === project?.id)
  const group = groups.find(g => g.id === location.groupId && g.subject_id === subject?.id)
  return { project, subject, group, invalid: !!((location.projectId && !project) || (location.subjectId && !subject) || (location.groupId && !group)) }
}

export function defaultGroup(subject: Row, groups: Row[]) {
  const children = groups.filter(g => g.subject_id === subject.id)
  return subject.group_mode === 'default' && children.length === 1 && (children[0].is_default || children[0].name === 'Default') ? children[0] : undefined
}

export function scopedRecord(value: Record<string, unknown>, scope: Record<string, string>) {
  return { ...value, ...scope }
}

export function groupOptions(projects: Row[], subjects: Row[], groups: Row[]) {
  return projects.map(p => ({ value: p.id, label: p.name, children: subjects.filter(s => s.project_id === p.id).map(s => ({ value: s.id, label: s.name, children: groups.filter(g => g.subject_id === s.id).map(g => ({ value: g.id, label: g.is_default || g.name === 'Default' ? '默认组' : g.name })) })).filter(s => s.children.length) })).filter(p => p.children.length)
}
