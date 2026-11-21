import {useState} from 'react'
import {Checkbox,Dropdown,Input,Select,Space,Table as AntTable,Tag,type TableProps} from 'antd'
import {Button} from './Button'
import {filterRecords,textMatches,type FilterField,type FilterValues} from './recordFilters'
import './recordPicker.css'
import {sortableColumns} from './tableSorting'

function countLabel(total:number){
  return <span className="table-total">共 {total} 条数据</span>
}
type Props<T extends object>=TableProps<T>&{totalRows?:number;searchText?:(row:T)=>unknown;query?:string;filterFields?:FilterField<T>[];columnChooser?:boolean;serverSort?:boolean}
export function Table<T extends object = any>({totalRows,pagination,footer,searchText,query,filterFields=[],columnChooser=true,serverSort=false,...props}:Props<T>){
  const [text,setText]=useState(''),[filters,setFilters]=useState<FilterValues>({}),[searchField,setSearchField]=useState(''),[hidden,setHidden]=useState<string[]>([])
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
  const choices=sortableColumns(props.columns||[],serverSort).map((column,index)=>({column,key:String(column.key??`${index}:${'dataIndex' in column?String(column.dataIndex):''}`),label:typeof column.title==='string'?column.title:`第 ${index+1} 列`}))
  const shown=choices.filter(c=>!hidden.includes(c.key))
  return <>{filterFields.length>0&&<><div className="record-picker-filters" style={{marginBottom:8}}>{filterFields.map(field=><Select key={field.key} mode="multiple" allowClear showSearch optionFilterProp="label" maxTagCount="responsive" placeholder={field.label} aria-label={field.label} options={field.options} value={filters[field.key]||[]} onChange={ids=>setFilters(current=>({...current,[field.key]:ids}))}/>)}</div>
    {Object.values(filters).some(ids=>ids.length>0)&&<div className="record-picker-tags" style={{marginBottom:8}}>{filterFields.flatMap(field=>(filters[field.key]||[]).map(id=><Tag key={field.key+id} closable onClose={()=>setFilters(current=>({...current,[field.key]:current[field.key].filter(v=>v!==id)}))}>{field.label}：{field.options.find(o=>o.value===id)?.label||id}</Tag>))}<Button type="link" size="small" onClick={()=>setFilters({})}>重置过滤器</Button></div>}</>}
    {(query===undefined||filterFields.length>0||columnChooser&&choices.length>1)&&<div className="managed-table-toolbar">{query===undefined&&<Space.Compact>{filterFields.length>0&&<Select aria-label="搜索字段" style={{minWidth:120}} value={searchField} onChange={setSearchField} options={[{value:'',label:'全部字段'},...filterFields.map(f=>({value:f.key,label:f.label}))]}/>}<Input.Search className="list-search" placeholder={remote?'搜索当前页':'搜索列表'} aria-label={remote?'搜索当前页':'搜索列表'} allowClear value={text} onChange={e=>setText(e.target.value)}/></Space.Compact>}{query!==undefined&&filterFields.length>0&&<Select aria-label="搜索字段" style={{minWidth:120}} value={searchField} onChange={setSearchField} options={[{value:'',label:'全部字段'},...filterFields.map(f=>({value:f.key,label:f.label}))]}/>}
    {columnChooser&&choices.length>1&&<Dropdown trigger={['click']} popupRender={()=><div style={{padding:12,background:'var(--ant-color-bg-elevated,#fff)',boxShadow:'0 4px 18px #0002',borderRadius:6}}><Space direction="vertical">{choices.map(c=><Checkbox key={c.key} checked={!hidden.includes(c.key)} disabled={!hidden.includes(c.key)&&shown.length===1} onChange={event=>setHidden(current=>event.target.checked?current.filter(key=>key!==c.key):[...current,c.key])}>{c.label}</Checkbox>)}</Space></div>}><Button className="managed-table-columns" size="small">显示列</Button></Dropdown>}</div>}
    <AntTable<T> size="small" showSorterTooltip={{title:remote&&!serverSort?'点击对当前页排序':'点击排序'}} {...props} columns={props.columns?shown.map(c=>c.column):undefined} scroll={{x:'max-content',y:600,...props.scroll}} dataSource={rows} rowSelection={props.rowSelection?{preserveSelectedRowKeys:true,...props.rowSelection}:undefined} pagination={pager}
      locale={locale} footer={countInFooter?rows=><>{footer?.(rows)}{countLabel(total)}</>:footer}/></>
}
