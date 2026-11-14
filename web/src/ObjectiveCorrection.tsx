import { useEffect, useState } from 'react'
import { Alert, App, Collapse, Select} from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { send, useResource, type Row } from './api'

export function ObjectiveCorrection({submissionId,reason,onSaved}:{submissionId:string;reason:string;onSaved:()=>Promise<void>}) {
  const answers=useResource<Row[]>(`/submissions/${submissionId}/objective`,[]),[draft,setDraft]=useState<Record<string,string[]>>({}),[busy,setBusy]=useState(false),{message}=App.useApp()
  useEffect(()=>setDraft(Object.fromEntries(answers.data.map(q=>[q.id,q.selected]))),[answers.data])
  async function save() {
    if(!reason.trim()){message.warning('请填写操作原因');return}
    const changes=Object.fromEntries(answers.data.filter(q=>JSON.stringify([...(draft[q.id]||[])].sort())!==JSON.stringify([...q.selected].sort())).map(q=>[q.id,draft[q.id]||[]]))
    if(!Object.keys(changes).length){message.info('没有需要保存的选项更正');return}
    setBusy(true)
    try{await send(`/submissions/${submissionId}/objective`,{reason,selections:changes},'PUT');await answers.reload();await onSaved();message.success('选项已更正，分数与异常检查已更新')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}
  }
  return <Collapse items={[{key:'objective',label:'核对与更正客观题识读',children:<>{answers.error&&<Alert type="error" message={answers.error}/>}<Table rowKey="id" dataSource={answers.data} loading={answers.loading} pagination={{defaultPageSize:50}} columns={[{title:'题号',dataIndex:'number'},{title:'原始识读',dataIndex:'original',render:(value:string[])=>value.join('、')||'空白'},{title:'核对选项',render:(_,q)=><Select mode="multiple" allowClear style={{minWidth:180}} value={draft[q.id]||[]} options={'ABCDE'.slice(0,q.options).split('').map(value=>({value,label:value}))} onChange={value=>setDraft(old=>({...old,[q.id]:value}))}/>}]} /><Button type="primary" loading={busy} onClick={save}>保存选项更正</Button></>}]} />
}
