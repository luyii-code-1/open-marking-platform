import {isValidElement,useEffect,useRef,useState,type ReactNode} from 'react'
import {App,Checkbox,Dropdown,Input,Select,Space,Table as AntTable,Tag,type TableProps} from 'antd'
import {DownloadOutlined} from '@ant-design/icons'
import {Button} from './Button'
import {requestBlob} from './api'
import {filterRecords,textMatches,type FilterField,type FilterValues} from './recordFilters'
import './recordPicker.css'
import {sortableColumns} from './tableSorting'

function countLabel(total:number){
  return <span className="table-total">共 {total} 条数据</span>
}
function extractCellText(node:unknown):string{
  if(node==null||typeof node==='boolean')return ''
  if(typeof node==='string'||typeof node==='number')return String(node)
  if(Array.isArray(node))return node.map(extractCellText).filter(Boolean).join('、')
  if(isValidElement(node)){
    const p=node.props as Record<string,unknown>
    if(Array.isArray(p.tags))return p.tags.map(t=>String(t??'')).filter(Boolean).join('、')
    if(p.children!==undefined)return extractCellText(p.children)
    if(typeof p.name==='string')return p.name
    if(typeof p.label==='string'||typeof p.label==='number')return String(p.label)
  }
  return ''
}
function readPath(row:Record<string,unknown>,dataIndex:unknown):unknown{
  if(typeof dataIndex==='string'||typeof dataIndex==='number')return row[String(dataIndex)]
  if(Array.isArray(dataIndex)){
    let cur:unknown=row
    for(const key of dataIndex){if(cur==null||typeof cur!=='object')return undefined;cur=(cur as Record<string,unknown>)[String(key)]}
    return cur
  }
  return undefined
}
type Props<T extends object>=TableProps<T>&{totalRows?:number;searchText?:(row:T)=>unknown;query?:string;filterFields?:FilterField<T>[];filterValues?:FilterValues;onFilterValuesChange?:(next:FilterValues)=>void;columnChooser?:boolean;exportable?:boolean|{filename?:string};serverSort?:boolean;toolbar?:ReactNode}
export function Table<T extends object = any>({totalRows,pagination,footer,searchText,query,filterFields=[],filterValues,onFilterValuesChange,columnChooser=true,exportable=true,serverSort=false,toolbar,...props}:Props<T>){
  const [text,setText]=useState(''),[internalFilters,setInternalFilters]=useState<FilterValues>({}),[searchField,setSearchField]=useState(''),[hidden,setHidden]=useState<string[]>([])
  const [exportBusy,setExportBusy]=useState(false)
  const {message}=App.useApp()
  const filters=filterValues??internalFilters
  const setFilters=(updater:FilterValues|((prev:FilterValues)=>FilterValues))=>{
    const next=typeof updater==='function'?updater(filters):updater
    if(onFilterValuesChange)onFilterValuesChange(next)
    else setInternalFilters(next)
  }
  const wrapRef=useRef<HTMLDivElement>(null)
  const [autoY,setAutoY]=useState<number|undefined>(pagination===false?undefined:480)
  const explicitY=props.scroll?.y
  const hasPager=pagination!==false

  useEffect(()=>{
    if(explicitY!==undefined||!hasPager){setAutoY(undefined);return}
    const compute=()=>{
      const el=wrapRef.current
      if(!el)return
      if(el.closest('.ant-modal, .ant-drawer')){
        setAutoY(Math.max(220,Math.min(420,Math.floor(window.innerHeight*0.44))))
        return
      }
      const rect=el.getBoundingClientRect()
      if(rect.width===0&&rect.height===0)return
      const thead=el.querySelector('.ant-table-thead')
      const headH=thead?thead.getBoundingClientRect().height:39
      const reserve=headH+58+34
      const next=Math.max(220,Math.floor(window.innerHeight-rect.top-reserve))
      setAutoY(prev=>(prev!==undefined&&Math.abs(prev-next)<=2?prev:next))
    }
    compute()
    const raf=requestAnimationFrame(compute)
    const timer=setTimeout(compute,120)
    window.addEventListener('resize',compute)
    let ro:ResizeObserver|undefined
    if(typeof ResizeObserver!=='undefined'&&wrapRef.current?.parentElement){
      ro=new ResizeObserver(compute)
      ro.observe(wrapRef.current.parentElement)
    }
    return ()=>{cancelAnimationFrame(raf);clearTimeout(timer);window.removeEventListener('resize',compute);ro?.disconnect()}
  },[explicitY,hasPager,filterFields.length,Object.keys(filters).length])
  const options=pagination||{}
  const term=(query??text).trim().toLocaleLowerCase()
  const active=term||Object.values(filters).some(ids=>ids.length)
  const filtered=filterRecords(props.dataSource||[],filterFields,filters,searchField?term:'',searchField)
  const rows=term&&!searchField?filtered.filter(row=>textMatches(row,term)||textMatches(searchText?.(row),term)):filtered
  const total=active?rows.length:totalRows??options.total??rows.length
  const countInFooter=pagination===false||total===0||
    (options.hideOnSinglePage&&total<=(options.pageSize??options.defaultPageSize??50))
  const pager=pagination===false?false:{defaultPageSize:50,showSizeChanger:true,pageSizeOptions:[15,30,50,100],...options,...(active?{total,...(options.total!==undefined?{current:1}:{})}:{}),showTotal:countLabel}
  const remote=totalRows!==undefined||options.total!==undefined
  const filteredEmpty=active&&!!props.dataSource?.length&&rows.length===0
  const locale=filteredEmpty?{...props.locale,emptyText:<Space wrap>
    {remote?'当前页没有符合条件的记录。':'没有符合条件的记录。'}
    {query===undefined?<Button type="link" onClick={()=>{setText('');setFilters({})}}>清除搜索与筛选</Button>:'请调整搜索或筛选条件。'}
  </Space>}:props.locale
  const choices=sortableColumns(props.columns||[],serverSort).map((column,index)=>({column,key:String(column.key??`${index}:${'dataIndex' in column?String(column.dataIndex):''}`),label:typeof column.title==='string'?column.title:extractCellText(column.title)||`第 ${index+1} 列`}))
  const shown=choices.filter(c=>!hidden.includes(c.key))
  const exportColumns=shown.filter(c=>{const t=typeof c.column.title==='string'?c.column.title.trim():extractCellText(c.column.title).trim();return !!t&&t!=='操作'})
  const canExport=exportable!==false&&columnChooser&&exportColumns.length>0
  async function exportTable(format:'xlsx'|'csv'){
    if(exportBusy||!exportColumns.length)return
    setExportBusy(true)
    try{
      const filenameBase=typeof exportable==='object'&&exportable.filename?exportable.filename:'列表导出'
      const headers=exportColumns.map(c=>c.label)
      const exportRows=rows.map((row,idx)=>exportColumns.map(c=>{
        const col=c.column as {dataIndex?:unknown;render?:(v:unknown,r:T,i:number)=>unknown}
        const raw=col.dataIndex!==undefined?readPath(row as Record<string,unknown>,col.dataIndex):undefined
        if(col.render){
          const txt=extractCellText(col.render(raw,row,idx))
          return txt==='—'?'':txt
        }
        return raw==null?'':Array.isArray(raw)?raw.join('、'):String(raw)
      }))
      const blob=await requestBlob('/table-export',{method:'POST',body:JSON.stringify({title:filenameBase,headers,rows:exportRows,format})})
      const url=URL.createObjectURL(blob),a=document.createElement('a')
      a.href=url;a.download=`${filenameBase}.${format}`;a.click()
      setTimeout(()=>URL.revokeObjectURL(url),1000)
    }catch(e){message.error((e as Error).message)}
    finally{setExportBusy(false)}
  }
  return <>{filterFields.length>0&&<><div className="record-picker-filters" style={{marginBottom:8}}>{filterFields.map(field=><Select key={field.key} mode="multiple" allowClear showSearch optionFilterProp="label" maxTagCount="responsive" placeholder={field.label} aria-label={field.label} options={field.options} value={filters[field.key]||[]} onChange={ids=>setFilters(current=>({...current,[field.key]:ids}))}/>)}</div>
    {Object.values(filters).some(ids=>ids.length>0)&&<div className="record-picker-tags" style={{marginBottom:8}}>{filterFields.flatMap(field=>(filters[field.key]||[]).map(id=><Tag key={field.key+id} closable onClose={()=>setFilters(current=>({...current,[field.key]:current[field.key].filter(v=>v!==id)}))}>{field.label}：{field.options.find(o=>o.value===id)?.label||id}</Tag>))}<Button type="link" size="small" onClick={()=>setFilters({})}>重置过滤器</Button></div>}</>}
    {(toolbar||query===undefined||filterFields.length>0||canExport||columnChooser&&choices.length>1)&&<div className="managed-table-toolbar">{query===undefined&&<Space.Compact>{filterFields.length>0&&<Select aria-label="搜索字段" style={{minWidth:120}} value={searchField} onChange={setSearchField} options={[{value:'',label:'全部字段'},...filterFields.map(f=>({value:f.key,label:f.label}))]}/>}<Input.Search className="list-search" placeholder={remote?'搜索当前页':'搜索列表'} aria-label={remote?'搜索当前页':'搜索列表'} allowClear value={text} onChange={e=>setText(e.target.value)}/></Space.Compact>}{query!==undefined&&filterFields.length>0&&<Select aria-label="搜索字段" style={{minWidth:120}} value={searchField} onChange={setSearchField} options={[{value:'',label:'全部字段'},...filterFields.map(f=>({value:f.key,label:f.label}))]}/>}
    {toolbar}{canExport&&<Dropdown trigger={['click']} menu={{items:[{key:'xlsx',label:'导出 Excel (.xlsx)',onClick:()=>void exportTable('xlsx')},{key:'csv',label:'导出 CSV (.csv)',onClick:()=>void exportTable('csv')}]}}><Button icon={<DownloadOutlined/>} loading={exportBusy} disabled={!rows.length}>导出列表</Button></Dropdown>}{columnChooser&&choices.length>1&&<Dropdown trigger={['click']} popupRender={()=><div style={{padding:12,background:'var(--ant-color-bg-elevated,#fff)',boxShadow:'0 4px 18px #0002',borderRadius:6}}><Space direction="vertical">{choices.map(c=><Checkbox key={c.key} checked={!hidden.includes(c.key)} disabled={!hidden.includes(c.key)&&shown.length===1} onChange={event=>setHidden(current=>event.target.checked?current.filter(key=>key!==c.key):[...current,c.key])}>{c.label}</Checkbox>)}</Space></div>}><Button className="managed-table-columns">显示列</Button></Dropdown>}</div>}
    <div ref={wrapRef} className="managed-table-wrap"><AntTable<T> size="small" showSorterTooltip={{title:remote&&!serverSort?'点击对当前页排序':'点击排序'}} {...props} columns={props.columns?shown.map(c=>c.column):undefined} scroll={{x:'max-content',...(autoY!==undefined?{y:autoY}:{}),...props.scroll}} dataSource={rows} rowSelection={props.rowSelection?{preserveSelectedRowKeys:true,...props.rowSelection}:undefined} pagination={pager}
      locale={locale} footer={countInFooter?rows=><>{footer?.(rows)}{countLabel(total)}</>:footer}/></div></>
}
