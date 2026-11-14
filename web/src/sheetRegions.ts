import type { Region, Template } from './api'

export function columnBounds(template:Template,page:number,x:number) {
  const width=template.paper==='A3'?420:210
  const columns=template.paper==='A3'?(template.sheet_columns||2):1
  const size=(width-24-(columns-1)*8)/columns
  const index=Math.max(0,Math.min(columns-1,Math.floor((x-12+4)/(size+8))))
  const edge=12+index*(size+8)
  const left=Math.ceil((edge-1e-8)*1000)/1000
  return {left,right:left+Math.floor((size+1e-8)*10)/10,top:(template.layout_version||2)<3||page===1&&index===0?100:35,bottom:270}
}
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n))
type Point={x:number;y:number}
export function uniformSubjectiveWidths(template:Template):Template {
  const questions=template.questions.map(q=>q.type!=='subjective'?q:{...q,regions:q.regions.map(r=>{
    const {left,right}=columnBounds(template,r.page,r.x)
    return {...r,x:left,width:Math.round((right-left)*1000)/1000}
  })})
  return {...template,questions}
}
export function subjectiveRegion(template:Template,page:number,start:Point,end:Point,existing?:Region):Region {
  const {left,right,top,bottom}=columnBounds(template,page,existing?.x??start.x)
  const a=clamp(start.y,top,bottom), b=clamp(end.y,top,bottom)
  const y=existing?clamp(existing.y+end.y-start.y,top,bottom-existing.height):Math.min(a,b)
  return {...existing,page,x:left,y,width:Math.round((right-left)*1000)/1000,height:existing?.height??Math.abs(b-a)}
}
export function noteRegion(template:Template,page:number,start:Point,end:Point,existing?:Region,resize=false):Region {
  const {left,right,top,bottom}=columnBounds(template,page,existing?(resize?existing.x:existing.x+end.x-start.x):start.x)
  const snap=(v:number)=>Math.round(v/2)*2
  if(existing&&resize)return {...existing,width:clamp(snap(end.x-existing.x),12,right-existing.x),height:clamp(snap(end.y-existing.y),6,bottom-existing.y)}
  const width=existing?.width??clamp(snap(Math.abs(end.x-start.x))||40,12,right-left)
  const height=existing?.height??clamp(snap(Math.abs(end.y-start.y))||10,6,bottom-top)
  const x=existing?existing.x+end.x-start.x:Math.min(start.x,end.x)
  const y=existing?existing.y+end.y-start.y:Math.min(start.y,end.y)
  return {page,x:clamp(snap(x),left,right-width),y:clamp(snap(y),top,bottom-height),width,height}
}
export function intersects(a:Region,b:Region) {
  return a.page===b.page && a.x<b.x+b.width && b.x<a.x+a.width && a.y<b.y+b.height && b.y<a.y+a.height
}

export function forbiddenRegion(template:Template,page:number,start:{x:number;y:number},end:{x:number;y:number},existing?:Region,resize=false):Region {
  const width=template.paper==='A3'?420:210,count=template.paper==='A3'?(template.sheet_columns||2):1,pw=(width-24-(count-1)*8)/count
  const anchor=existing?.x??start.x,panel=Math.max(0,Math.min(count-1,Math.floor((anchor-12)/(pw+8)))),edge=12+panel*(pw+8),left=Math.ceil(edge*10)/10,right=Math.floor((edge+pw)*10)/10,top=page===1&&panel===0?100:35
  const clamp=(n:number,a:number,b:number)=>Math.max(a,Math.min(b,n))
  let region:Region
  if(existing&&!resize)region={...existing,x:clamp(existing.x+end.x-start.x,left,right-existing.width),y:clamp(existing.y+end.y-start.y,top,270-existing.height)}
  else if(existing)region={...existing,width:clamp(end.x-existing.x,10,right-existing.x),height:clamp(end.y-existing.y,8,270-existing.y)}
  else {const x1=clamp(start.x,left,right),x2=clamp(end.x,left,right),y1=clamp(start.y,top,270),y2=clamp(end.y,top,270);region={page,x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x1-x2),height:Math.abs(y1-y2)}}
  return Object.fromEntries(Object.entries(region).map(([key,value])=>[key,Math.round(value*10)/10])) as Region
}

export function forbiddenConflict(template:Template,region:Region,index?:number){
  if(region.width<10||region.height<8)return '禁答区至少宽10毫米、高8毫米'
  const occupied=[...template.questions.flatMap(q=>q.regions),...(template.print_notes||[]),...(template.forbidden_regions||[]).filter((_,i)=>i!==index)]
  return occupied.some(r=>r.page===region.page&&r.x<region.x+region.width&&region.x<r.x+r.width&&r.y<region.y+region.height&&region.y<r.y+r.height)?'禁答区与已有区域重叠，请调整位置或大小':''
}
