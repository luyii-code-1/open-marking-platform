import {useState} from 'react'
import {Alert,App,Card,Space,Statistic,Typography} from 'antd'
import {Button} from './Button'
import {send,useResource,type Row} from './api'
import {ErrorNotice} from './EntityTable'

export function CardWorkflow({groupId,onSaved}:{groupId:string;onSaved?:()=>Promise<unknown>}){
  const state=useResource<Row>(`/groups/${groupId}/workflow`,{} as Row)
  const s=state.data.group_id===groupId?state.data:null
  const [busy,setBusy]=useState(false),{message}=App.useApp()
  async function publish(){
    setBusy(true)
    try{
      await send('/results/publish',{group_id:groupId})
      message.success('成绩已发布')
      await state.reload()
      await onSaved?.()
    }catch(e){message.error((e as Error).message);await state.reload()}
    finally{setBusy(false)}
  }
  return <Card title="成绩发布" extra={<Button onClick={state.reload}>刷新</Button>}>
    <ErrorNotice error={state.error} retry={state.reload}/>
    {s&&<Space direction="vertical" size={16}>
      <Space size={24} wrap>{[['已完成',s.results.completed],['缺考',s.results.absent],['未扫描',s.results.unscanned],['待结分',s.results.pending]].map(([title,n])=><Statistic key={title} title={title} value={n}/>)}</Space>
      {s.results.unscanned>0&&<Typography.Text>未扫描学生将保留空白成绩。</Typography.Text>}
      {!!s.publication_blockers?.length&&!s.published&&<Alert type="warning" message={s.publication_blockers.join('；')}/>}
      <Button type="primary" loading={busy} disabled={state.loading||!!state.error||s.published||!!s.publication_blockers?.length} onClick={publish}>{s.published?'成绩已发布':'发布成绩'}</Button>
    </Space>}
  </Card>
}
