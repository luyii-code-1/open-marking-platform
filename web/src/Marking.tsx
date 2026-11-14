import {ReviewImage} from './ReviewImage'
import {loadReviewSheet} from './reviewImages'
import { ArrowLeftOutlined, ArrowRightOutlined, HistoryOutlined, SettingOutlined, BarChartOutlined, ReloadOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { useAction } from './useAction'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, App, Checkbox, Drawer, Empty, Form, Input, InputNumber, Modal, Progress, Select, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { focusScoreInput, previousReview, scorePresets } from './reviewInteraction'
import { useReviewWorkspace } from './ReviewWorkspace'
import { cacheReview, enqueueReview, forgetReview, saveReviewDraft, settleReviewWrites, type ReviewRecord } from './reviewStore'
import { useUnsavedChanges } from './useNavigation'
import { request, send, useResource, watchChanges, type Row, type Template } from './api'
import { ErrorNotice } from './Management'

export function Marking({ admin, groupId, initialTemplateId, initialQuestionId, onExit }: { admin: boolean; groupId?: string; initialTemplateId?: string; initialQuestionId?: string; onExit?: () => void }) {
  const workspace=useReviewWorkspace()
  const action=useAction(),busy=action.busy
  const templateResource = useResource<Template[]>('/templates', []), templates = {...templateResource, data: [...new Map([...workspace.records.map(r=>({...r.template,questions:[r.question]} as Template)),...templateResource.data].map(t=>[t.id,t])).values()].filter(t => !groupId || t.group_id === groupId)}, groups=useResource<Row[]>('/groups',[]), subjects=useResource<Row[]>('/subjects',[]), projects=useResource<Row[]>('/projects',[]), assignments = useResource<Row[]>('/assignments', []), users = useResource<Row[]>(admin ? '/users' : null, [])
  const [templateId, setTemplateId] = useState(initialTemplateId || ''), [questionId, setQuestionId] = useState(initialQuestionId || ''), [task, setTask] = useState<Row | null>(null), [history, setHistory] = useState<Row[]>([])
  const [value, setValue] = useState<number | null>(null), [step, setStep] = useState(.5), [error, setError] = useState(''), [skipWarn, setSkipWarn] = useState(false), [automatic, setAutomatic] = useState(true), [osd, setOsd] = useState(''), [zoom, setZoom] = useState(1), [contrast, setContrast] = useState(1), [assignOpen, setAssignOpen] = useState(false), [assignForm] = Form.useForm()
  const started = useRef(Date.now()), [count, setCount] = useState(0), [seconds, setSeconds] = useState(0), { message } = App.useApp()
  const historyVersion=useRef(0),historyContext=useRef('');historyContext.current=`${templateId}:${questionId}`
  const selectedTeachers: string[]=Form.useWatch('user_ids',assignForm)||[]
  const arbitrationMode=Form.useWatch('arbitration_mode',assignForm)||'random'
  const progress=useResource<Row>(templateId&&questionId?`/review-progress?template_id=${templateId}&question_id=${questionId}`:null,{} as Row)
  useEffect(() => { if(groupId && !templateId) { const published=templates.data.find(t=>t.id===groups.data.find(g=>g.id===groupId)?.template_id); if(published)setTemplateId(published.id) } },[groupId,templateId,templateResource.data,groups.data])
  const record=workspace.records.find(r=>r.task.id===task?.id)
  const template = templates.data.find(t => t.id === templateId), question = record?.question||template?.questions.find(q => q.id === questionId)
  const [saveState,setSaveState]=useState(''),saveVersion=useRef(0),restored=useRef(false),submitted=useRef<string|null>(null)
  const locked=busy||workspace.updateLocked||!!workspace.storageError
  const editable=record?.status==='draft'&&!locked
  const pageRef=useRef<HTMLDivElement>(null),scoreRef=useRef<HTMLDivElement>(null)
  const [historyOpen,setHistoryOpen]=useState(false),[settingsOpen,setSettingsOpen]=useState(false),[progressOpen,setProgressOpen]=useState(false)
  const overlayOpen=historyOpen||settingsOpen||progressOpen||assignOpen
  function refocusScore(){requestAnimationFrame(()=>{if(!overlayOpen)focusScoreInput(scoreRef.current)})}
  useLayoutEffect(()=>{
    const page=pageRef.current;if(!page)return
    const resize=()=>page.style.setProperty('--marking-height',`${Math.max(240,(window.visualViewport?.height??window.innerHeight)-page.getBoundingClientRect().top-12)}px`)
    resize();window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize)
    const observer=new ResizeObserver(resize);if(page.parentElement)observer.observe(page.parentElement)
    return()=>{window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize);observer.disconnect()}
  },[])
  useEffect(()=>{if(!editable||overlayOpen)return;const frame=requestAnimationFrame(()=>focusScoreInput(scoreRef.current));return()=>cancelAnimationFrame(frame)},[task?.id,editable,overlayOpen])
  useUnsavedChanges(saveState==='正在保存本地草稿'||saveState==='本地保存失败')
  function showRecord(row:ReviewRecord){started.current=Date.now();setTemplateId(row.template.id);setQuestionId(row.question.id);setTask(row.task);setValue(row.draft);setSaveState('本地草稿已保存');setSkipWarn(false);setPan({x:0,y:0});setZoom(1)}
  useEffect(()=>{if(initialTemplateId||!workspace.ready||restored.current)return;restored.current=true;const row=workspace.records.find(r=>r.status!=='confirmed'&&(!groupId||r.template.group_id===groupId));if(row)showRecord(row)},[workspace.ready,workspace.records,groupId])

  const [pan, setPan] = useState({ x: 0, y: 0 }), drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  useEffect(() => { historyVersion.current++;setHistory([]);setError('') }, [templateId, questionId])
  useEffect(() => { if (!osd) return; const timer = setTimeout(() => setOsd(''), 1000); return () => clearTimeout(timer) }, [osd])
  async function openTask(row:Row) {
    if(!template)return
    const selected=template.questions.find(q=>q.id===row.question_id)
    if(!selected)throw new Error('题目配置不可用')
    const sheet=await loadReviewSheet(row.id)
    const saved=await cacheReview(workspace.user.id,row,{id:template.id,name:template.name,group_id:template.group_id,revision:template.revision},selected,new Blob([]),sheet)
    showRecord(saved)
  }
  async function next() {
    if(!templateId||!questionId||workspace.offline||workspace.updateLocked)return
    if(record&&['queued','conflict'].includes(record.status)){setError('请先等待这份评分上传或核对本地记录');return}
    await action.run('claim',async()=>{setError('')
    try{await settleReviewWrites();const row=await send<Row|null>('/tasks/claim',{template_id:templateId,question_id:questionId});if(row)await openTask(row);else{setTask(null);setValue(null);message.info('当前没有可领取的作答')}}catch(e){setError((e as Error).message)}})
  }
  const entered=useRef(false)
  useEffect(()=>{
    if(!initialTemplateId||!initialQuestionId||!workspace.ready||entered.current)return
    const cached=workspace.records.find(r=>r.template.id===initialTemplateId&&r.question.id===initialQuestionId&&r.status!=='confirmed')
    if(cached){entered.current=true;showRecord(cached);return}
    if(!template||!question||workspace.offline||workspace.updateLocked||workspace.storageError)return
    entered.current=true
    void next()
  },[initialTemplateId,initialQuestionId,template?.id,question?.id,workspace.ready,workspace.offline,workspace.updateLocked,workspace.storageError,workspace.records])
  function editScore(score:number|null) {
    if(!task||!editable)return
    setValue(score);setSkipWarn(false);setSaveState('正在保存本地草稿')
    const version=++saveVersion.current
    void saveReviewDraft(workspace.user.id,task.id,score).then(()=>{if(version===saveVersion.current)setSaveState('本地草稿已保存')}).catch(e=>{if(version===saveVersion.current){setSaveState('本地保存失败');setError((e as Error).message)}})
  }
  async function submit() {
    if(!task||locked||record?.status!=='draft')return
    if(value===null){setSkipWarn(true);refocusScore();return}
    if(!question||!Number.isFinite(value)||value<0||value>question.points){setError(`请输入 0～${question?.points??0} 分`);refocusScore();return}
    await action.run('score',async()=>{setError('')
    try{await settleReviewWrites();submitted.current=task.id;await enqueueReview(workspace.user.id,task.id,value);setSaveState('本地已保存，等待服务器确认');setOsd(`给分：${value} 分 · 待上传`);void workspace.sync()}catch(e){submitted.current=null;setError((e as Error).message)}})
    refocusScore()
  }
  useEffect(()=>{
    if(!record||record.status!=='confirmed'||busy)return
    if(task?.status!=='completed'||task.score_revision!==record.task.score_revision){setTask(record.task);setValue(record.task.score)}
    if(submitted.current!==record.task.id)return
    submitted.current=null;setOsd(`给分：${record.task.score} 分`);setCount(n=>n+1);setSeconds(n=>n+(Date.now()-started.current)/1000);void progress.reload()
    if(automatic&&!workspace.offline&&!workspace.updateLocked)void next()
  },[record?.status,record?.task.score_revision,busy,workspace.offline,workspace.updateLocked])
  async function skip() {
    if(!task||locked||workspace.offline||record?.status!=='draft')return
    if(value===null&&!skipWarn){setSkipWarn(true);refocusScore();return}
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
  useEffect(()=>watchChanges(roots=>{if(templateId&&questionId&&historyOpen&&(!roots||roots.includes('tasks')))void loadHistory()}),[templateId,questionId,historyOpen])
  async function loadHistory() { const context=historyContext.current,version=++historyVersion.current;try { const rows=(await request<Row[]>(`/tasks/history?template_id=${templateId}&question_id=${questionId}`)).reverse();if(context===historyContext.current&&version===historyVersion.current){setHistory(rows);return rows} } catch (e) { if(context===historyContext.current&&version===historyVersion.current)setError((e as Error).message) } }
  const group=groups.data.find(g=>g.id===template?.group_id),subject=subjects.data.find(s=>s.id===group?.subject_id),project=projects.data.find(p=>p.id===subject?.project_id)
  const origin=[project?.name,subject?.name,group?.grade_name,group?.name,template?.name].filter(Boolean).join(' / ')
  const myCompleted=progress.data.my_completed??0,myTotal=progress.data.my_total??0
  function openHistory(){setHistoryOpen(true);void loadHistory()}
  async function reviewHistory(row:Row){
    if(record?.status==='draft'&&value!==null&&record.task.id!==row.id&&!window.confirm('当前给分尚未提交，确认先回评历史作答？本地草稿会保留。'))return
    await action.run(`history:${row.id}`,async()=>{try{await openTask(await request<Row>(`/tasks/${row.id}`));setHistoryOpen(false)}catch(e){setError((e as Error).message)}})
  }
  async function previous(){
    if(record?.status==='draft'&&value!==null&&!window.confirm('当前给分尚未提交，确认回评上一份？本地草稿会保留。'))return
    await action.run('previous',async()=>{try{
      const rows=await loadHistory();if(!rows)return
      const row=previousReview(rows,task?.id)
      if(row)await openTask(await request<Row>(`/tasks/${row.id}`));else message.info('已到最早一份评分')
    }catch(e){setError((e as Error).message)}})
  }
  return <div ref={pageRef} className="marking-page">
    <header className="marking-toolbar">
      <div className="marking-selectors" hidden={!!onExit}>
        <Select aria-label="考试科目与题卡" className="marking-template-select" showSearch optionFilterProp="label" placeholder="选择考试 / 科目 / 年级 / 题卡" value={templateId||undefined} options={templates.data.map(t=>({label:groupId?t.name:`${projects.data.find(p=>p.id===subjects.data.find(s=>s.id===groups.data.find(g=>g.id===t.group_id)?.subject_id)?.project_id)?.name||''} / ${subjects.data.find(s=>s.id===groups.data.find(g=>g.id===t.group_id)?.subject_id)?.name||''} / ${groups.data.find(g=>g.id===t.group_id)?.grade_name||'待设置年级'} / ${groups.data.find(g=>g.id===t.group_id)?.name||''} / ${t.name}`,value:t.id}))} disabled={locked||workspace.offline} onChange={id=>{setTemplateId(id);setQuestionId('');setTask(null);setValue(null)}} />
        <Select aria-label="评阅题目" className="marking-question-select" placeholder="选择主观题" value={questionId||undefined} options={template?.questions.filter(q=>q.type==='subjective').map(q=>({label:`第 ${q.number} 题 · ${q.points} 分`,value:q.id}))} disabled={locked||workspace.offline} onChange={id=>{setQuestionId(id);setTask(null);setValue(null)}} />
        <Button type="primary" disabled={!question||workspace.offline||workspace.updateLocked||!workspace.ready||busy||record?.status==='draft'||record?.status==='queued'||record?.status==='conflict'} loading={action.pending==='claim'} onClick={next}>{task?'领取下一份':'进入阅卷'}</Button>
      </div>
      <Space size={4} wrap>
        {onExit&&<Button onClick={onExit}>退出阅卷</Button>}<Button icon={<HistoryOutlined/>} disabled={!question||workspace.offline||locked} onClick={openHistory}>历史</Button>
        <Button icon={<BarChartOutlined/>} disabled={!question} onClick={()=>setProgressOpen(true)}>进度</Button>
        <Button icon={<SettingOutlined/>} onClick={()=>setSettingsOpen(true)}>设置</Button>
      </Space>
    </header>
    <div className="marking-notices">
      <ErrorNotice error={error||workspace.storageError||(workspace.offline?'':templates.error||assignments.error)} />
      {workspace.offline&&<Alert type="info" showIcon message="离线评阅：评分保存在本机，恢复连接后上传。"/>}
    </div>
    <div className="marking-context"><span title={origin}>{origin||'请选择阅卷任务'}{question&&` / 第 ${question.number} 题`}{task?.grade_name&&` · ${task.grade_name}`}{task?.room_tags?.length?` · ${task.room_tags.map((t:Row)=>t.label||t.name).join('、')}`:''}</span>{record&&<Tag color={record.status==='conflict'?'orange':record.status==='confirmed'?'green':'blue'} role="status">{record.status==='queued'?'已暂存 · 等待上传':record.status==='confirmed'?'服务器已确认':record.status==='conflict'?'评分待核对':saveState}</Tag>}</div>
    {record?.error&&<Alert type="warning" message={record.error} showIcon/>}
    {task&&question?<main className="marking-layout">
      <section className="marking-image-panel" aria-label="作答图像区">
        <div className="marking-image-toolbar"><strong>第 {question.number} 题</strong><Space size={4}>
          <Button type="text" aria-label="缩小作答" icon={<ZoomOutOutlined/>} onClick={()=>{setZoom(z=>Math.max(.5,z-.25));refocusScore()}}/>
          <Button type="text" title="适应窗口" onClick={()=>{setZoom(1);setPan({x:0,y:0});refocusScore()}}>{Math.round(zoom*100)}%</Button>
          <Button type="text" aria-label="放大作答" icon={<ZoomInOutlined/>} onClick={()=>{setZoom(z=>Math.min(4,z+.25));refocusScore()}}/>
          <Checkbox checked={contrast>1} onChange={e=>{setContrast(e.target.checked?1.5:1);refocusScore()}}>优化显示</Checkbox>
        </Space></div>
        <div className="answer-viewport" onPointerDown={e=>{drag.current={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{const d=drag.current;if(d)setPan({x:d.px+e.clientX-d.x,y:d.py+e.clientY-d.y})}} onPointerUp={()=>{drag.current=null;refocusScore()}} onPointerCancel={()=>drag.current=null}>
          {record?<ReviewImage sheet={record.sheet} image={record.image} style={{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`,filter:`contrast(${contrast})`}}/>:<Empty description="正在准备题图"/>}
          {osd&&<div className="score-osd" role="status">{osd}</div>}
        </div>
      </section>
      <aside className="marking-score-panel" aria-label="评分板">
        <div className="marking-score-heading"><strong>评分板</strong><span>{question.review_mode==='double'?'双评盲评':'单评'} · 满分 {question.points}</span>{task.regrading&&<Tag color="orange">重阅</Tag>}</div>
        <div className="marking-score-body">
          <div className="marking-score-entry" ref={scoreRef}>
            <label htmlFor="marking-score">给分 <span>Enter 提交</span></label>
            <InputNumber id="marking-score" aria-label="给分" aria-invalid={skipWarn} readOnly={!editable} status={skipWarn?'error':undefined} size="large" min={0} max={question.points} step={step} value={value} onChange={editScore} onPressEnter={e=>{e.preventDefault();if(!e.nativeEvent.isComposing)void submit()}}/>
            <div className={skipWarn?'marking-score-hint error':'marking-score-hint'} role={skipWarn?'alert':undefined}>{skipWarn?'设置分数；再次点下一份可跳过':'输入分数或选择预设，然后按 Enter'}</div>
          </div>
          <div className="score-presets" aria-label="预设分值">{scorePresets(question.points,step).map(n=><Button key={n} type={value===n?'primary':'default'} disabled={!editable} onClick={()=>{editScore(n);refocusScore()}}>{n}</Button>)}</div>
          <Checkbox checked={automatic} onChange={e=>{setAutomatic(e.target.checked);refocusScore()}}>评分后自动下一份</Checkbox>
          <Button className="marking-submit" block type="primary" size="large" disabled={!editable} loading={action.pending==='score'} onClick={submit}>评分 / Enter</Button>
          <div className="marking-page-actions">
            <Button icon={<ArrowLeftOutlined/>} disabled={locked||workspace.offline||record?.status==='queued'||record?.status==='conflict'} loading={action.pending==='previous'} onClick={previous}>上一份</Button>
            <Button icon={<ArrowRightOutlined/>} disabled={locked||workspace.offline||record?.status==='queued'||record?.status==='conflict'} loading={action.pending==='skip'} onClick={()=>record?.status==='confirmed'?next():skip()}>下一份</Button>
          </div>

        </div>
      </aside>
    </main>:<div className="marking-empty"><Empty description={onExit?(busy||templateResource.loading?"正在加载作答":"当前没有可领取的作答"):"选择题目，进入阅卷"}>{onExit&&<Space><Button disabled={!question||locked||workspace.offline} onClick={next}>重新领取</Button><Button onClick={onExit}>返回任务列表</Button></Space>}</Empty></div>}
    <footer className="marking-progress-footer">
      <div className="marking-progress-summary"><strong>我的进度 <b>{myCompleted}</b> / {myTotal} 份</strong><span>{Number(progress.data.my_progress||0).toFixed(0)}%</span></div>
      <Progress percent={progress.data.my_progress||0} showInfo={false} size="small"/>
      <div className="marking-session"><span>本次完成 {count} 份 · 平均 {count?(seconds/count).toFixed(1):'—'} 秒/份</span><Button size="small" type="text" icon={<ReloadOutlined/>} loading={progress.loading} disabled={!question||workspace.offline} onClick={progress.reload}>刷新进度</Button></div>
      <div ref={workspace.setQueueTarget} className="marking-queue-slot"/>
    </footer>
    <Drawer title="我的历史与回评" width={840} open={historyOpen} onClose={()=>setHistoryOpen(false)}>
      <ErrorNotice error={error}/><Table rowKey="id" dataSource={history} pagination={{pageSize:10}} scroll={{x:700}} locale={{emptyText:'暂无历史评分'}} columns={[{title:'作答',dataIndex:'id',ellipsis:true},{title:'我的给分',dataIndex:'score'},{title:'实际给分',dataIndex:'final_score',render:v=>v??'待汇总'},{title:'评分时间',dataIndex:'created_at',render:v=>new Date(v*1000).toLocaleString()},{title:'操作',render:(_,row)=><Space><Button disabled={workspace.offline||locked||record?.status==='queued'||record?.status==='conflict'} loading={action.pending===`history:${row.id}`} onClick={()=>reviewHistory(row)}>回评</Button><Button disabled={workspace.offline||locked} onClick={()=>regradeFrom(row)}>从此处重阅</Button></Space>}]}/>
    </Drawer>
    <Drawer title="评阅进度" width={400} open={progressOpen} onClose={()=>setProgressOpen(false)}>
      <ErrorNotice error={progress.error}/><p>我的任务 {myCompleted} / {myTotal} 份</p><p>正在评阅 {progress.data.my_in_progress||0} · 待重阅 {progress.data.my_regrade_pending||0} · 本题作答 {progress.data.total_submissions||0}</p>
      <p>我的进度</p><Progress percent={progress.data.my_progress||0}/><p>本题全员进度</p><Progress percent={progress.data.question_progress||0}/><p>本卷全员进度</p><Progress percent={progress.data.paper_progress||0}/>
      <Button loading={progress.loading} disabled={workspace.offline} onClick={progress.reload}>刷新</Button>
    </Drawer>
    <Drawer title="阅卷设置" width={360} open={settingsOpen} onClose={()=>setSettingsOpen(false)}>
      <Space direction="vertical" size={20} style={{width:'100%'}}><label>评分步进 <InputNumber aria-label="评分步进" min={.01} max={10} value={step} onChange={n=>setStep(n||.5)}/></label><Typography.Text type="secondary">预设分值只填入给分框，按 Enter 或“评分”后提交。</Typography.Text>
      {task&&question&&<div className="marking-report-actions">{(['exception','excellent'] as const).map(kind=><Button size="small" type="text" key={kind} disabled={workspace.offline||locked} onClick={()=>Modal.confirm({title:kind==='exception'?'报告异常卷':'标记优秀卷',content:'将当前作答交由管理员查看。',afterClose:refocusScore,onOk:async()=>{await send(`/tasks/${task.id}/report`,{kind,reason:''});message.success('已报告')}})}>{kind==='exception'?'报告异常卷':'标记优秀卷'}</Button>)}</div>}
      {admin&&<Button disabled={!question||workspace.offline||locked} onClick={()=>{const existing=assignments.data.find(a=>a.question_id===questionId);assignForm.setFieldsValue({user_ids:existing?.user_ids||[],weights:existing?.weights||{},arbitration_mode:existing?.arbitration_mode||(existing?.arbitrator_ids?.length?'designated_random':'random'),arbitrator_ids:existing?.arbitrator_ids||[]});setSettingsOpen(false);setAssignOpen(true)}}>分配本题教师</Button>}</Space>
    </Drawer>
    <Modal title="分配本题教师" open={assignOpen} onCancel={() => setAssignOpen(false)} onOk={() => assignForm.submit()}><Form form={assignForm} layout="vertical" onFinish={async values => { try { await send('/assignments', { ...values,weights:Object.fromEntries((values.user_ids as string[]).map(id=>[id,values.weights?.[id]??1])),arbitrator_ids:values.arbitration_mode==='random'?[]:values.arbitrator_ids||[], template_id: templateId, question_id: questionId }); setAssignOpen(false); await assignments.reload(); await progress.reload(); message.success('任务分配已保存') } catch (e) { message.error((e as Error).message) } }}><Form.Item name="user_ids" label="阅卷教师" rules={[{ required: true }]}><Select mode="multiple" options={users.data.map(u => ({ label: u.name, value: u.id }))} /></Form.Item>{selectedTeachers.map(id=><Form.Item key={id} name={['weights',id]} label={`${users.data.find(u=>u.id===id)?.name||id} · 分配权重`}><InputNumber min={0} max={255} placeholder="1" /></Form.Item>)}{question?.review_mode==='double'&&<><Form.Item name="arbitration_mode" label="仲裁方式"><Select options={[{label:'从阅卷教师中随机选取',value:'random'},{label:'从指定教师中随机选取',value:'designated_random'},{label:'固定仲裁教师',value:'fixed'}]}/></Form.Item>{arbitrationMode!=='random'&&<Form.Item name="arbitrator_ids" label="仲裁教师" rules={[{required:true,message:'请选择仲裁教师'}]}><Select mode="multiple" maxCount={arbitrationMode==='fixed'?1:undefined} options={users.data.map(u=>({label:u.name,value:u.id}))}/></Form.Item>}</>}</Form><Alert type="info" message="权重默认1，0表示暂停普通评阅。任务按比例分配；同一作答的双评与仲裁由不同教师完成。" /></Modal>
  </div>
}
