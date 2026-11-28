import type {ReviewRecord} from './reviewStore'
import {questionLabel} from './mergeQuestions'

export type ProjectFilter = 'in_progress' | 'pending_review' | 'completed' | 'all'
export type ReviewProject = {
  id:string; name:string; exam_status:string; subjects:string[]; template_ids:string[]; question_count:number; created_at?:number|null
}
export type AssignedQuestion = {
  template_id:string; question_id:string; template_name:string; subject_name?:string; grade_name?:string; card_name?:string
  question_label:string; points:number; review_mode:string; published?:boolean; reopened?:boolean; cached?:boolean
  ordinary_total?:number; ordinary_completed?:number; ordinary_pending?:number
  arbitration_total?:number; arbitration_completed?:number; arbitration_pending?:number; can_arbitrate?:boolean
}
export const questionKey = (row:AssignedQuestion) => row.template_id + ':' + row.question_id
export const localProjectId = 'local-cache'

export function withCachedProjects(catalog:ReviewProject[], records:ReviewRecord[]) {
  const byTemplate = new Map(catalog.flatMap(p => p.template_ids.map(id => [id,p.id] as const)))
  const projects = new Map(catalog.map(p => [p.id,p]))
  const cached = new Map<string, Map<string, AssignedQuestion>>()
  for (const {template,question,status} of records) {
    if (status === 'confirmed') continue
    const id = byTemplate.get(template.id) ?? template.project_id ?? localProjectId
    let tasks = cached.get(id)
    if (!tasks) { tasks = new Map(); cached.set(id,tasks) }
    const row:AssignedQuestion = {
      template_id:template.id, question_id:question.id, template_name:template.name, subject_name:template.subject_name,
      question_label:questionLabel(question), points:question.points, review_mode:question.review_mode || 'single', cached:true,
    }
    tasks.set(questionKey(row),row)
    if (!projects.has(id)) projects.set(id,{
      id,name:template.project_name || '本机缓存任务',exam_status:template.exam_status || 'cached',
      subjects:[],template_ids:[],question_count:0,
    })
  }
  for (const p of projects.values()) {
    if (p.question_count === 0) {
      const tasks = [...(cached.get(p.id)?.values() || [])]
      projects.set(p.id,{...p,question_count:tasks.length,subjects:[...new Set(tasks.flatMap(row=>row.subject_name?[row.subject_name]:[]))]})
    }
  }
  return {projects:[...projects.values()], cached}
}

export function projectQuestions(online:AssignedQuestion[], cached?:Map<string,AssignedQuestion>) {
  const rows = new Map(cached)
  for (const row of online) rows.set(questionKey(row),{...row,cached:rows.has(questionKey(row))})
  return [...rows.values()].sort((a,b)=>(b.arbitration_pending||0)-(a.arbitration_pending||0)
    || (a.subject_name||'').localeCompare(b.subject_name||'','zh-CN')
    || a.template_name.localeCompare(b.template_name,'zh-CN') || parseInt(a.question_label)-parseInt(b.question_label))
}
