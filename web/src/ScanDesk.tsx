import {useEffect,useRef,useState,type ReactNode} from 'react'
import {Checkbox,Empty,Input,Pagination,Select,Tabs} from 'antd'
import {scannerCall} from './scanner-bridge'
import type {Paper} from './scannerRoomPages'
import {Button} from './Button'
import {ArrowDownOutlined,ArrowUpOutlined,ZoomInOutlined,ZoomOutOutlined} from '@ant-design/icons'

type Row=Record<string,any>&{id:string}
type Props={
  rows:Row[];papers:Paper[];total:number;page:number;onPage:(page:number)=>void
  selected?:Row|null;onSelect:(row:Row)=>void;capturing:boolean;syncing:boolean;processing:boolean;processingRemaining:number;needsReview:boolean
  scope:ReactNode;stats:{label:string;value:number|string}[];context:ReactNode
  actions:ReactNode;settings:ReactNode;image:ReactNode;imageTools:ReactNode;editor:ReactNode
  pageActions:ReactNode;feedback:ReactNode;upload:ReactNode
}
let thumbnailQueue=Promise.resolve()
function FacePreview({face,label,selected,onSelect}:{face?:Row;label:string;selected:boolean;onSelect:(row:Row)=>void}){
  const ref=useRef<HTMLButtonElement>(null)
  const [image,setImage]=useState('')
  useEffect(()=>{
    if(!face||!ref.current)return
    let live=true
    const observer=new IntersectionObserver(entries=>{
      if(!entries.some(entry=>entry.isIntersecting))return
      observer.disconnect()
      thumbnailQueue=thumbnailQueue.then(async()=>{
        if(!live)return
        const preview=await scannerCall<{url:string}>('preview',{batch_id:face.batch_id,page_id:face.id})
        if(live)setImage(preview.url)
      }).catch(()=>{})
    })
    observer.observe(ref.current)
    return ()=>{live=false;observer.disconnect()}
  },[face?.id,face?.batch_id])
  if(!face)return <div className="scan-face is-missing">{label}<small>尚未收到</small></div>
  return <button ref={ref} type="button" className={'scan-face '+(selected?'is-selected':'')} aria-pressed={selected} aria-label={'查看第 '+face.sheet_number+' 张'+label} onClick={()=>onSelect(face)}>
    {image&&<img src={image} alt=""/>}<span>{label}</span>
  </button>
}
function paperStatus(paper:Paper){
  const sides=[paper.front,paper.back].filter((r):r is Row=>!!r)
  if(sides.some(s=>s.status==='blocked'))return '待核对'
  if(sides.length&&sides.every(s=>s.status==='excluded'))return '已排除'
  if(paper.duplex&&(!paper.front||!paper.back))return paper.front?'待收背面':'待收正面'
  if(sides.some(s=>s.status==='pending'&&!s.recognized))return '正在识读'
  if(!sides.length)return '等待图像'
  return sides.every(s=>s.status==='uploaded')?'已上传':'本地暂存'
}
export function ScanDesk(p:Props){
  const [search,setSearch]=useState(''),[status,setStatus]=useState('all'),[follow,setFollow]=useState(true),[zoom,setZoom]=useState(100)
  const select=useRef(p.onSelect);select.current=p.onSelect
  const last=useRef('')
  useEffect(()=>{
    const target=p.capturing&&follow?p.rows.at(-1):!p.selected?p.rows[0]:undefined
    if(target&&(!p.selected||target.id!==last.current)){last.current=target.id;select.current(target)}
  },[p.rows,p.capturing,follow,p.selected])
  useEffect(()=>{
    if(p.capturing&&follow&&p.total>p.page*50)p.onPage(Math.ceil(p.total/50))
  },[p.total,p.capturing,follow,p.page,p.onPage])
  const papers=p.papers.filter(paper=>{
    const sides=[paper.front,paper.back].filter((r):r is Row=>!!r)
    return (status==='all'||sides.some(r=>r.status===status))&&(!search||[paper.number,paperStatus(paper),...sides.flatMap(r=>[r.candidate,r.error,r.side==='front'?'正面':'背面'])].some(v=>String(v??'').includes(search)))
  })
  const rows=papers.flatMap(p=>[p.front,p.back].filter((r):r is Row=>!!r))
  const current=p.rows.findIndex(r=>r.id===p.selected?.id)
  function choose(row:Row){setFollow(false);last.current=row.id;p.onSelect(row)}
  return <section className="scan-workspace">
    <div className="scan-workspace-context">{p.context}<span className={'scan-live '+(p.capturing?'is-active':'')}>{p.capturing?(p.total?'正在接收扫描图像':'等待扫描仪返回图像'):p.processing?'后台识读 · '+p.processingRemaining+' 面':p.syncing?'正在上传':p.needsReview?'需要核对':p.total?'采集完成':'准备扫描'}</span></div>
    <div className="scan-stats">{p.stats.map(s=><div key={s.label}><span>{s.label}</span><strong>{s.value}</strong></div>)}</div>
    <div className="scan-desk">
      <aside className="scan-paper-panel" aria-label="扫描纸张列表">
        <div className="scan-panel-heading"><h3>扫描记录</h3>{p.scope}</div>
        <div className="scan-paper-filters"><Input.Search value={search} allowClear placeholder="搜索本页考号、纸张或异常" onChange={e=>setSearch(e.target.value)}/><Select aria-label="纸张状态筛选" value={status} onChange={setStatus} options={[{value:'all',label:'全部状态'},{value:'blocked',label:'待核对'},{value:'pending',label:'本地暂存'},{value:'uploaded',label:'已上传'}]}/><Checkbox checked={follow} onChange={e=>setFollow(e.target.checked)}>跟随最新扫描</Checkbox></div>
        <div className="scan-paper-list" role="list" onKeyDown={e=>{
          if(!['ArrowUp','ArrowDown'].includes(e.key))return
          e.preventDefault();const index=rows.findIndex(r=>r.id===p.selected?.id),next=rows[index+(e.key==='ArrowDown'?1:-1)];if(next)choose(next)
        }}>
          {papers.length?papers.map(paper=><article role="listitem" key={paper.id} className={'scan-paper-pair '+(p.selected&&(paper.front?.id===p.selected.id||paper.back?.id===p.selected.id)?'is-selected':'')}>
            <header><strong>第 {paper.number} 张</strong><span>{paperStatus(paper)}</span></header>
            <div className="scan-paper-faces"><FacePreview key={paper.front?.id||'front'} label="正面" face={paper.front} selected={!!paper.front&&paper.front.id===p.selected?.id} onSelect={choose}/>{paper.duplex&&<FacePreview key={paper.back?.id||'back'} label="背面" face={paper.back} selected={!!paper.back&&paper.back.id===p.selected?.id} onSelect={choose}/>}</div>
            <small>{paper.front?.candidate||'考号待识读'}</small>
            {(paper.front?.error||paper.back?.error)&&<small className="scan-text-warning">{[paper.front?.error,paper.back?.error].filter(Boolean).join(' · ')}</small>}
          </article>):<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search||status!=='all'?'本页没有匹配的纸张':'扫描后，纸张将逐张显示在这里'}/>}
        </div>
        <div className="scan-paper-footer"><span>共 {p.total} 张</span><Pagination simple={{readOnly:true}} current={p.page} pageSize={50} total={p.total} showSizeChanger={false} onChange={p.onPage}/></div>
      </aside>
      <section className="scan-image-panel" aria-label="答卷原图与核对">
        <div className="scan-image-toolbar"><div>{p.imageTools}</div><div className="scan-zoom"><Button type="text" icon={<ZoomOutOutlined/>} aria-label="缩小原图" disabled={!p.selected} onClick={()=>setZoom(n=>Math.max(50,n-25))}/><Button type="text" disabled={!p.selected} onClick={()=>setZoom(100)}>{zoom}%</Button><Button type="text" icon={<ZoomInOutlined/>} aria-label="放大原图" disabled={!p.selected} onClick={()=>setZoom(n=>Math.min(250,n+25))}/></div></div>
        <div className="scan-canvas"><div className="scan-image-content" style={{width:zoom+'%',height:zoom+'%'}}>{p.selected?p.image:<Empty description="选择左侧纸张，查看原图与识读结果"/>}</div></div>
        <div className="scan-editor">{p.editor}</div>
        <div className="scan-image-footer"><Button icon={<ArrowUpOutlined/>} disabled={current<=0} onClick={()=>choose(p.rows[current-1])}>上一面</Button><span>{p.selected?'第 '+(p.selected.sheet_number??p.selected.sequence)+' 张 · '+(p.selected.side==='front'?'正面':'背面'):'等待扫描'}</span><Button icon={<ArrowDownOutlined/>} disabled={current<0||current>=p.rows.length-1} onClick={()=>choose(p.rows[current+1])}>下一面</Button></div>
      </section>
      <aside className="scan-operations" aria-label="扫描及上传操作">
        <Tabs defaultActiveKey="operations" items={[
          {key:'operations',label:'扫描与上传',children:<div className="scan-operation-stack">
            <section className="scan-operation-card"><h3>扫描操作</h3><div className="scan-operation-buttons">{p.actions}</div></section>
            <section className="scan-operation-card scan-upload-card"><h3>核对与上传</h3>{p.upload}</section>
            <section className="scan-operation-card"><h3>运行状态</h3><div role="status" aria-live="polite">{p.feedback}</div></section>
          </div>},
          {key:'page',label:'当前纸张',children:p.selected?<section className="scan-operation-card">{p.pageActions}</section>:<Empty description="选择一张纸后处理"/>}
        ]}/>
        <div className="scan-device-footer">{p.settings}</div>
      </aside>
    </div>
  </section>
}
