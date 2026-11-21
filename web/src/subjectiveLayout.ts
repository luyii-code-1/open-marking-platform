import type {Template} from './api'

export function subjectiveLayoutKey(template:Template){
  const fields=Object.fromEntries(Object.entries(template).filter(([key])=>!['id','group_id','revision','status'].includes(key)&&!key.startsWith('draft_')))
  return JSON.stringify(fields,(key,value)=>key==='review_layout'||key==='review_frames'?undefined:value)
}
