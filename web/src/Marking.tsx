import { useEffect, useRef, useState } from 'react'
import { Alert, App, Card, Checkbox, Empty, Form, Input, InputNumber, Modal, Progress, Select, Space, Table, Tag, Typography } from 'antd'
import { Button } from './Button'
import { AssetImage } from './components'
import { request, send, useResource, watchChanges, type Row, type Template } from './api'
import { ErrorNotice } from './Management'
import { useAction } from './useAction'

export function Marking({ admin, groupId }: { admin: boolean; groupId?: string }) {
  const templateResource = useResource<Template[]>('/templates', []), templates = {...templateResource, data: templateResource.data.filter(t => !groupId || t.group_id === groupId)}, groups=useResource<Row[]>('/groups',[]), subjects=useResource<Row[]>('/subjects',[]), projects=useResource<Row[]>('/projects',[]), assignments = useResource<Row[]>('/assignments', []), users = useResource<Row[]>(admin ? '/users' : null, [])
  const [templateId, setTemplateId] = useState(''), [questionId, setQuestionId] = useState(''), [task, setTask] = useState<Row | null>(null), [history, setHistory] = useState<Row[]>([])
  const [value, setValue] = useState<number | null>(null), [step, setStep] = useState(.5), [error, setError] = useState(''), [skipWarn, setSkipWarn] = useState(false), [automatic, setAutomatic] = useState(true), [osd, setOsd] = useState(''), [zoom, setZoom] = useState(1), [contrast, setContrast] = useState(1), [assignOpen, setAssignOpen] = useState(false), [assignForm] = Form.useForm()
  const key = useRef(crypto.randomUUID()), started = useRef(Date.now()), [count, setCount] = useState(0), [seconds, setSeconds] = useState(0), { message } = App.useApp()
  const historyVersion=useRef(0),historyContext=useRef('');historyContext.current=`${templateId}:${questionId}`
  const action=useAction(), busy=action.busy
  const selectedTeachers: string[]=Form.useWatch('user_ids',assignForm)||[]
  const arbitrationMode=Form.useWatch('arbitration_mode',assignForm)||'random'
  const progress=useResource<Row>(templateId&&questionId?`/review-progress?template_id=${templateId}&question_id=${questionId}`:null,{} as Row)
  useEffect(() => { if(groupId && !templateId) { const published=templates.data.find(t=>t.id===groups.data.find(g=>g.id===groupId)?.template_id); if(published)setTemplateId(published.id) } },[groupId,templateId,templateResource.data,groups.data])
  const template = templates.data.find(t => t.id === templateId), question = template?.questions.find(q => q.id === questionId)
  const [pan, setPan] = useState({ x: 0, y: 0 }), drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  useEffect(() => { historyVersion.current++;setTask(null); setValue(null); setSkipWarn(false); setHistory([]); setError('') }, [templateId, questionId])
  useEffect(() => { if (!osd) return; const timer = setTimeout(() => setOsd(''), 1000); return () => clearTimeout(timer) }, [osd])
  async function claimNext() {
    const nextTask = await send<Row | null>('/tasks/claim', { template_id: templateId, question_id: questionId })
    setTask(nextTask); setValue(nextTask?.regrading?nextTask.score:null); setSkipWarn(false)
    key.current = crypto.randomUUID(); setPan({ x: 0, y: 0 })
    if (!nextTask) message.info('当前没有可领取的作答')
  }
  async function next() {
    if (!templateId || !questionId) return
    await action.run('claim', async()=>{setError('');try{await claimNext()}catch(e){setError((e as Error).message)}})
  }
  async function submit() {
    if (!task || busy) return
    if (value === null) { setSkipWarn(true); return }
    await action.run('score',async()=>{
      setError('')
      try {
        const result = await send<Row>(`/tasks/${task.id}/score`, { score: value, idempotency_key: key.current })
        setOsd(`给分：${value} 分`); setCount(n => n + 1); setSeconds((Date.now() - started.current) / 1000)
        setTask(result); await progress.reload(); key.current = crypto.randomUUID()
        if (automatic) await claimNext()
      } catch (e) { setError((e as Error).message) }
    })
  }
  async function skip() {
    if (!task || busy) return
    if (value === null && !skipWarn) { setSkipWarn(true); return }
    await action.run('skip',async()=>{try{if(task.status==='claimed'||task.regrading)await send(`/tasks/${task.id}/skip`);await claimNext()}catch(e){setError((e as Error).message)}})
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
    <Card title="阅卷任务" extra={admin && <Button disabled={!question} onClick={() => { const existing=assignments.data.find(a=>a.question_id===questionId); assignForm.setFieldsValue({user_ids:existing?.user_ids||[],weights:existing?.weights||{},arbitration_mode:existing?.arbitration_mode||(existing?.arbitrator_ids?.length?'designated_random':'random'),arbitrator_ids:existing?.arbitrator_ids||[]}); setAssignOpen(true) }}>分配教师</Button>}>
      <ErrorNotice error={templates.error || assignments.error} /><Space wrap><Select style={{ width: 280 }} showSearch optionFilterProp="label" placeholder="选择考试 / 科目 / 题卡" value={templateId || undefined} options={templates.data.map(t => ({ label: groupId ? t.name : `${projects.data.find(p=>p.id===subjects.data.find(s=>s.id===groups.data.find(g=>g.id===t.group_id)?.subject_id)?.project_id)?.name||''} / ${subjects.data.find(s=>s.id===groups.data.find(g=>g.id===t.group_id)?.subject_id)?.name||''} / ${groups.data.find(g=>g.id===t.group_id)?.name||''} / ${t.name}`, value: t.id }))} onChange={id => { setTemplateId(id); setQuestionId('') }} /><Select style={{ width: 180 }} placeholder="选择主观题" value={questionId || undefined} options={template?.questions.filter(q => q.type === 'subjective').map(q => ({ label: `第 ${q.number} 题 · ${q.points} 分`, value: q.id }))} onChange={setQuestionId} /><Button type="primary" disabled={!question||busy} loading={action.pending==='claim'} onClick={next}>进入阅卷</Button><Button disabled={!question} onClick={loadHistory}>历史与回评</Button></Space>
      <div className="help-text">{assignments.data.filter(a => a.question_id === questionId).length ? '当前题目已配置教师任务' : admin ? '请先为题目分配教师' : '选择管理员分配的题目进入评阅'}</div>
    </Card>
    <ErrorNotice error={error} />
    {question&&<Card title="评阅进度" extra={<Button onClick={progress.reload}>刷新</Button>}><Space wrap>我的任务 {progress.data.my_completed||0}/{progress.data.my_total||0} 份 · 正在评阅 {progress.data.my_in_progress||0} 份 · 待重阅 {progress.data.my_regrade_pending||0} 份 · 本题作答 {progress.data.total_submissions||0} 份</Space><div>我的进度<Progress percent={progress.data.my_progress||0}/></div><div>本题全员进度<Progress percent={progress.data.question_progress||0}/></div><div>本卷全员进度<Progress percent={progress.data.paper_progress||0}/></div></Card>}
    {task && question ? <div className="marking-layout"><Card title={`${template?.name} / 第 ${question.number} 题`} extra={<Space><Button onClick={() => setZoom(z => Math.max(.5, z - .25))}>缩小</Button><Button onClick={() => setZoom(z => Math.min(4, z + .25))}>放大</Button><Checkbox checked={contrast > 1} onChange={e => setContrast(e.target.checked ? 1.5 : 1)}>优化显示</Checkbox></Space>}>
      <div className="answer-viewport" onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; e.currentTarget.setPointerCapture(e.pointerId) }} onPointerMove={e => { const d = drag.current; if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }) }} onPointerUp={() => drag.current = null} onPointerCancel={() => drag.current = null}><AssetImage src={task.image_url} style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transformOrigin: 'top left', filter: `contrast(${contrast})` }} /></div>
    </Card><Card title="评分板">{task.regrading&&<Tag color="orange">顺序重阅</Tag>}<Tag>{question.review_mode === 'double' ? '双评盲评' : '单评'} · 满分 {question.points}</Tag><Form layout="vertical" onFinish={submit}><Form.Item label="给分" validateStatus={skipWarn ? 'error' : undefined} help={skipWarn ? '设置分数；再次点下一份可跳过' : undefined}><InputNumber disabled={busy} autoFocus style={{ width: '100%' }} size="large" min={0} max={question.points} step={step} value={value} onChange={n => { setValue(n); setSkipWarn(false); key.current = crypto.randomUUID() }} onPressEnter={e => { e.preventDefault(); void submit() }} /></Form.Item><div className="score-presets">{Array.from({ length: Math.min(21, Math.floor(question.points / Math.max(step, 1)) + 1) }, (_, i) => Math.min(question.points, i * Math.max(step, 1))).map(n => <Button key={n} disabled={busy} onClick={() => { setValue(n); setSkipWarn(false); key.current = crypto.randomUUID() }}>{n}</Button>)}</div><Space wrap><Typography.Text>步进</Typography.Text><InputNumber min={.01} max={10} value={step} onChange={n => setStep(n || .5)} /><Checkbox checked={automatic} onChange={e => setAutomatic(e.target.checked)}>评分后自动下一份</Checkbox></Space><Button block type="primary" size="large" htmlType="submit" disabled={busy} loading={action.pending==='score'} style={{ marginTop: 20 }}>评分 / Enter</Button><Button block disabled={busy} loading={action.pending==='skip'} onClick={skip} style={{ marginTop: 8 }}>下一份 / 跳过</Button><Button block disabled={busy} onClick={loadHistory} style={{ marginTop: 8 }}>上一份 / 回评</Button></Form><Space wrap style={{ marginTop: 20 }}>{(['exception', 'excellent'] as const).map(kind => <Button key={kind} onClick={() => Modal.confirm({ title: kind === 'exception' ? '报告异常卷' : '标记优秀卷', content: '将当前作答交由管理员查看。', onOk: async () => { await send(`/tasks/${task.id}/report`, { kind, reason: '' }); message.success('已报告') } })}>{kind === 'exception' ? '异常卷' : '优秀卷'}</Button>)}</Space><div className="help-text">本次已提交 {count} 份 · 平均 {count ? (seconds / count).toFixed(1) : '—'} 秒/份</div></Card></div> : <Empty description="选择题目并领取作答后开始阅卷" />}
    {osd && <div className="score-osd" role="status">{osd}</div>}
    {!!history.length && <Card title="我的历史评分"><Table rowKey="id" dataSource={history} columns={[{ title: '作答', dataIndex: 'id', ellipsis: true }, { title: '我的给分', dataIndex: 'score' }, { title: '实际给分', dataIndex: 'final_score', render: v => v ?? '待汇总' }, { title: '评分时间', dataIndex:'created_at',render:v=>new Date(v*1000).toLocaleString() }, { title: '操作', render: (_, row) => <Space wrap><Button onClick={() => { setTask(row); setValue(row.score); key.current = crypto.randomUUID(); setSkipWarn(false) }}>回评</Button><Button onClick={()=>regradeFrom(row)}>从此处重阅</Button></Space> }]} /></Card>}
    <Modal title="分配本题教师" open={assignOpen} onCancel={() => setAssignOpen(false)} onOk={() => assignForm.submit()}><Form form={assignForm} layout="vertical" onFinish={async values => { try { await send('/assignments', { ...values,weights:Object.fromEntries((values.user_ids as string[]).map(id=>[id,values.weights?.[id]??1])),arbitrator_ids:values.arbitration_mode==='random'?[]:values.arbitrator_ids||[], template_id: templateId, question_id: questionId }); setAssignOpen(false); await assignments.reload(); await progress.reload(); message.success('任务分配已保存') } catch (e) { message.error((e as Error).message) } }}><Form.Item name="user_ids" label="阅卷教师" rules={[{ required: true }]}><Select mode="multiple" options={users.data.map(u => ({ label: u.name, value: u.id }))} /></Form.Item>{selectedTeachers.map(id=><Form.Item key={id} name={['weights',id]} label={`${users.data.find(u=>u.id===id)?.name||id} · 分配权重`}><InputNumber min={0} max={255} placeholder="1" /></Form.Item>)}{question?.review_mode==='double'&&<><Form.Item name="arbitration_mode" label="仲裁方式"><Select options={[{label:'从阅卷教师中随机选取',value:'random'},{label:'从指定教师中随机选取',value:'designated_random'},{label:'固定仲裁教师',value:'fixed'}]}/></Form.Item>{arbitrationMode!=='random'&&<Form.Item name="arbitrator_ids" label="仲裁教师" rules={[{required:true,message:'请选择仲裁教师'}]}><Select mode="multiple" maxCount={arbitrationMode==='fixed'?1:undefined} options={users.data.map(u=>({label:u.name,value:u.id}))}/></Form.Item>}</>}</Form><Alert type="info" message="权重默认1，0表示暂停普通评阅。任务按比例分配；同一作答的双评与仲裁由不同教师完成。" /></Modal>
  </Space>
}
