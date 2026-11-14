import type {Row} from './api'

export type TeacherFilter={grades:string[];subjects:string[];classes:string[];homeroom:boolean}
export const emptyTeacherFilter:TeacherFilter={grades:[],subjects:[],classes:[],homeroom:false}

export function matchingTeachers(users:Row[],classes:Row[],filter:TeacherFilter){
  if(!filter.grades.length&&!filter.subjects.length&&!filter.classes.length&&!filter.homeroom)return users
  const matched=new Set<string>()
  for(const cls of classes){
    if(filter.grades.length&&!filter.grades.includes(cls.grade_id||cls.grade))continue
    if(filter.classes.length&&!filter.classes.includes(cls.id))continue
    for(const id of new Set<string>([...(cls.teacher_ids||[]),...Object.keys(cls.teaching||{})])){
      const relation=cls.teaching?.[id]
      if(filter.homeroom&&relation?.homeroom!==true)continue
      if(filter.subjects.length&&!filter.subjects.some(s=>relation?.subjects?.includes(s)))continue
      matched.add(id)
    }
  }
  return users.filter(u=>matched.has(u.id))
}
