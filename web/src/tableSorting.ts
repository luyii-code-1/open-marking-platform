const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'})

function displayValue(value:any):any{
  if(value===null||value===undefined||typeof value==='boolean')return null
  if(typeof value==='string'||typeof value==='number')return value
  if(Array.isArray(value))return value.map(displayValue).filter(v=>v!==null).join('、')
  if(value instanceof Date)return value.getTime()
  if(value.props){
    const props=value.props
    if(props.value!==undefined)return displayValue(props.value)
    if(props.children!==undefined)return displayValue(props.children)
    if(props.tags)return displayValue(props.tags.map((tag:any)=>tag.label||tag.name))
  }
  return null
}

export function compareCells(a:any,b:any,order?:string){
  const left=displayValue(a),right=displayValue(b)
  const empty=(v:any)=>v===null||v===''
  if(empty(left)||empty(right))return (empty(left)?empty(right)?0:1:-1)*(order==='descend'?-1:1)
  return typeof left==='number'&&typeof right==='number'?left-right:collator.compare(String(left),String(right))
}

export function sortableColumns(columns:any[],server=false):any[]{
  return columns.map(column=>{
    if(column.children)return {...column,children:sortableColumns(column.children,server)}
    if(column.sorter!==undefined||!column.title||/操作|动作/.test(String(column.title))||String(column.className||'').split(' ').includes('row-actions'))return column
    const path=column.dataIndex===undefined?undefined:Array.isArray(column.dataIndex)?column.dataIndex:[column.dataIndex]
    const value=(row:any)=>path?path.reduce((item:any,key:any)=>item?.[key],row):column.render?.(undefined,row,0)
    return {...column,key:column.key??(path?path.join('.'):`sort:${String(column.title)}`),sorter:server?true:(a:any,b:any,order?:string)=>compareCells(value(a),value(b),order)}
  })
}
