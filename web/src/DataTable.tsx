import {useState} from 'react'
import {Input,Table as AntTable,type TableProps} from 'antd'

function countLabel(total:number){
  return <span className="table-total">共 {total} 条数据</span>
}
function matches(value:unknown,term:string):boolean {
  if(value==null)return false
  if(typeof value==='object')return Object.values(value).some(v=>matches(v,term))
  return String(value).toLocaleLowerCase().includes(term)
}

type Props<T extends object>=TableProps<T>&{totalRows?:number;searchText?:(row:T)=>unknown; query?:string}
export function Table<T extends object = any>({totalRows,pagination,footer,searchText,query,...props}:Props<T>){
  const [text,setText]=useState('')
  const options=pagination||{}
  const term=(query??text).trim().toLocaleLowerCase()
  const rows=term?props.dataSource?.filter(row=>matches(row,term)||matches(searchText?.(row),term)):props.dataSource
  const total=term?rows?.length??0:totalRows??options.total??rows?.length??0
  const countInFooter=pagination===false||total===0||
    (options.hideOnSinglePage&&total<=(options.pageSize??options.defaultPageSize??50))
  const pager=pagination===false?false:{defaultPageSize:50,...options,...(term?{total,...(options.total!==undefined?{current:1}:{})}:{}),showTotal:countLabel}
  const remote=totalRows!==undefined||options.total!==undefined
  return <>{query===undefined&&<Input.Search className="list-search" placeholder={remote?'搜索当前页':'搜索列表'} aria-label={remote?'搜索当前页':'搜索列表'} allowClear value={text} onChange={e=>setText(e.target.value)}/>}
    <AntTable<T> {...props} dataSource={rows} rowSelection={props.rowSelection?{preserveSelectedRowKeys:true,...props.rowSelection}:undefined} pagination={pager}
      footer={countInFooter?rows=><>{footer?.(rows)}{countLabel(total)}</>:footer}/></>
}
