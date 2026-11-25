import { useEffect, useState } from 'react'
import { Alert, App, Card, Collapse, Form, Input, Modal, Popconfirm, Select, Space, Tag, Typography, Upload } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { describeStatus,request,send,useResource,type Row,type Template } from './api'
import { AssetImage } from './components'
import { ErrorNotice } from './EntityTable'
import { RegionPicker } from './RegionPicker'
import { ObjectiveCorrection } from './ObjectiveCorrection'
import { AlignmentEditor } from './AlignmentEditor'
import { HierarchyPicker } from './HierarchyPicker'
import { readLocation,examPath,unassignedGrade } from './examNavigation'

export function Corrections({groupId,selectedGroup:externalGroup,onGroupChange,selectedBatch:externalBatch,onBatchChange,onOpenCapture}:{groupId?:string;selectedGroup?:string;onGroupChange?:(id:string)=>void;selectedBatch?:string;onBatchChange?:(id:string)=>void;onOpenCapture?:(batchId:string)=>void}) {
  const groups=useResource<Row[]>('/groups',[]),batches=useResource<Row[]>('/scan-batches',[]),templates=useResource<Template[]>('/templates',[]),students=useResource<Row[]>('/students',[])
  const [localGroup,setLocalGroup]=useState(groupId||externalGroup||''),group=groupId||(externalGroup??localGroup),[localBatch,setLocalBatch]=useState(externalBatch||''),batch=externalBatch??localBatch,[page,setPage]=useState<Row|null>(null),[submission,setSubmission]=useState<Row|null>(null),[reason,setReason]=useState(''),[candidate,setCandidate]=useState(''),[sequence,setSequence]=useState(1),[excluded,setExcluded]=useState(false),[absentMark,setAbsentMark]=useState(false),[replacementBack,setReplacementBack]=useState(''),[question,setQuestion]=useState(''),[regions,setRegions]=useState('[]'),[asset,setAsset]=useState(''),[replacement,setReplacement]=useState(''),[face,setFace]=useState('1'),[busy,setBusy]=useState(false)
  const card=groups.data.find(g=>g.id===group),frozen=!!card?.frozen,anonymous=!!card?.statistics_group
  const pages=useResource<Row[]>(batch?`/scan-batches/${batch}/pages`:null,[]),submissions=useResource<Row[]>(group&&!anonymous?`/submissions?group_id=${group}`:null,[]),{message}=App.useApp()
  const subjects=useResource<Row[]>(card?'/subjects':null,[])
  const subject=subjects.data.find(s=>s.id===card?.subject_id)
  const groupBatches=batches.data.filter(b=>b.group_id===group)
  const [markSelections,setMarkSelections]=useState<Record<string,string[]>>({})
  const markTemplate=templates.data.find(t=>t.id===groupBatches.find(b=>b.id===page?.batch_id)?.template_id)
  const pendingMarks=page?.external_mark_review as {questions:string[];absent:boolean}|undefined
  const editableQuestions=anonymous&&page?.status==='recognized'
    ? markTemplate?.questions.filter(q=>q.regions.some(r=>r.page===(page.side==='front'?1:2))).map(q=>q.id)||[]
    : pendingMarks?.questions||[]
  const currentBatch=groupBatches.find(b=>b.id===batch)
  const batchPages=pages.data.filter(p=>p.batch_id===batch)
  function setGroup(id:string){setLocalGroup(id);onGroupChange?.(id)}
  function chooseBatch(id:string){
    setLocalBatch(id)
    onBatchChange?.(id)
    setReplacement('')
    setReplacementBack('')
  }
  const location=readLocation(window.location.hash)
  const target=groupId&&location.groupId===groupId?location.correction:undefined
  const targetBatchId=target?.batchId
  useEffect(()=>{
    if(targetBatchId&&groupBatches.some(b=>b.id===targetBatchId))chooseBatch(targetBatchId)
  },[groupId,targetBatchId,batches.loaded])
  useEffect(()=>{
    if(!group||!batches.loaded)return
    if(batch&&groupBatches.some(b=>b.id===batch))return
    if(targetBatchId&&groupBatches.some(b=>b.id===targetBatchId))return
    const preferred=groupBatches.find(b=>b.status==='frozen')||groupBatches.find(b=>b.status!=='paired')||groupBatches.at(-1)
    if(preferred)chooseBatch(preferred.id)
  },[group,batches.loaded,batches.data,batch])
  const targetPage=target?.pageId?batchPages.find(p=>p.id===target.pageId&&currentBatch?.id===targetBatchId):undefined
  const targetAnswer=target?.submissionId?submissions.data.find(row=>row.id===target.submissionId&&row.group_id===group):undefined
  function openPage(row:Row){setPage(row);setCandidate(row.candidate_number||'');setSequence(row.sequence);setExcluded(!!row.excluded);setAbsentMark(!!row.absent_mark);setMarkSelections({})}
  function openAnswer(row:Row){setSubmission(row);setQuestion('');setAsset('');setRegions('[]');setReplacement('');setReplacementBack('');setFace('1')}
  const studentName=(row?:Row|null)=>{
    if(!row)return ''
    return row.student_snapshot?.name||students.data.find(s=>s.id===row.student_id||s.candidate_number===row.candidate_number)?.name||''
  }
  const submissionTemplate=templates.data.find(t=>t.id===submission?.template_id)
  const batchPicker=<Select aria-label="扫描记录" placeholder="选择扫描记录" style={{width:260}} value={currentBatch?batch:undefined}
    options={groupBatches.map(b=>({label:`${b.room||'未记考场'} · ${describeStatus(b.status)} · ${b.id.slice(0,8)}`,value:b.id}))} onChange={chooseBatch}/>
  async function reloadAll(){await Promise.all([pages.reload(),submissions.reload(),batches.reload(),groups.reload()])}
  async function act(callback:()=>Promise<unknown>) { if(!reason.trim()){message.warning('请填写操作原因');return} setBusy(true);try{await callback();message.success('已保存');await reloadAll()}catch(e){message.error((e as Error).message)}finally{setBusy(false)} }
  async function pairCurrentBatch(){
    if(!batch||busy)return
    setBusy(true)
    try{await send(`/scan-batches/${batch}/pair`);message.success('配对已确认，答卷已入库');await reloadAll()}
    catch(e){message.error((e as Error).message)}
    finally{setBusy(false)}
  }
  const error=groups.error||batches.error||templates.error||students.error||pages.error||submissions.error
  return <Space direction="vertical" size={16} style={{width:'100%'}}>
    <ErrorNotice error={error} retry={reloadAll}/>
    {frozen&&<Alert type="info" showIcon message="当前题卡成绩已发布，扫描纠正与补扫已锁定。如需更正考号、客观题或补扫，请先发起成绩复核。" action={subject&&card&&<Button href={examPath({projectId:subject.project_id,subjectId:subject.id,gradeId:card.grade_id||unassignedGrade,groupId:card.id,section:'results'})}>前往成绩复核</Button>}/>}
    {target&&<Alert type="info" showIcon message="异常关联记录" description={<Space wrap>
      {targetPage&&<Button disabled={frozen} onClick={()=>openPage(targetPage)}>核对扫描页 · {targetPage.candidate_number||'考号未识别'}</Button>}
      {targetAnswer&&<Button disabled={frozen} onClick={()=>openAnswer(targetAnswer)}>核对答卷 · {targetAnswer.candidate_number||'考号未识别'}</Button>}
      {!targetPage&&!targetAnswer&&(pages.loading||submissions.loading||batches.loading?'正在查找关联记录…':'可在下方按扫描记录查看原卷。')}
    </Space>}/>}
    <Card title="扫描纠正与特殊卷" extra={<Space>{onOpenCapture&&currentBatch&&<Button onClick={()=>onOpenCapture(currentBatch.id)}>查看批次详情</Button>}<Button onClick={reloadAll}>刷新</Button></Space>}><Space wrap>{!groupId && <HierarchyPicker value={group} onChange={value=>{setGroup(value);chooseBatch('')}}/>}{batchPicker}<Input placeholder="操作原因（所有纠正均记录）" style={{width:320}} value={reason} onChange={e=>setReason(e.target.value)}/><Button disabled={!currentBatch||frozen||currentBatch.status==='paired'} loading={busy} onClick={()=>act(()=>send(`/scan-batches/${batch}/resume`,{reason}))}>恢复该批次扫描</Button>{currentBatch&&currentBatch.status!=='paired'&&currentBatch.status!=='frozen'&&batchPages.length>0&&!frozen&&<Popconfirm title="确认本批次页面数量与正反面顺序正确？" description={anonymous?'确认后的每张完整题卡计为一份。':'按本批次题卡和考场配对并关联考生入库。'} onConfirm={pairCurrentBatch}><Button type="primary" loading={busy}>确认配对并入库</Button></Popconfirm>}{!groupId&&frozen&&subject&&card&&<Button href={examPath({projectId:subject.project_id,subjectId:subject.id,gradeId:card.grade_id||unassignedGrade,groupId:card.id,section:'results'})}>前往成绩复核</Button>}{card?.scan_close&&!card.frozen&&<Button disabled={busy} onClick={()=>act(async()=>{await send(`/groups/${group}/reopen`,{reason,scan_only:true});await groups.reload()})}>重新开放扫描</Button>}</Space></Card>
    {currentBatch&&<Card title={`采集页面 · ${currentBatch.room||'未记考场'}（${describeStatus(currentBatch.status)}）`}><Table rowKey="id" dataSource={batchPages} loading={pages.loading} columns={[{title:'面',dataIndex:'side',render:v=>v==='back'?'背面':'正面'},{title:'序号',dataIndex:'sequence'},...(!anonymous?[{title:'考号',dataIndex:'candidate_number',render:(v:string)=>v||'未识别'},{title:'姓名',render:(_:unknown,row:Row)=>studentName(row)||'—'}]:[]),{title:'状态',dataIndex:'status',render:v=><Tag color={['error','exception','quarantined'].includes(v)?'orange':v==='recognized'?'green':undefined}>{describeStatus(v)}</Tag>},{title:'已排除',dataIndex:'excluded',render:value=>value?'是':'否'},{title:'操作',render:(_,row)=><Button disabled={frozen} onClick={()=>openPage(row)}>核对并纠正</Button>}]}/></Card>}
    {group&&!anonymous&&<Card title="答卷与补扫"><Table rowKey="id" dataSource={submissions.data} loading={submissions.loading} searchText={row=>studentName(row)} columns={[{title:'考号',dataIndex:'candidate_number'},{title:'姓名',render:(_,row)=>studentName(row)||'—'},{title:'状态',dataIndex:'status',render:v=><Tag color={v==='absent'?'orange':'green'}>{v==='absent'?'缺考':'实考'}</Tag>},{title:'操作',render:(_,row)=><Space wrap><Button disabled={frozen} onClick={()=>openAnswer(row)}>补扫 / 特殊卷</Button><Popconfirm title={row.status==='absent'?'将此卷更正为实考？':'确认将此卷标为缺考？'} description={<><p>出勤变化会使旧评分失效，原始记录保留。</p><label>更正原因<Input.TextArea rows={2} value={reason} onChange={e=>setReason(e.target.value)}/></label></>} okButtonProps={{disabled:!reason.trim()||busy||frozen}} onConfirm={()=>act(()=>send(`/submissions/${row.id}/attendance`,{absent:row.status!=='absent',reason},'PUT'))}><Button disabled={frozen}>{row.status==='absent'?'更正为实考':'更正为缺考'}</Button></Popconfirm></Space>}]}/></Card>}
    <Modal title="核对页面" open={!!page} onCancel={()=>setPage(null)} confirmLoading={busy}
      okButtonProps={{disabled:!reason.trim()||frozen||(!excluded&&pendingMarks?.questions.some(id=>!(id in markSelections)))}}
      onOk={()=>act(async()=>{
        await send(`/pages/${page!.id}`,{candidate_number:excluded||anonymous?undefined:candidate||undefined,sequence,excluded,reason,
          ...(page!.side==='front'&&!anonymous?{absent_mark:absentMark}:{}),
          ...(Object.keys(markSelections).length&&!excluded?{selections:markSelections}:{})},'PUT')
        setPage(null)
      })}>
      <AssetImage src={page?.image_url||''}/>
      <Collapse items={[{key:'alignment',label:'人工四点定位恢复',children:page&&
        <AlignmentEditor key={page.id} pageId={page.id} initialReason={reason} onSaved={async updated=>{
          openPage(updated);setReason(updated.alignment_reason||reason);await pages.reload();await batches.reload()
        }}/>}]}/>
      <Form layout="vertical">
        <Form.Item label="更正原因" required htmlFor="scan-page-reason"><Input.TextArea id="scan-page-reason" rows={2} value={reason} onChange={e=>setReason(e.target.value)}/></Form.Item>
        {page?.side==='front'&&!anonymous&&<Form.Item label="准考证号"><Input value={candidate} onChange={e=>setCandidate(e.target.value)}/></Form.Item>}
        <Form.Item label="采集序号"><Input type="number" min={1} value={sequence} onChange={e=>setSequence(Number(e.target.value))}/></Form.Item>
        {page?.side==='front'&&!anonymous&&<Form.Item label={pendingMarks?.absent?'核对缺考填涂':'缺考填涂识读'}><Select value={absentMark} onChange={setAbsentMark} options={[{label:'未标缺考',value:false},{label:'缺考（监考填涂）',value:true}]}/></Form.Item>}
        {editableQuestions.map(id=>{
          const q=markTemplate?.questions.find(item=>item.id===id)
          if(!q)return null
          return <Form.Item key={id} label={`核对第 ${q.number} 题`}>
            <Space wrap>
              <Select mode="multiple" aria-label={`第 ${q.number} 题识读选项`} placeholder="按原图选择"
                style={{minWidth:180}} value={markSelections[id] ?? (anonymous?page?.selections?.[id]:undefined)}
                options={Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0,q.options),value=>({label:value,value}))}
                onChange={choices=>setMarkSelections(previous=>({...previous,[id]:choices}))}/>
              <Button onClick={()=>setMarkSelections(previous=>({...previous,[id]:[]}))}>确认空白</Button>
              {markSelections[id]?.length===0&&<Tag>空白</Tag>}
            </Space>
          </Form.Item>
        })}
        <Form.Item label="页面处置"><Select value={excluded} onChange={setExcluded} options={[{label:'保留用于配对',value:false},{label:'排除本页，保留原图证据',value:true}]}/></Form.Item>
      </Form>
    </Modal>
    <Modal width={760} title={`补扫与答题区域更正${submission?` · ${[studentName(submission),submission.candidate_number].filter(Boolean).join('（')}${studentName(submission)?'）':''}`:''}`} open={!!submission} onCancel={()=>setSubmission(null)} footer={<Button onClick={()=>setSubmission(null)}>关闭</Button>}><Space direction="vertical" style={{width:'100%'}}><Input.TextArea rows={2} value={reason} onChange={e=>setReason(e.target.value)} aria-label="补扫与更正原因" placeholder="填写补扫与更正原因"/><Space wrap>补扫页来源 {batchPicker}{!currentBatch&&<Typography.Text type="secondary">请先选择包含补扫页面的扫描记录</Typography.Text>}</Space>{submission?.status==='absent'&&!submission.pages.length&&<Card size="small" title="误记缺考：补齐整卷并恢复实考"><Space wrap><Select style={{width:260}} placeholder="补扫正面" value={replacement||undefined} onChange={setReplacement} options={batchPages.filter(p=>p.status==='recognized'&&!p.excluded&&p.side==='front').map(p=>({label:`正面 · 序号 ${p.sequence}${p.candidate_number?' · 考号 '+p.candidate_number:''}`,value:p.id}))}/>{submissionTemplate?.sides===2&&<Select style={{width:260}} placeholder="补扫背面" value={replacementBack||undefined} onChange={setReplacementBack} options={batchPages.filter(p=>p.status==='recognized'&&!p.excluded&&p.side==='back').map(p=>({label:`背面 · 序号 ${p.sequence}`,value:p.id}))}/>}<Button disabled={!replacement||(submissionTemplate?.sides===2&&!replacementBack)} loading={busy} onClick={()=>act(async()=>{const updated=await send<Row>(`/submissions/${submission.id}/attach-pages`,{page_ids:[replacement,...(submissionTemplate?.sides===2?[replacementBack]:[])],reason});setSubmission(updated)})}>补齐整卷并恢复实考</Button></Space></Card>}{submission&&submission.status==='ready'&&<ObjectiveCorrection key={submission.id} submissionId={submission.id} reason={reason} onSaved={submissions.reload}/>}{!!submission?.pages.length&&<Space wrap><Select value={face} onChange={value=>{setFace(value);setReplacement('')}} options={[{label:'替换正面',value:'1'},...(submissionTemplate?.sides===2||submission.pages.length>1?[{label:'替换背面',value:'2'}]:[])]}/><Select placeholder="从所选批次选择补扫页" style={{width:320}} value={replacement||undefined} onChange={setReplacement} options={batchPages.filter(p=>p.status==='recognized'&&!p.excluded&&p.side===(face==='1'?'front':'back')).map(p=>({label:`${p.side==='front'?'正面':'背面'} · 序号 ${p.sequence}${p.candidate_number?' · 考号 '+p.candidate_number:''}`,value:p.id}))}/><Button disabled={!replacement} loading={busy} onClick={()=>act(async()=>{const updated=await send<Row>(`/submissions/${submission!.id}/replace-page`,{page:Number(face),page_id:replacement,reason});setSubmission(updated);setReplacement('')})}>确认替换</Button></Space>}<Select placeholder="选择需重新评阅的主观题" style={{width:'100%'}} value={question||undefined} onChange={qid=>{setQuestion(qid);const q=submissionTemplate?.questions.find(item=>item.id===qid);const targetPage=q?.regions?.[0]?.page;if(targetPage)setFace(String(targetPage));const existing=submission?.region_overrides?.[qid]?.regions;setRegions(JSON.stringify(existing||[]))}} options={submissionTemplate?.questions.filter(q=>q.type==='subjective').map(q=>({label:`第${q.number}题`,value:q.id}))}/>{question&&submission?.pages[Number(face)-1]&&<RegionPicker src={`/api/v1/pages/${submission.pages[Number(face)-1]}/image`} width={submissionTemplate?.paper==='A3'?420:210} page={Number(face)} regions={JSON.parse(regions)} onChange={value=>{setRegions(JSON.stringify(value));setAsset('')}}/>}<Upload accept="image/*" showUploadList={false} beforeUpload={async file=>{const data=new FormData();data.append('file',file);try{const value=await request<Row>('/assets',{method:'POST',body:data});setAsset(value.id);message.success('特殊卷图片已上传')}catch(e){message.error((e as Error).message)}return false}}><Button>上传彩色作答图片</Button></Upload><Button type="primary" disabled={!question} loading={busy} onClick={()=>act(async()=>{const updated=await send<Row>(`/submissions/${submission!.id}/regions/${question}`,{reason,...(asset?{asset_id:asset}:{regions:JSON.parse(regions)})},'PUT');setSubmission(updated)})}>保存区域 / 图片并重新派发</Button></Space></Modal>
  </Space>
}
