import type { Region, Template } from './api'

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
  const occupied=[...template.questions.flatMap(q=>q.regions),...(template.forbidden_regions||[]).filter((_,i)=>i!==index)]
  return occupied.some(r=>r.page===region.page&&r.x<region.x+region.width&&region.x<r.x+r.width&&r.y<region.y+region.height&&region.y<r.y+r.height)?'禁答区与已有区域重叠，请调整位置或大小':''
}
