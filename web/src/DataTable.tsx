import {Table as AntTable,type TableProps} from 'antd'

export function Table<T extends object = any>({totalRows,...props}:TableProps<T>&{totalRows?:number}){
  const total=totalRows??(props.pagination&&props.pagination.total!==undefined?props.pagination.total:props.dataSource?.length??0)
  return <AntTable<T> {...props} footer={rows=><>{props.footer?.(rows)}<span className="table-total">共 {total} 条数据</span></>}/>
}
