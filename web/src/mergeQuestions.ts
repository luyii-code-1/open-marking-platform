import type {Question, QuestionPart} from './api'

export function questionNumbers(q: Pick<Question,'parts'|'number'>) {
  return q.parts?.map(p=>p.number) ?? [q.number]
}
export function questionLabel(q: Pick<Question,'parts'|'number'>) {
  const numbers=questionNumbers(q)
  return numbers.length>1 && numbers.every((n,i)=>n===numbers[0]+i)
    ? numbers[0]+'～'+numbers[numbers.length-1] : numbers.join('、')
}

export function mergeQuestions(rows:Question[],ids:string[]):Question {
  const selected=rows.filter(q=>ids.includes(q.id)).sort((a,b)=>a.number-b.number)
  if(selected.length<2||selected.some(q=>q.type!=='subjective'||q.parts))throw Error('请选择至少两道独立主观题')
  if(selected.some(q=>!q.regions.length))throw Error('请先为每道题框选作答区域')
  const first=selected[0]
  const parts=selected.map(q=>{
    const {number,points,style,lines,cell_size,content_html,image_asset_id,image_height}=q
    return {number,points,style,lines,cell_size,content_html,image_asset_id,image_height} satisfies QuestionPart
  })
  const {style,lines,cell_size,content_html,image_asset_id,image_height,...scoring}=first
  return {...scoring,parts,points:selected.reduce((sum,q)=>sum+Math.round(q.points*100),0)/100,
    regions:selected.flatMap(q=>q.regions.map(r=>({...r,part_number:q.number})))}
}
export function splitQuestions(q:Question):Question[] {
  return (q.parts||[]).map((part,i)=>{
    const {parts,...base}=q
    return {...base,...part,id:i===0?q.id:crypto.randomUUID(),
      regions:q.regions.filter(r=>r.part_number===part.number).map(({part_number,...r})=>r)}
  })
}
