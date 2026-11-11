import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Space, Typography } from 'antd'
import { requestBlob, type Region, type Template } from './api'

type Drag = { x:number;y:number;qid:string;index?:number;region?:Region }
export function Paper({value,page,selected,draw,onSelect,onRegion}:{value:Template;page:number;selected?:string;draw:boolean;onSelect:(id:string)=>void;onRegion:(id:string,region:Region,index?:number)=>void}) {
  const width=value.paper==='A3'?420:210,height=297,svg=useRef<SVGSVGElement>(null),start=useRef<Drag|null>(null)
  const [draft,setDraft]=useState<Region|null>(null),[preview,setPreview]=useState<{url:string;paper:string;page:number;key:string}|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0)
  const currentUrl=useRef(''),payload=JSON.stringify(value),key=`${page}:${payload}`
  useEffect(()=>{
    const abort=new AbortController();let cancelled=false
    setError('')
    const timer=setTimeout(async()=>{
      try{
        const blob=await requestBlob(`/templates/preview?page=${page}`,{method:'POST',body:payload,signal:abort.signal})
        if(cancelled)return
        const url=URL.createObjectURL(blob),previous=currentUrl.current;currentUrl.current=url
        setPreview({url,paper:JSON.parse(payload).paper,page,key})
        if(previous)URL.revokeObjectURL(previous)
      }catch(e){if(!cancelled)setError((e as Error).message)}
    },700)
    return()=>{cancelled=true;clearTimeout(timer);abort.abort()}
  },[payload,page,key,retry])
  useEffect(()=>()=>{if(currentUrl.current)URL.revokeObjectURL(currentUrl.current)},[])
  useEffect(()=>{start.current=null;setDraft(null)},[page,value.id])
  const visible=preview?.paper===value.paper&&preview.page===page?preview:null,pending=preview?.key!==key
  function point(event:React.PointerEvent){const rect=svg.current!.getBoundingClientRect();return{x:Math.max(0,Math.min(width-8,(event.clientX-rect.left)/rect.width*width)),y:Math.max(100,Math.min(height-8,(event.clientY-rect.top)/rect.height*height))}}
  function regionAt(p:{x:number;y:number},s:Drag):Region{return s.region?{...s.region,x:Math.max(0,Math.min(width-8-s.region.width,s.region.x+p.x-s.x)),y:Math.max(100,Math.min(height-8-s.region.height,s.region.y+p.y-s.y))}:{page,x:Math.min(s.x,p.x),y:Math.min(s.y,p.y),width:Math.abs(s.x-p.x),height:Math.abs(s.y-p.y)}}
  function finish(event:React.PointerEvent){const s=start.current;if(s){const next=regionAt(point(event),s);if(next.width>2&&next.height>2)onRegion(s.qid,Object.fromEntries(Object.entries(next).map(([k,v])=>[k,Math.round(v*10)/10])) as Region,s.index)}start.current=null;setDraft(null)}
  return <Space direction="vertical" style={{width:'100%'}}>
    {error?<Alert type="warning" showIcon message="打印预览尚未更新" description={error} action={<Button size="small" onClick={()=>setRetry(v=>v+1)}>重试</Button>}/>:<Typography.Text type="secondary" role="status">{pending?'正在更新打印预览…':'预览已更新'}{pending&&visible?'，下方暂显示上次生成的打印稿。':''}{value.status!=='published'?' · 草稿预览，发布后可导出打印稿。':''}</Typography.Text>}
    <div className="paper-scroll"><svg ref={svg} className={`paper-svg ${draw?'drawing':''}`} viewBox={`0 0 ${width} ${height}`} aria-label="题卡打印预览与答题区域编辑" onPointerDown={e=>{if(!draw||!selected)return;start.current={...point(e),qid:selected};setDraft(null);e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(start.current)setDraft(regionAt(point(e),start.current))}} onPointerUp={finish} onPointerCancel={()=>{start.current=null;setDraft(null)}}>
      <rect width={width} height={height} fill="white"/>
      {visible&&<image href={visible.url} x={0} y={0} width={width} height={height} preserveAspectRatio="none" pointerEvents="none"/>}
      {value.questions.flatMap(q=>q.regions.map((r,index)=>r.page!==page?null:<rect key={`${q.id}-${index}`} x={r.x} y={r.y} width={r.width} height={r.height} fill={selected===q.id?'#17655b12':'transparent'} stroke={selected===q.id?'#17655b':'transparent'} strokeWidth={.65} onPointerDown={e=>{e.stopPropagation();onSelect(q.id);if(!draw){start.current={...point(e),qid:q.id,index,region:r};svg.current!.setPointerCapture(e.pointerId)}}}><title>第{q.number}题 · 区域{index+1}</title></rect>))}
      {draft&&<rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} stroke="#17655b" fill="#17655b20" strokeDasharray="2 1" strokeWidth={.6} pointerEvents="none"/>}
    </svg></div>
  </Space>
}
