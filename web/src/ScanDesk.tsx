import {useEffect,useRef,useState,type ReactNode} from 'react'
import {Checkbox,Empty,Input,Pagination,Select} from 'antd'
import {Button} from './Button'
import {ArrowDownOutlined,ArrowUpOutlined,ZoomInOutlined,ZoomOutOutlined} from '@ant-design/icons'

type Row=Record<string,any>&{id:string}
type Props={
  rows:Row[];total:number;page:number;onPage:(page:number)=>void
  selected?:Row|null;onSelect:(row:Row)=>void;capturing:boolean;syncing:boolean
  scope:ReactNode;stats:{label:string;value:number|string}[];context:ReactNode
  actions:ReactNode;settings:ReactNode;image:ReactNode;imageTools:ReactNode;editor:ReactNode
  pageActions:ReactNode;feedback:ReactNode;upload:ReactNode
}
const names:Record<string,string>={pending:'已识读 · 本机暂存',uploaded:'已上传',blocked:'待核对',excluded:'已排除'}
export function ScanDesk(p:Props){
  const [search,setSearch]=useState(''),[status,setStatus]=useState('all'),[follow,setFollow]=useState(true),[zoom,setZoom]=useState(100)
  const select=useRef(p.onSelect);select.current=p.onSelect
  const last=useRef('')
  useEffect(()=>{
    const target=p.capturing&&follow?p.rows.at(-1):!p.selected?p.rows[0]:undefined
    if(target&&target.id!==last.current){last.current=target.id;select.current(target)}
  },[p.rows,p.capturing,follow,p.selected])
  useEffect(()=>{
    if(p.capturing&&follow&&p.total>p.page*50)p.onPage(Math.ceil(p.total/50))
  },[p.total,p.capturing,follow,p.page,p.onPage])
  const rows=p.rows.filter(r=>(status==='all'||status==='blocked'&&r.status==='blocked'||status==='pending'&&r.status==='pending'||status==='uploaded'&&r.status==='uploaded')&&
    (!search||[r.candidate,r.sheet_number,r.sequence,r.error,r.side==='front'?'正面':'背面'].some(v=>String(v??'').includes(search))))
  const current=p.rows.findIndex(r=>r.id===p.selected?.id)
  function choose(row:Row){setFollow(false);last.current=row.id;p.onSelect(row)}
  return <section className="scan-workspace">
    <div className="scan-workspace-context">{p.context}<span className={'scan-live '+(p.capturing?'is-active':'')}>{p.capturing?'正在扫描':p.syncing?'正在上传':'准备就绪'}</span></div>
    <div className="scan-stats">{p.stats.map(s=><div key={s.label}><span>{s.label}</span><strong>{s.value}</strong></div>)}</div>
    <div className="scan-desk">
      <aside className="scan-paper-panel" aria-label="扫描纸张列表">
        <div className="scan-panel-heading"><h3>扫描记录</h3>{p.scope}</div>
        <div className="scan-paper-filters"><Input.Search value={search} allowClear placeholder="搜索本页考号、纸张或异常" onChange={e=>setSearch(e.target.value)}/><Select aria-label="纸张状态筛选" value={status} onChange={setStatus} options={[{value:'all',label:'全部状态'},{value:'blocked',label:'待核对'},{value:'pending',label:'本地暂存'},{value:'uploaded',label:'已上传'}]}/><Checkbox checked={follow} onChange={e=>setFollow(e.target.checked)}>跟随最新扫描</Checkbox></div>
        <div className="scan-paper-list" role="list" onKeyDown={e=>{
          if(!['ArrowUp','ArrowDown'].includes(e.key))return
          e.preventDefault();const index=rows.findIndex(r=>r.id===p.selected?.id),next=rows[index+(e.key==='ArrowDown'?1:-1)];if(next)choose(next)
        }}>
          {rows.length?rows.map(row=><button type="button" role="listitem" aria-current={row.id===p.selected?.id?'true':undefined} key={row.id} className={'scan-paper-item '+(row.id===p.selected?.id?'is-selected':'')} onClick={()=>choose(row)}>
            <span className={'scan-paper-symbol '+(row.status==='blocked'?'has-error':'')} aria-hidden="true">{row.sheet_number??row.sequence}</span>
            <span className="scan-paper-meta"><strong>第 {row.sheet_number??row.sequence} 张 · {row.side==='front'?'正面':'背面'}</strong><span>{row.candidate||'考号待识读'}</span><span className={row.status==='blocked'?'scan-text-warning':''}>{row.status==='pending'&&!row.recognized?'正在识读':names[row.status]||row.status}</span>{row.error&&<span className="scan-paper-error">{row.error}</span>}</span>
          </button>):<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search||status!=='all'?'本页没有匹配的纸张':'扫描后，纸张将逐张显示在这里'}/>}
        </div>
        <div className="scan-paper-footer"><span>共 {p.total} 面</span><Pagination simple current={p.page} pageSize={50} total={p.total} showSizeChanger={false} onChange={p.onPage}/></div>
      </aside>
      <section className="scan-image-panel" aria-label="答卷原图与核对">
        <div className="scan-image-toolbar"><div>{p.imageTools}</div><div className="scan-zoom"><Button type="text" icon={<ZoomOutOutlined/>} aria-label="缩小原图" disabled={!p.selected} onClick={()=>setZoom(n=>Math.max(50,n-25))}/><Button type="text" disabled={!p.selected} onClick={()=>setZoom(100)}>{zoom}%</Button><Button type="text" icon={<ZoomInOutlined/>} aria-label="放大原图" disabled={!p.selected} onClick={()=>setZoom(n=>Math.min(250,n+25))}/></div></div>
        <div className="scan-canvas"><div className="scan-image-content" style={{width:zoom+'%',height:zoom+'%'}}>{p.selected?p.image:<Empty description="选择左侧纸张，查看原图与识读结果"/>}</div></div>
        <div className="scan-editor">{p.editor}</div>
        <div className="scan-image-footer"><Button icon={<ArrowUpOutlined/>} disabled={current<=0} onClick={()=>choose(p.rows[current-1])}>上一面</Button><span>{p.selected?'第 '+(p.selected.sheet_number??p.selected.sequence)+' 张 · '+(p.selected.side==='front'?'正面':'背面'):'等待扫描'}</span><Button icon={<ArrowDownOutlined/>} disabled={current<0||current>=p.rows.length-1} onClick={()=>choose(p.rows[current+1])}>下一面</Button></div>
      </section>
      <aside className="scan-operations" aria-label="扫描及上传操作">
        <section className="scan-operation-card"><h3>扫描操作</h3><div className="scan-operation-buttons">{p.actions}</div></section>
        <section className="scan-operation-card scan-upload-card"><h3>核对与上传</h3>{p.upload}</section>
        {p.selected&&<section className="scan-operation-card"><h3>当前纸张</h3>{p.pageActions}</section>}
        <section className="scan-operation-card"><h3>运行状态</h3><div role="status" aria-live="polite">{p.feedback}</div></section>
        <section className="scan-operation-card scan-device-card">{p.settings}</section>
      </aside>
    </div>
  </section>
}
