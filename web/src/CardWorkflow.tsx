import {useState} from 'react'
import {Alert,App,Card,Checkbox,Input,Modal,Space,Statistic,Table,Typography} from 'antd'
import {Button} from './Button'
import {send,useResource,type Row} from './api'
import {ErrorNotice} from './EntityTable'

export function CardWorkflow({groupId,publication=false,onSaved}:{groupId:string;publication?:boolean;onSaved?:()=>Promise<unknown>}){
  const state=useResource<Row>(`/groups/${groupId}/workflow`,{} as Row),s=state.data.group_id===groupId?state.data:{} as Row
  const [open,setOpen]=useState(false),[confirmed,setConfirmed]=useState(false),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),{message}=App.useApp()
  const blockers=[!s.template_id?'尚未发布版式':'',s.roster_configured&&s.roster_needs_review?'应考名单待核对':'',s.open_batches?`${s.open_batches} 个批次未完成`:'',s.open_exceptions?`${s.open_exceptions} 项异常待处理`:'',publication&&s.roster_configured&&!s.scan_closed?'扫描待收尾核对':'',publication&&(s.results?.pending||s.regrades)?'评分或重阅未完成':''].filter(Boolean)
  async function apply(){setBusy(true);try{
    if(publication)await send('/results/publish',{group_id:groupId,force_unscanned:!!s.results?.unscanned,reason})
    else await send(`/groups/${groupId}/scan-close`,{confirm:true,signature:s.scan_signature})
    setOpen(false);await state.reload();await onSaved?.();message.success(publication?'成绩已发布':'扫描收尾核对已记录')
  }catch(e){message.error((e as Error).message);await state.reload()}finally{setBusy(false)}}
  return <Card title={publication?'成绩发布检查':'扫描收尾'} extra={<Button onClick={state.reload}>刷新检查</Button>}>
    <ErrorNotice error={state.error} retry={state.reload}/>
    <Space direction="vertical" size={20} style={{width:'100%'}}>
      <Space size={32} wrap><Statistic title="应考名单" value={s.roster_count??'—'}/><Statistic title="考场预期" value={s.room_expected??'—'}/><Statistic title="实考已入库" value={s.scanned??'—'}/><Statistic title="缺考" value={s.results?.absent??'—'}/><Statistic title="未扫描" value={s.results?.unscanned??'—'}/>{publication&&<Statistic title="待结分" value={s.results?.pending??'—'}/>}</Space>
      {blockers.length>0&&<Alert type="warning" message="待处理事项" description={<ul>{blockers.map(b=><li key={b}>{b}</li>)}</ul>}/>}
      {!publication&&<Table rowKey="id" dataSource={s.rooms||[]} size="small" pagination={false} columns={[{title:'考场',dataIndex:'name'},{title:'预期',dataIndex:'expected_students'},{title:'实考',dataIndex:'scanned_students'},{title:'缺考',dataIndex:'confirmed_absent'},{title:'待核对人数',dataIndex:'remaining_students'},{title:'超出预期',dataIndex:'over_expected'}]}/>}
      <Typography.Text type="secondary">缺考按题卡缺考标记识别；无答卷者保留“未扫描”。考场预期人数与应考名单分别核对。</Typography.Text>
      <Button type="primary" disabled={busy||state.loading||!!state.error||!s.group_id||!!s.published||!!blockers.length||(!publication&&(!s.roster_configured||s.scan_closed))} onClick={()=>{setConfirmed(false);setReason('');setOpen(true)}}>{publication?s.published?'成绩已发布':'检查并发布':s.scan_closed?'已完成收尾核对':'确认扫描收尾'}</Button>
    </Space>
    <Modal title={publication?'确认发布成绩':'确认扫描收尾'} open={open} onCancel={()=>!busy&&setOpen(false)} onOk={apply} confirmLoading={busy} okButtonProps={{disabled:!confirmed||!!blockers.length||publication&&!!s.results?.unscanned&&!reason.trim()}}>
      <Typography.Paragraph>{publication?`已完成 ${s.results?.completed||0} 人，缺考 ${s.results?.absent||0} 人，未扫描 ${s.results?.unscanned||0} 人。未扫描记录保留空白成绩。`:'请核对所有考场，确认设备采集结束、本地队列全部上传、页面已配对入库。服务器接收页数不能代表本机尚未上传的页面数量。'}</Typography.Paragraph>
      {publication&&!!s.results?.unscanned&&<Input.TextArea value={reason} onChange={e=>setReason(e.target.value)} placeholder="填写保留未扫描记录并发布的原因" rows={3}/>}
      <Checkbox checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>{publication?'已核对成绩和未扫描记录':'已核对应考名单、全部考场与本地上传队列'}</Checkbox>
    </Modal>
  </Card>
}
