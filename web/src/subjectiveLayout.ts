import type {Template} from './api'

export function subjectiveLayoutKey(template:Template){
  return JSON.stringify(Object.fromEntries(Object.entries(template).filter(([key])=>!['id','group_id','revision','status'].includes(key)&&!key.startsWith('draft_'))))
}
