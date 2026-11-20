export type ResultFilterValue={classIds:string[];studentIds:string[];statuses:string[];groupIds:string[];q:string}
export const emptyResultFilters=():ResultFilterValue=>({classIds:[],studentIds:[],statuses:[],groupIds:[],q:''})
const fields=[['classIds','class_ids'],['studentIds','student_ids'],['statuses','statuses'],['groupIds','group_ids']] as const
export function readResultFilters(params?:URLSearchParams):ResultFilterValue{
  const result=emptyResultFilters()
  for(const [field,key] of fields)result[field]=[...new Set((params?.get(key)||'').split(',').filter(Boolean))]
  result.q=params?.get('q')||''
  return result
}
export function withResultFilters(base:URLSearchParams,filters:ResultFilterValue){
  const params=new URLSearchParams(base)
  for(const [field,key] of fields){params.delete(key);const values=[...new Set(filters[field])];if(values.length)params.set(key,values.join(','))}
  params.delete('q');if(filters.q.trim())params.set('q',filters.q.trim())
  return params
}
export type ResultReport='workbook'|'items'|'averages'|'ranks'|'bands'|'students'|'classes'|'questions'|'distribution'|'summary'|'ranking'|'class-summary'
export const formalReports:ResultReport[]=['workbook','items','averages','questions','ranks','bands']
export const resultExportExtension=(kind:'card'|'project',report:ResultReport,format:'xlsx'|'csv')=>format==='xlsx'&&formalReports.includes(report)&&kind==='project'?'zip':format
export function resultExportRequest(kind:'card'|'project',id:string,base:URLSearchParams,report:ResultReport,format:'xlsx'|'csv'){
  const params=new URLSearchParams(base)
  params.set(kind==='card'?'group_id':'project_id',id)
  params.set('format',format)
  if(format==='xlsx'&&formalReports.includes(report)){params.delete('view');params.set('report',report);return {path:'/analysis/reports/export',params}}
  if(kind==='project'){params.set('view',report);return {path:'/analysis/project/export',params}}
  if(report==='items'){params.delete('view');return {path:'/results/export',params}}
  params.set('view',report)
  return {path:'/analysis/group/export',params}
}
