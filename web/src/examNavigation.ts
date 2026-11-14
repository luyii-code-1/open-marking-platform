import type { Row } from './api'

export const groupSections = [
  ['overview', '工作台'], ['template', '题卡设计'], ['roster', '应考名单'],
  ['scans', '扫描与补扫'], ['sheets','答题卡查询'], ['marking', '阅卷分配'], ['exceptions', '异常核查'], ['results', '成绩'],
] as const
export type GroupSection = typeof groupSections[number][0]
export type ExamLocation = { projectId?: string; subjectId?: string; gradeId?:string; groupId?: string; section?: string }
export const unassignedGrade='unassigned'
export const cardName=(group:Row,subject?:Row)=>group.is_default||group.name==='Default'?`${subject?.name||''}题卡`:group.name
export function subjectGrades(subject:Row,groups:Row[],grades:Row[]=[]):Row[]{
  const children=groups.filter(g=>g.subject_id===subject.id)
  const ids=[...new Set([...(subject.grade_ids||[]),...children.map(g=>g.grade_id||unassignedGrade)])] as string[]
  return ids.map(id=>({id,name:id===unassignedGrade?'待设置年级':grades.find(g=>g.id===id)?.name||children.find(g=>g.grade_id===id)?.grade_name||'年级',count:children.filter(g=>(g.grade_id||unassignedGrade)===id).length}))
}
export type Location = ExamLocation & { page: string; templateId?: string; questionId?: string }
const pages = new Set(['dashboard', 'scanner', 'subject-catalog', 'exams', 'marking', 'exceptions', 'results', 'people', 'conversions', 'settings', 'account', 'login', 'archives'])

export function examPath(location: ExamLocation = {}) {
  const { projectId, subjectId, gradeId,groupId, section } = location
  let path = '#/exams'
  if (!projectId) return path
  path += '/' + encodeURIComponent(projectId)
  if (subjectId) path += '/subjects/' + encodeURIComponent(subjectId)
  if (subjectId && gradeId) path += '/grades/' + encodeURIComponent(gradeId)
  if (subjectId && groupId) path += (gradeId?'/cards/':'/groups/') + encodeURIComponent(groupId)
  if (section && section !== 'overview') path += '/' + encodeURIComponent(section)
  return path
}

export function readLocation(hash: string): Location {
  try {
    const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
    const page = parts[0] || 'dashboard'
    if (!pages.has(page)) return { page: 'dashboard' }
    if (page === 'login') return { page, section: ['admin', 'marking'].includes(parts[1]) ? parts[1] : undefined }
    if (page === 'marking' && parts[1] === 'review' && parts[2] && parts[3]) return { page, templateId: parts[2], questionId: parts[3] }
    if (page !== 'exams') return { page }
    if (!parts[1]) return { page }
    const location: Location = { page, projectId: parts[1] }
    if (parts[2] !== 'subjects') return { ...location, section: ['archives', 'summary', 'storage', 'rooms', 'sheets'].includes(parts[2]) ? parts[2] : undefined }
    if (!parts[3]) return location
    location.subjectId = parts[3]
    if(parts[4]==='grades'&&parts[5]){
      location.gradeId=parts[5]
      if(parts[6]==='cards'&&parts[7]){
        location.groupId=parts[7];location.section=groupSections.some(([key])=>key===parts[8])?parts[8]:'overview'
      }
    }else if (parts[4] === 'groups' && parts[5]) {
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
  const validGrade=!location.gradeId||!!subject&&subjectGrades(subject,groups).some(g=>g.id===location.gradeId)
  return { project, subject, group, invalid: !!((location.projectId && !project) || (location.subjectId && !subject) || (location.groupId && !group) || !validGrade || (group&&location.gradeId&&(group.grade_id||unassignedGrade)!==location.gradeId)) }
}

export function defaultGroup(subject: Row, groups: Row[]) {
  const children = groups.filter(g => g.subject_id === subject.id)
  return subject.group_mode === 'default' && children.length === 1 && (children[0].is_default || children[0].name === 'Default') ? children[0] : undefined
}

export function scopedRecord(value: Record<string, unknown>, scope: Record<string, string>) {
  return { ...value, ...scope }
}

export function groupOptions(projects: Row[], subjects: Row[], groups: Row[]) {
  return projects.map(p=>({value:p.id,label:p.name,children:subjects.filter(s=>s.project_id===p.id).map(s=>({value:s.id,label:s.name,children:subjectGrades(s,groups).map(grade=>({value:grade.id,label:grade.name,children:groups.filter(g=>g.subject_id===s.id&&(g.grade_id||unassignedGrade)===grade.id).map(g=>({value:g.id,label:cardName(g,s)}))})).filter(g=>g.children.length)})).filter(s=>s.children.length)})).filter(p=>p.children.length)
}
