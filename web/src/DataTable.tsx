import {Table as AntTable,type TableProps} from 'antd'

function countLabel(total:number){
  return <span className="table-total">共 {total} 条数据</span>
}

export function Table<T extends object = any>({totalRows,pagination,footer,...props}:TableProps<T>&{totalRows?:number}){
  const options=pagination||{}
  const total=totalRows??options.total??props.dataSource?.length??0
  const countInFooter=pagination===false||total===0||
    (options.hideOnSinglePage&&total<=(options.pageSize??options.defaultPageSize??10))
  const pager=pagination===false?false:{...options,showTotal:countLabel}
  return <AntTable<T> {...props} pagination={pager}
    footer={countInFooter?rows=><>{footer?.(rows)}{countLabel(total)}</>:footer}/>
}
