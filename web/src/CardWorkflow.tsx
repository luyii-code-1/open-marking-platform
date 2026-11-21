import {useEffect,useId,useState} from 'react'
import {Alert,App,Card,Form,Input,Modal,Space,Typography} from 'antd'
import {Button} from './Button'
import {announceChanges,send,useResource,type Row} from './api'
import {ErrorNotice} from './EntityTable'
import {examPath,unassignedGrade} from './examNavigation'

export function CardWorkflow({groupId,onSaved}:{groupId:string;onSaved?:()=>Promise<unknown>}){
  const state=useResource<Row>(`/groups/${groupId}/workflow`,{} as Row)
  const s=state.data.group_id===groupId?state.data:null
  const [busy,setBusy]=useState(false),{message}=App.useApp()
  const [reviewing,setReviewing]=useState(false),[reason,setReason]=useState(''),[reviewError,setReviewError]=useState('')
  const [publication,setPublication]=useState<number|null>(null)
  const reasonId=useId()
  useEffect(()=>{if(!s?.published)setReviewing(false)},[s?.published,groupId])
  async function refresh(){
    announceChanges(['groups','projects','analysis','results','review-projects'])
    await state.reload()
    await onSaved?.()
  }
  async function publish(){
    setBusy(true)
    try{
      await send('/results/publish',{group_id:groupId})
      message.success('成绩已发布')
      await refresh()
    }catch(e){message.error((e as Error).message);await state.reload()}
    finally{setBusy(false)}
  }
  async function reopen(){
    if(!s?.published||!reason.trim()||busy)return
    setBusy(true);setReviewError('')
    try{
      await send(`/groups/${groupId}/reopen`,{reason:reason.trim(),expected_published_at:publication})
      setReviewing(false)
      message.success('已开启成绩复核')
      await refresh()
    }catch(e){setReviewError((e as Error).message)}
    finally{setBusy(false)}
  }
  return <Card title="成绩发布与复核" extra={<Button onClick={state.reload}>刷新</Button>}>
    <ErrorNotice error={state.error} retry={state.reload}/>
    {s&&<Space direction="vertical" size={16}>
      <Space size="middle" wrap>{[['已完成',s.results.completed],['缺考',s.results.absent],['未扫描',s.results.unscanned],['待结分',s.results.pending]].map(([title,n])=><span key={title}>{title} {n}</span>)}</Space>
      {s.results.unscanned>0&&<Typography.Text>未扫描学生将保留空白成绩。</Typography.Text>}
      {!!s.publication_blockers?.length&&!s.published&&<Alert type="warning" showIcon message="发布前还需处理"
        description={<ul style={{margin:0,paddingInlineStart:18}}>{(s.publication_actions??s.publication_blockers.map((issue:string)=>({issue}))).map((a:{issue:string;section?:string;label?:string})=><li key={a.issue}>
          {a.issue} {a.section&&s.project_id&&s.subject_id&&<a href={examPath({projectId:s.project_id,subjectId:s.subject_id,gradeId:s.grade_id||unassignedGrade,groupId,section:a.section})}>{a.label}</a>}
        </li>)}</ul>}/>}
      {s.published?<Space wrap>
        <Typography.Text>成绩已发布</Typography.Text>
        {s.scans_purged?<Typography.Text type="secondary">扫描文件已清理，仅可查询或导出成绩。</Typography.Text>:
          <Button disabled={state.loading||!!state.error} onClick={()=>{setPublication(s.published_at??null);setReason('');setReviewError('');setReviewing(true)}}>发起成绩复核</Button>}
      </Space>:<>
        {s.in_review&&<Typography.Text>成绩复核中。更正完成后，在这里重新发布成绩。</Typography.Text>}
        <Button type="primary" loading={busy} disabled={state.loading||!!state.error||!!s.publication_blockers?.length} onClick={publish}>{s.in_review?'重新发布成绩':'发布成绩'}</Button>
      </>}
    </Space>}
    <Modal title="发起成绩复核" open={reviewing&&!!s?.published} onCancel={()=>!busy&&setReviewing(false)}
      okText="确认发起复核" cancelText="取消" confirmLoading={busy} okButtonProps={{disabled:!reason.trim()||!!state.error||!!s?.scans_purged}} onOk={reopen}>
      <p>确认后，此题卡的成绩将转为未发布，教师暂时无法在成绩分析中查看。更正并核对后，请回到此处重新发布。</p>
      <Form layout="vertical"><Form.Item label="复核原因" htmlFor={reasonId} required>
        <Input.TextArea id={reasonId} autoFocus rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="例如：补扫一份答卷，需要核对该生总分"/>
      </Form.Item></Form>
      {reviewError&&<Alert type="error" showIcon message={reviewError}/>}
    </Modal>
  </Card>
}
