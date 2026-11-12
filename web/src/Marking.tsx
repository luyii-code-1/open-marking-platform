import { ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { useAction } from './useAction'
import { useEffect, useRef, useState } from 'react'
import { Alert, App, Card, Checkbox, Empty, Form, Input, InputNumber, Modal, Progress, Select, Space, Table, Tag, Typography } from 'antd'
import { useReviewWorkspace } from './ReviewWorkspace'
import { cacheReview, enqueueReview, forgetReview, saveReviewDraft, settleReviewWrites, type ReviewRecord } from './reviewStore'
import { useUnsavedChanges } from './useNavigation'
import { request, requestBlob, send, useResource, watchChanges, type Row, type Template } from './api'
import { ErrorNotice } from './Management'

export function Marking({ admin, groupId }: { admin: boolean; groupId?: string }) {
  const workspace=useReviewWorkspace()
  const action=useAction(),busy=action.busy
  const templateResource = useResource<Template[]>('/templates', []), templates = {...templateResource, data: [...new Map([...workspace.records.map(r=>({...r.template,questions:[r.question]} as Template)),...templateResource.data].map(t=>[t.id,t])).values()].filter(t => !groupId || t.group_id === groupId)}, groups=useResource<Row[]>('/groups',[]), subjects=useResource<Row[]>('/subjects',[]), projects=useResource<Row[]>('/projects',[]), assignments = useResource<Row[]>('/assignments', []), users = useResource<Row[]>(admin ? '/users' : null, [])
  const [templateId, setTemplateId] = useState(''), [questionId, setQuestionId] = useState(''), [task, setTask] = useState<Row | null>(null), [history, setHistory] = useState<Row[]>([])
  const [value, setValue] = useState<number | null>(null), [step, setStep] = useState(.5), [error, setError] = useState(''), [skipWarn, setSkipWarn] = useState(false), [automatic, setAutomatic] = useState(true), [osd, setOsd] = useState(''), [zoom, setZoom] = useState(1), [contrast, setContrast] = useState(1), [assignOpen, setAssignOpen] = useState(false), [assignForm] = Form.useForm()
  const started = useRef(Date.now()), [count, setCount] = useState(0), [seconds, setSeconds] = useState(0), { message } = App.useApp()
  const historyVersion=useRef(0),historyContext=useRef('');historyContext.current=`${templateId}:${questionId}`
  const selectedTeachers: string[]=Form.useWatch('user_ids',assignForm)||[]
  const arbitrationMode=Form.useWatch('arbitration_mode',assignForm)||'random'
  const progress=useResource<Row>(templateId&&questionId?`/review-progress?template_id=${templateId}&question_id=${questionId}`:null,{} as Row)
  useEffect(() => { if(groupId && !templateId) { const published=templates.data.find(t=>t.id===groups.data.find(g=>g.id===groupId)?.template_id); if(published)setTemplateId(published.id) } },[groupId,templateId,templateResource.data,groups.data])
  const record=workspace.records.find(r=>r.task.id===task?.id)
  const template = templates.data.find(t => t.id === templateId), question = record?.question||template?.questions.find(q => q.id === questionId)
  const [imageUrl,setImageUrl]=useState(''),[saveState,setSaveState]=useState(''),saveVersion=useRef(0),restored=useRef(false),submitted=useRef<string|null>(null)
  const locked=busy||workspace.updateLocked||!!workspace.storageError
  const editable=record?.status==='draft'&&!locked
  useUnsavedChanges(saveState==='正在保存本地草稿'||saveState==='本地保存失败')
  function showRecord(row:ReviewRecord){setTemplateId(row.template.id);setQuestionId(row.question.id);setTask(row.task);setValue(row.draft);setSaveState('本地草稿已保存');setSkipWarn(false);setPan({x:0,y:0})}
  useEffect(()=>{if(!workspace.ready||restored.current)return;restored.current=true;const row=workspace.records.find(r=>r.status!=='confirmed'&&(!groupId||r.template.group_id===groupId));if(row)showRecord(row)},[workspace.ready,workspace.records,groupId])
  useEffect(()=>{if(!record?.image){setImageUrl('');return}const url=URL.createObjectURL(record.image);setImageUrl(url);return()=>URL.revokeObjectURL(url)},[task?.id,record?.image.size,record?.image.type])
  const [pan, setPan] = useState({ x: 0, y: 0 }), drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  useEffect(() => { historyVersion.current++;setHistory([]);setError('') }, [templateId, questionId])
  useEffect(() => { if (!osd) return; const timer = setTimeout(() => setOsd(''), 1000); return () => clearTimeout(timer) }, [osd])
  async function openTask(row:Row) {
    if(!template)return
    const selected=template.questions.find(q=>q.id===row.question_id)
    if(!selected)throw new Error('题目配置不可用')
    const image=await requestBlob(`/tasks/${row.id}/image`,{signal:AbortSignal.timeout(15000)})
    const saved=await cacheReview(workspace.user.id,row,{id:template.id,name:template.name,group_id:template.group_id,revision:template.revision},selected,image)
    showRecord(saved)
  }
  async function next() {
    if(!templateId||!questionId||workspace.offline||workspace.updateLocked)return
    if(record&&['queued','conflict'].includes(record.status)){setError('请先等待这份评分上传或核对本地记录');return}
    await action.run('claim',async()=>{setError('')
    try{await settleReviewWrites();const row=await send<Row|null>('/tasks/claim',{template_id:templateId,question_id:questionId});if(row)await openTask(row);else{setTask(null);setValue(null);message.info('当前没有可领取的作答')}}catch(e){setError((e as Error).message)}})
  }
  function editScore(score:number|null) {
    if(!task||!editable)return
    setValue(score);setSkipWarn(false);setSaveState('正在保存本地草稿')
    const version=++saveVersion.current
    void saveReviewDraft(workspace.user.id,task.id,score).then(()=>{if(version===saveVersion.current)setSaveState('本地草稿已保存')}).catch(e=>{if(version===saveVersion.current){setSaveState('本地保存失败');setError((e as Error).message)}})
  }
  async function submit() {
    if(!task||locked||record?.status!=='draft')return
    if(value===null){setSkipWarn(true);return}
    await action.run('score',async()=>{setError('')
    try{await settleReviewWrites();submitted.current=task.id;await enqueueReview(workspace.user.id,task.id,value);setSaveState('本地已保存，等待服务器确认');setOsd('本地已保存 · 待上传');void workspace.sync()}catch(e){submitted.current=null;setError((e as Error).message)}})
  }
  useEffect(()=>{
    if(!record||record.status!=='confirmed'||busy)return
    if(task?.status!=='completed'||task.score_revision!==record.task.score_revision){setTask(record.task);setValue(record.task.score)}
    if(submitted.current!==record.task.id)return
    submitted.current=null;setOsd(`服务器已确认：${record.task.score} 分`);setCount(n=>n+1);setSeconds((Date.now()-started.current)/1000)
    if(automatic&&!workspace.offline&&!workspace.updateLocked)void next()
  },[record?.status,record?.task.score_revision,busy,workspace.offline,workspace.updateLocked])
  async function skip() {
    if(!task||locked||workspace.offline||record?.status!=='draft')return
    if(value===null&&!skipWarn){setSkipWarn(true);return}
    if(value!==null&&!window.confirm('当前分数尚未提交，确认跳过这份作答？'))return
    await action.run('skip',async()=>{try{await settleReviewWrites();if(task.status==='claimed'||task.regrading)await send(`/tasks/${task.id}/skip`);await forgetReview(workspace.user.id,task.id);const row=await send<Row|null>('/tasks/claim',{template_id:templateId,question_id:questionId});if(row)await openTask(row);else{setTask(null);setValue(null)}}catch(e){setError((e as Error).message)}})
  }
  function regradeFrom(row:Row) {
    let reason=''
    Modal.confirm({title:'从这份评分起顺序重阅',content:<Space direction="vertical"><Typography.Text>按评分历史的时间顺序，将这份及之后本题的本人评分加入重阅。提交新评分前保留原分，全部重阅完成后才能发布成绩。</Typography.Text><Input.TextArea placeholder="填写重阅原因" onChange={e=>reason=e.target.value}/></Space>,onOk:async()=>{
      if(!reason.trim()){message.error('请填写重阅原因');throw new Error('请填写重阅原因')}
      try{const result=await send<{queued:number}>(`/tasks/${row.id}/regrade-from`,{reason});await progress.reload();await next();message.success(`已加入 ${result.queued} 份重阅任务`)}catch(e){message.error((e as Error).message);throw e}
    }})
  }
  useEffect(()=>watchChanges(roots=>{if(templateId&&questionId&&history.length&&(!roots||roots.includes('tasks')))void loadHistory()}),[templateId,questionId,history.length])
  async function loadHistory() { const context=historyContext.current,version=++historyVersion.current;try { const rows=await request<Row[]>(`/tasks/history?template_id=${templateId}&question_id=${questionId}`);if(context===historyContext.current&&version===historyVersion.current)setHistory(rows) } catch (e) { if(context===historyContext.current&&version===historyVersion.current)setError((e as Error).message) } }
  return <Space className="marking-page" direction="vertical" size={16} style={{ width: '100%' }}>
    <Card title="阅卷任务" extra={admin && <Button disabled={!question||workspace.offline||locked} onClick={() => { const existing=assignments.data.find(a=>a.question_id===questionId); assignForm.setFieldsValue({user_ids:existing?.user_ids||[],weights:existing?.weights||{},arbitration_mode:existing?.arbitration_mode||(existing?.arbitrator_ids?.length?'designated_random':'random'),arbitrator_ids:existing?.arbitrator_ids||[]}); setAssignOpen(true) }}>分配教师</Button>}>
      <ErrorNotice error={workspace.offline?'':templates.error || assignments.error} /><Space wrap><Select style={{ width: 280, maxWidth: '100%' }} showSearch optionFilterProp="label" placeholder="选择考试 / 科目 / 题卡" value={templateId || undefined} options={templates.data.map(t => ({ label: groupId ? t.name : `${projects.data.find(p=>p.id===subjects.data.find(s=>s.id===groups.data.find(g=>g.id===t.group_id)?.subject_id)?.project_id)?.name||''} / ${subjects.data.find(s=>s.id===groups.data.find(g=>g.id===t.group_id)?.subject_id)?.name||''} / ${groups.data.find(g=>g.id===t.group_id)?.name||''} / ${t.name}`, value: t.id }))} disabled={locked||workspace.offline} onChange={id => { setTemplateId(id);setQuestionId('');setTask(null);setValue(null) }} /><Select style={{ width: 180, maxWidth: '100%' }} placeholder="选择主观题" value={questionId || undefined} options={template?.questions.filter(q => q.type === 'subjective').map(q => ({ label: `第 ${q.number} 题 · ${q.points} 分`, value: q.id }))} disabled={locked||workspace.offline} onChange={id=>{setQuestionId(id);setTask(null);setValue(null)}} /><Button type="primary" disabled={!question||workspace.offline||workspace.updateLocked||!workspace.ready||busy} loading={action.pending==='claim'} onClick={next}>进入阅卷</Button><Button disabled={!question||workspace.offline||locked} onClick={loadHistory}>历史与回评</Button></Space>
      <div className="help-text">{assignments.data.filter(a => a.question_id === questionId).length ? '当前题目已配置教师任务' : admin ? '请先为题目分配教师' : '选择管理员分配的题目进入评阅'}</div>
    </Card>
    <ErrorNotice error={error||workspace.storageError} />
    {workspace.offline&&<Alert type="info" showIcon message="当前可继续评阅已缓存作答，评分保存在本机；恢复连接后上传。"/>}
    {record&&<div className="review-save-status" role="status"><Tag color={record.status==='conflict'?'orange':record.status==='confirmed'?'green':'blue'}>{record.status==='queued'?'本地已保存 · 等待上传':record.status==='confirmed'?'服务器已确认':record.status==='conflict'?'本地评分待核对':saveState}</Tag>{record.error&&<Typography.Text type="warning">{record.error}</Typography.Text>}</div>}
    {question&&<Card title="评阅进度" extra={<Button onClick={progress.reload}>刷新</Button>}><Space wrap>我的任务 {progress.data.my_completed||0}/{progress.data.my_total||0} 份 · 正在评阅 {progress.data.my_in_progress||0} 份 · 待重阅 {progress.data.my_regrade_pending||0} 份 · 本题作答 {progress.data.total_submissions||0} 份</Space><div>我的进度<Progress percent={progress.data.my_progress||0}/></div><div>本题全员进度<Progress percent={progress.data.question_progress||0}/></div><div>本卷全员进度<Progress percent={progress.data.paper_progress||0}/></div></Card>}
    {task && question ? <div className="marking-layout"><Card title={`${template?.name} / 第 ${question.number} 题`} extra={<Space><Button icon={<ZoomOutOutlined />} onClick={() => setZoom(z => Math.max(.5, z - .25))}>缩小</Button><Button icon={<ZoomInOutlined />} onClick={() => setZoom(z => Math.min(4, z + .25))}>放大</Button><Checkbox checked={contrast > 1} onChange={e => setContrast(e.target.checked ? 1.5 : 1)}>优化显示</Checkbox></Space>}>
      <div className="answer-viewport" onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={e => { const d = drag.current; if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }) }} onPointerUp={() => drag.current = null} onPointerCancel={() => drag.current = null}><img src={imageUrl} alt="作答图像" draggable={false} style={{ maxWidth:'100%',transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transformOrigin: 'top left', filter: `contrast(${contrast})` }} /></div>
    </Card><Card title="评分板">{task.regrading&&<Tag color="orange">顺序重阅</Tag>}<Tag>{question.review_mode === 'double' ? '双评盲评' : '单评'} · 满分 {question.points}</Tag><Form layout="vertical" onFinish={submit}><Form.Item label="给分" validateStatus={skipWarn ? 'error' : undefined} help={skipWarn ? '设置分数；再次点下一份可跳过' : undefined}><InputNumber disabled={!editable} autoFocus style={{ width: '100%' }} size="large" min={0} max={question.points} step={step} value={value} onChange={editScore} onPressEnter={e => { e.preventDefault(); void submit() }} /></Form.Item><div className="score-presets">{Array.from({ length: Math.min(21, Math.floor(question.points / Math.max(step, 1)) + 1) }, (_, i) => Math.min(question.points, i * Math.max(step, 1))).map(n => <Button key={n} disabled={!editable} onClick={() => editScore(n)}>{n}</Button>)}</div><Space wrap><Typography.Text>步进</Typography.Text><InputNumber min={.01} max={10} value={step} onChange={n => setStep(n || .5)} /><Checkbox checked={automatic} onChange={e => setAutomatic(e.target.checked)}>评分后自动下一份</Checkbox></Space><Button block type="primary" size="large" htmlType="submit" disabled={!editable} loading={action.pending==='score'} style={{ marginTop: 20 }}>评分 / Enter</Button><Button block disabled={!editable||workspace.offline} loading={action.pending==='skip'} onClick={skip} style={{ marginTop: 8 }}>下一份 / 跳过</Button><Button block disabled={locked||workspace.offline} onClick={loadHistory} style={{ marginTop: 8 }}>上一份 / 回评</Button></Form><Space wrap style={{ marginTop: 20 }}>{(['exception', 'excellent'] as const).map(kind => <Button key={kind} disabled={workspace.offline||locked} onClick={() => Modal.confirm({ title: kind === 'exception' ? '报告异常卷' : '标记优秀卷', content: '将当前作答交由管理员查看。', onOk: async () => { await send(`/tasks/${task.id}/report`, { kind, reason: '' }); message.success('已报告') } })}>{kind === 'exception' ? '异常卷' : '优秀卷'}</Button>)}</Space><div className="help-text">本次已提交 {count} 份 · 平均 {count ? (seconds / count).toFixed(1) : '—'} 秒/份</div></Card></div> : <Empty description="选择题目并领取作答后开始阅卷" />}
    {osd && <div className="score-osd" role="status">{osd}</div>}
    {!!history.length && <Card title="我的历史评分"><Table rowKey="id" dataSource={history} columns={[{ title: '作答', dataIndex: 'id', ellipsis: true }, { title: '我的给分', dataIndex: 'score' }, { title: '实际给分', dataIndex: 'final_score', render: v => v ?? '待汇总' }, { title: '评分时间', dataIndex:'created_at',render:v=>new Date(v*1000).toLocaleString() }, { title: '操作', render: (_, row) => <Space wrap><Button disabled={workspace.offline||locked} loading={action.pending==='history'} onClick={()=>action.run('history',async()=>{try{await openTask(await request<Row>(`/tasks/${row.id}`))}catch(e){setError((e as Error).message)}})}>回评</Button><Button disabled={workspace.offline||locked} onClick={()=>regradeFrom(row)}>从此处重阅</Button></Space> }]} /></Card>}
    <Modal title="分配本题教师" open={assignOpen} onCancel={() => setAssignOpen(false)} onOk={() => assignForm.submit()}><Form form={assignForm} layout="vertical" onFinish={async values => { try { await send('/assignments', { ...values,weights:Object.fromEntries((values.user_ids as string[]).map(id=>[id,values.weights?.[id]??1])),arbitrator_ids:values.arbitration_mode==='random'?[]:values.arbitrator_ids||[], template_id: templateId, question_id: questionId }); setAssignOpen(false); await assignments.reload(); await progress.reload(); message.success('任务分配已保存') } catch (e) { message.error((e as Error).message) } }}><Form.Item name="user_ids" label="阅卷教师" rules={[{ required: true }]}><Select mode="multiple" options={users.data.map(u => ({ label: u.name, value: u.id }))} /></Form.Item>{selectedTeachers.map(id=><Form.Item key={id} name={['weights',id]} label={`${users.data.find(u=>u.id===id)?.name||id} · 分配权重`}><InputNumber min={0} max={255} placeholder="1" /></Form.Item>)}{question?.review_mode==='double'&&<><Form.Item name="arbitration_mode" label="仲裁方式"><Select options={[{label:'从阅卷教师中随机选取',value:'random'},{label:'从指定教师中随机选取',value:'designated_random'},{label:'固定仲裁教师',value:'fixed'}]}/></Form.Item>{arbitrationMode!=='random'&&<Form.Item name="arbitrator_ids" label="仲裁教师" rules={[{required:true,message:'请选择仲裁教师'}]}><Select mode="multiple" maxCount={arbitrationMode==='fixed'?1:undefined} options={users.data.map(u=>({label:u.name,value:u.id}))}/></Form.Item>}</>}</Form><Alert type="info" message="权重默认1，0表示暂停普通评阅。任务按比例分配；同一作答的双评与仲裁由不同教师完成。" /></Modal>
  </Space>
}
