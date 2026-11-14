import { ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons'
import { useEffect, useRef, useState } from 'react'
import { Alert, App, Space, Typography } from 'antd'
import { Button } from './Button'
import { requestBlob, type PrintNote, type Region, type Template } from './api'
import { choiceCenters, compactChoice } from './objectiveLayout'
import { forbiddenRegion, forbiddenConflict, subjectiveRegion, noteRegion, intersects } from './sheetRegions'

type Drag = { x:number;y:number;qid:string;index?:number;region?:Region;forbidden?:boolean;note?:boolean;resize?:boolean }
export function Paper({value,page,selected,draw,answerMode=false,forbiddenMode=false,readOnly=false,noteMode=false,selectedNote,onNoteSelect,onNoteRegion,onSelect,onRegion,onAnswer,onForbidden}:{value:Template;page:number;selected?:string;draw:boolean;answerMode?:boolean;forbiddenMode?:boolean;readOnly?:boolean;noteMode?:boolean;selectedNote?:string;onNoteSelect?:(id:string)=>void;onNoteRegion?:(region:Region,id?:string)=>void;onSelect:(id:string,page?:number)=>void;onRegion:(id:string,region:Region,index?:number)=>void;onAnswer?:(id:string,letter:string)=>void;onForbidden?:(regions:Region[])=>void}) {
  const width=value.paper==='A3'?420:210,height=297,svg=useRef<SVGSVGElement>(null),start=useRef<Drag|null>(null)
  const [zoom,setZoom]=useState<number|null>(null), scroll=useRef<HTMLDivElement>(null)
  const [fit,setFit]=useState(100)
  useEffect(()=>{
    const box=scroll.current
    if(!box)return
    function measure(){
      if(!box)return
      const css=getComputedStyle(box), w=box.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight)
      const viewHeight=window.visualViewport?.height??window.innerHeight
      const top=Math.max(0,box.getBoundingClientRect().top)
      const remaining=top>=viewHeight?viewHeight*.65:viewHeight-top-48
      const available=Math.max(1,Math.min(window.innerHeight*.68,remaining)-parseFloat(css.paddingTop)-parseFloat(css.paddingBottom))
      if(w>0)setFit(Math.max(1,Math.min(100,Math.floor(available*width/(height*w)*100))))
    }
    const observer=new ResizeObserver(measure)
    observer.observe(box);if(box.parentElement)observer.observe(box.parentElement)
    measure();window.addEventListener('resize',measure);window.addEventListener('scroll',measure,true)
    window.visualViewport?.addEventListener('resize',measure)
    return ()=>{observer.disconnect();window.removeEventListener('resize',measure);window.removeEventListener('scroll',measure,true);window.visualViewport?.removeEventListener('resize',measure)}
  },[width,height])
  const scale=zoom??fit
  const [selectedForbidden,setSelectedForbidden]=useState<number|null>(null),{message}=App.useApp()
  const [draft,setDraft]=useState<Region|null>(null),[preview,setPreview]=useState<{url:string;paper:string;page:number;key:string}|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0)
  const currentUrl=useRef(''),payload=JSON.stringify({...value,questions:value.questions.map(q=>({...q,answer:[]}))}),key=`${page}:${payload}`
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
  useEffect(()=>{start.current=null;setDraft(null);setSelectedForbidden(null)},[page,value.id,forbiddenMode,noteMode,draw,answerMode,readOnly])
  useEffect(()=>{if(answerMode&&selected)svg.current?.querySelector(`[data-question-id="${selected}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'})},[selected,page,answerMode])
  const objective=value.questions.filter(q=>q.type!=='subjective').sort((a,b)=>a.number-b.number)
  function answerKey(event:React.KeyboardEvent){
    if(!answerMode||readOnly||event.ctrlKey||event.metaKey||event.altKey)return
    const index=Math.max(0,objective.findIndex(q=>q.id===selected)),q=objective[index];if(!q)return
    const letter=/^[1-5]$/.test(event.key)?'ABCDE'[Number(event.key)-1]:/^[a-e]$/i.test(event.key)?event.key.toUpperCase():''
    if(letter&&'ABCDE'.slice(0,q.options).includes(letter)){event.preventDefault();onAnswer?.(q.id,letter)}
    else if(['Enter','6','ArrowRight','ArrowLeft'].includes(event.key)){event.preventDefault();const next=objective[Math.max(0,Math.min(objective.length-1,index+(event.key==='ArrowLeft'?-1:1)))];onSelect(next.id,next.regions[0]?.page)}
  }
  const visible=preview?.paper===value.paper&&preview.page===page?preview:null,pending=preview?.key!==key
  function minimumY(x:number){const panels=value.paper==='A3'?(value.sheet_columns||2):1,panelWidth=(width-24-(panels-1)*8)/panels;return (value.layout_version||2)>=3&&(page!==1||x>=12+panelWidth)?35:100}
  function point(event:React.PointerEvent){const rect=svg.current!.getBoundingClientRect(),x=Math.max(0,Math.min(width-8,(event.clientX-rect.left)/rect.width*width));return{x,y:Math.max(0,Math.min(height-8,(event.clientY-rect.top)/rect.height*height))}}
  function regionAt(p:{x:number;y:number},s:Drag):Region{if(s.note)return noteRegion(value,page,s,p,s.region,s.resize);if(!s.forbidden&&value.questions.find(q=>q.id===s.qid)?.type==='subjective')return subjectiveRegion(value,page,s,p,s.region);if(s.forbidden)return forbiddenRegion(value,page,s,p,s.region,s.resize);const bottom=value.print_style==='standard-v2'?270:height-8,x=s.region?Math.max(0,Math.min(width-8-s.region.width,s.region.x+p.x-s.x)):Math.min(s.x,p.x);return s.region?{...s.region,x,y:Math.max(minimumY(x),Math.min(bottom-s.region.height,s.region.y+p.y-s.y))}:{page,x,y:Math.max(minimumY(x),Math.min(s.y,p.y)),width:Math.abs(s.x-p.x),height:Math.abs(Math.min(s.y,bottom)-Math.min(p.y,bottom))}}
  function finish(event:React.PointerEvent){
    const s=start.current
    start.current=null
    setDraft(null)
    if(!s||readOnly)return
    const p=point(event)
    if(s.region && Math.abs(p.x-s.x)+Math.abs(p.y-s.y)<.5)return
    const next=regionAt(p,s)
    if(s.note){
      const protectedRegions=[...value.questions.filter(q=>q.type!=='subjective').flatMap(q=>q.regions),...(value.forbidden_regions||[])]
      if(protectedRegions.some(r=>intersects(r,next)))message.warning('文字位置与选择题或禁答区重叠')
      else onNoteRegion?.(next,s.region?s.qid:undefined)
    }else if(s.forbidden){
      const error=forbiddenConflict(value,next,s.index)
      if(error){message.warning(error);return}
      const areas=[...(value.forbidden_regions||[])]
      if(s.index===undefined){areas.push(next);setSelectedForbidden(areas.length-1)}else areas[s.index]=next
      onForbidden?.(areas)
    }else if(next.width>2&&next.height>2){
      const rounded=Object.fromEntries(Object.entries(next).map(([k,v])=>[k,Math.round(v*1000)/1000])) as Region
      const occupied=value.questions.flatMap(q=>q.regions.filter((_,i)=>q.id!==s.qid||i!==s.index))
      occupied.push(...(value.forbidden_regions||[]))
      if(value.questions.find(q=>q.id===s.qid)?.type!=='subjective')occupied.push(...(value.print_notes||[]))
      if(occupied.some(r=>intersects(r,rounded)))message.warning('答题区域重叠，请重新选取')
      else onRegion(s.qid,rounded,s.index)
    }
  }
  function dragNote(e:React.PointerEvent,note:PrintNote,resize=false){
    e.stopPropagation()
    onNoteSelect?.(note.id)
    if(readOnly)return
    start.current={...point(e),qid:note.id,note:true,region:note,resize}
    svg.current!.setPointerCapture(e.pointerId)
  }
  return <Space direction="vertical" style={{width:'100%'}}>
    <Space size={8}><Button size="small" icon={<ZoomOutOutlined />} disabled={scale<=10} onClick={()=>setZoom(Math.max(10,scale-10))}>缩小</Button><Button size="small" type={zoom===null?'primary':'default'} onClick={()=>setZoom(null)}>适合屏幕</Button><Button size="small" title="恢复 100%" onClick={()=>setZoom(100)}>{scale}%</Button><Button size="small" icon={<ZoomInOutlined />} disabled={scale>=300} onClick={()=>setZoom(Math.min(300,scale+10))}>放大</Button></Space>
    {forbiddenMode&&<Space wrap><Typography.Text type="secondary">拖动空白处添加禁答区；拖动区域移动，拖动右下角调整大小。</Typography.Text><Button size="small" danger disabled={readOnly||selectedForbidden===null} onClick={()=>{onForbidden?.((value.forbidden_regions||[]).filter((_,i)=>i!==selectedForbidden));setSelectedForbidden(null)}}>删除选中禁答区</Button></Space>}
    {error?<Alert type="warning" showIcon message="打印预览尚未更新" description={error} action={<Button size="small" onClick={()=>setRetry(v=>v+1)}>重试</Button>}/>:<Typography.Text type="secondary" role="status">{pending?'正在更新打印预览…':'预览已更新'}{pending&&visible?'，下方暂显示上次生成的打印稿。':''}{value.status!=='published'&&value.status!=='superseded'?' · 草稿预览，发布后可导出打印稿。':''}</Typography.Text>}
    <div ref={scroll} className="paper-scroll"><svg ref={svg} tabIndex={answerMode?0:undefined} onKeyDown={answerKey} style={{width:`${scale}%`,minWidth:0,marginInline:'auto'}} className={`paper-svg ${draw||forbiddenMode||noteMode?'drawing':''}`} viewBox={`0 0 ${width} ${height}`} aria-label={answerMode?'点击选项或使用数字键设置标准答案':'题卡打印预览与答题区域编辑'} onPointerDown={e=>{if(answerMode){e.currentTarget.focus();return}if(readOnly||(!noteMode&&!forbiddenMode&&(!draw||!selected)))return;start.current={...point(e),qid:selected||'',forbidden:forbiddenMode,note:noteMode};setDraft(null);e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(start.current)setDraft(regionAt(point(e),start.current))}} onPointerUp={finish} onPointerCancel={()=>{start.current=null;setDraft(null)}}>
      <rect width={width} height={height} fill="white"/>
      {visible&&<image href={visible.url} x={0} y={0} width={width} height={height} preserveAspectRatio="none" pointerEvents="none"/>}
      {value.questions.flatMap(q=>q.regions.map((r,index)=>r.page!==page?null:<g key={`${q.id}-${index}`} pointerEvents={forbiddenMode||noteMode||draw&&!readOnly?'none':undefined}>
        <rect data-question-id={q.id} x={r.x} y={r.y} width={r.width} height={r.height} fill={selected===q.id?'#0866ff12':'transparent'} stroke={selected===q.id?'#0866ff':'transparent'} strokeWidth={.4} onPointerDown={e=>{e.stopPropagation();onSelect(q.id);svg.current?.focus();if(!readOnly&&!draw&&!answerMode){start.current={...point(e),qid:q.id,index,region:r};svg.current!.setPointerCapture(e.pointerId)}}}><title>第{q.number}题 · 区域{index+1}</title></rect>
        {answerMode&&q.type!=='subjective'&&choiceCenters(q,r).map(({letter,x,y})=><rect key={letter} role="button" aria-label={`第${q.number}题选项${letter}`} aria-pressed={q.answer.includes(letter)} x={x-(q.choice_style==='bracket'?4:2)} y={y-1.5} width={q.choice_style==='bracket'?8:compactChoice.width} height={3} rx={.4} fill={q.answer.includes(letter)?'#0866ff35':'transparent'} stroke={q.answer.includes(letter)?'#0866ff':'transparent'} strokeWidth={.3} style={{cursor:readOnly?'default':'pointer'}} onPointerDown={e=>{e.stopPropagation();svg.current?.focus()}} onClick={()=>{if(!readOnly)onAnswer?.(q.id,letter)}}><title>第{q.number}题 · {letter}</title></rect>)}
      </g>))}
      {noteMode&&<>
        <defs><pattern id="note-grid" width={2} height={2} patternUnits="userSpaceOnUse"><circle cx={0.2} cy={0.2} r={0.17} fill="#8594aa"/></pattern></defs>
        <rect width={width} height={height} fill="url(#note-grid)" pointerEvents="none"/>
        {(value.print_notes||[]).filter(note=>note.page===page).map(note=><g key={note.id}>
          <rect x={note.x} y={note.y} width={note.width} height={note.height} fill="transparent" stroke={selectedNote===note.id?'#0866ff':'#789'} strokeWidth={.35} strokeDasharray="1 1" style={{cursor:'move'}} onPointerDown={e=>dragNote(e,note)}><title>移动版面文字</title></rect>
          {selectedNote===note.id&&!readOnly&&<rect aria-label="调整文字框大小" x={note.x+note.width-1.5} y={note.y+note.height-1.5} width={3} height={3} fill="#0866ff" style={{cursor:'nwse-resize'}} onPointerDown={e=>dragNote(e,note,true)}><title>调整文字框大小</title></rect>}
        </g>)}
      </>}
      {forbiddenMode&&(value.forbidden_regions||[]).map((r,index)=>r.page!==page?null:<g key={`forbidden-${index}`}>
        <rect x={r.x} y={r.y} width={r.width} height={r.height} fill="#0866ff10" stroke={selectedForbidden===index?'#0866ff':'#888'} strokeWidth={.4} style={{cursor:readOnly?'default':'move'}} onPointerDown={e=>{e.stopPropagation();setSelectedForbidden(index);if(readOnly)return;start.current={...point(e),qid:'',forbidden:true,index,region:r};svg.current!.setPointerCapture(e.pointerId)}}><title>禁答区 {index+1}</title></rect>
        {selectedForbidden===index&&!readOnly&&<rect x={r.x+r.width-2} y={r.y+r.height-2} width={4} height={4} fill="#0866ff" style={{cursor:'nwse-resize'}} onPointerDown={e=>{e.stopPropagation();start.current={...point(e),qid:'',forbidden:true,index,region:r,resize:true};svg.current!.setPointerCapture(e.pointerId)}}><title>调整禁答区大小</title></rect>}
      </g>)}
      {draft&&<rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} stroke="#0866ff" fill="#0866ff20" strokeDasharray="2 1" strokeWidth={.6} pointerEvents="none"/>}
    </svg></div>
  </Space>
}
