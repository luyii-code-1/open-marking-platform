import {useState} from 'react'
import {Space,Tag,type TableColumnsType} from 'antd'
import {Button} from './Button'
import {RecordPicker,type FilterField} from './RecordPicker'
import {request,type Row} from './api'

type Options={title:string;records:Row[];columns?:TableColumnsType<Row>;fields?:FilterField<Row>[];label?:(row:Row)=>string;disabled?:boolean;kind?:'users'|'students'|'classes'|'grades'|'subject-tags'}
function RecordSelection({title,records,columns,fields,label,disabled,kind,ids,onChange,multiple}:Options&{ids:string[];onChange:(ids:string[])=>void;multiple:boolean}){
  const [open,setOpen]=useState(false),name=(row:Row)=>label?.(row)||row.name
  return <><Space wrap><Button disabled={disabled} onClick={()=>setOpen(true)}>选择{title}{multiple?`（${ids.length}）`:''}</Button>{ids.map(id=><Tag key={id} closable={!disabled} onClose={()=>onChange(ids.filter(v=>v!==id))}>{records.find(row=>row.id===id)?name(records.find(row=>row.id===id)!):id}</Tag>)}</Space>
    <RecordPicker<Row> open={open} onClose={()=>setOpen(false)} title={`选择${title}`} records={records} columns={columns||[{title:'名称',dataIndex:'name'}]} fields={fields} value={ids} onChange={onChange} label={name} multiple={multiple}
      importer={kind?{templateUrl:`/selection/${kind}/template`,templateName:`${title}选择模板.xlsx`,upload:async file=>{const body=new FormData();body.append('file',file);return (await request<{ids:string[]}>(`/selection/${kind}/match`,{method:'POST',body})).ids}}:undefined}/></>
}
export function RecordSelect({value,onChange,...props}:Options&{value?:string;onChange?:(id:string)=>void}){
  return <RecordSelection {...props} ids={value?[value]:[]} onChange={ids=>onChange?.(ids[0]||'')} multiple={false}/>
}
export function MultipleRecordSelect({value=[],onChange,...props}:Options&{value?:string[];onChange?:(ids:string[])=>void}){
  return <RecordSelection {...props} ids={value} onChange={ids=>onChange?.(ids)} multiple/>
}
