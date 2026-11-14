import {App,Popconfirm} from 'antd'
import {useState} from 'react'
import {Button} from './Button'
import {send,type Row} from './api'

export function DeleteRecord({kind,row,reload}:{kind:string;row:Row;reload:()=>Promise<unknown>}){
  const [busy,setBusy]=useState(false),{message}=App.useApp()
  async function remove(){
    setBusy(true)
    try{
      await send('/records/'+kind+'/'+encodeURIComponent(row.id),undefined,'DELETE')
      await reload()
      message.success('已删除')
    }catch(error){message.error((error as Error).message)}
    finally{setBusy(false)}
  }
  return <Popconfirm title={'删除「'+row.name+'」？'} okText="删除" cancelText="取消" onConfirm={remove}><Button danger type="link" loading={busy}>删除</Button></Popconfirm>
}
