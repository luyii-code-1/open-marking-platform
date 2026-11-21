import {examPath} from './examNavigation'
import {questionLabel} from './mergeQuestions'
import {ReviewImage} from './ReviewImage'
import {loadReviewSheet} from './reviewImages'
import { ArrowLeftOutlined, ArrowRightOutlined, HistoryOutlined, SettingOutlined, BarChartOutlined, ReloadOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { useAction } from './useAction'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, App, Checkbox, Drawer, Empty, Input, InputNumber, Modal, Progress, Select, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { focusScoreInput, previousReview, scoreInputError, scorePresets } from './reviewInteraction'
import { useReviewWorkspace } from './ReviewWorkspace'
import { cacheReview, enqueueReview, forgetReview, getReview, hasUnsentReview, listReviews, saveReviewDraft, settleReviewWrites, type ReviewRecord } from './reviewStore'
import { useUnsavedChanges } from './useNavigation'
import { ApiError, request, send, useResource, watchChanges, type Row, type Template } from './api'
import { ErrorNotice } from './Management'

export function Marking({ admin, groupId, initialProjectId, initialTemplateId, initialQuestionId, onExit }: { admin: boolean; groupId?: string; initialProjectId?:string; initialTemplateId?: string; initialQuestionId?: string; onExit?: (projectId?:string) => void }) {
  const workspace=useReviewWorkspace()
  const action=useAction(),busy=action.busy
  const templateResource = useResource<Template[]>('/templates', []), templates = {...templateResource, data: [...new Map([...workspace.records.map(r=>({...r.template,questions:[r.question]} as Template)),...templateResource.data].map(t=>[t.id,t])).values()].filter(t => !groupId || t.group_id === groupId)}, groups=useResource<Row[]>('/groups',[]), subjects=useResource<Row[]>('/subjects',[]), projects=useResource<Row[]>('/projects',[]), assignments = useResource<Row[]>('/assignments', [])
  const [templateId, setTemplateId] = useState(initialTemplateId || ''), [questionId, setQuestionId] = useState(initialQuestionId || ''), [task, setTask] = useState<Row | null>(null), [history, setHistory] = useState<Row[]>([])
  const [scoreText,setScoreText]=useState(''),[scoreError,setScoreError]=useState('')
  const value=scoreText.trim()!==''&&Number.isFinite(Number(scoreText))?Number(scoreText):null
  const [step, setStep] = useState(.5), [error, setError] = useState(''), [skipWarn, setSkipWarn] = useState(false), [automatic, setAutomatic] = useState(true), [osd, setOsd] = useState<{text:string}|null>(null), [zoom, setZoom] = useState(1), [contrast, setContrast] = useState(1)
  const started = useRef(Date.now()), [count, setCount] = useState(0), [seconds, setSeconds] = useState(0), { message } = App.useApp()
  const historyVersion=useRef(0),historyContext=useRef('');historyContext.current=`${templateId}:${questionId}`
  const progress=useResource<Row>(templateId&&questionId?`/review-progress?template_id=${templateId}&question_id=${questionId}`:null,{} as Row)
  useEffect(() => { if(groupId && !templateId) { const published=templates.data.find(t=>t.id===groups.data.find(g=>g.id===groupId)?.template_id); if(published)setTemplateId(published.id) } },[groupId,templateId,templateResource.data,groups.data])
  const record=workspace.records.find(r=>r.task.id===task?.id)
  const template = templates.data.find(t => t.id === templateId), question = record?.question||template?.questions.find(q => q.id === questionId)
  const group=groups.data.find(g=>g.id===template?.group_id),subject=subjects.data.find(s=>s.id===group?.subject_id),project=projects.data.find(p=>p.id===subject?.project_id)
  const published=!!group?.frozen
  function leave(){onExit?.(subject?.project_id||record?.template.project_id||initialProjectId)}
  const [saveState,setSaveState]=useState(''),saveVersion=useRef(0),restored=useRef(false),submitted=useRef<string|null>(null)
  const ahead=useRef<{from:string;work:Promise<ReviewRecord|null>}|null>(null)
  const locked=busy||workspace.updateLocked||!!workspace.storageError
  const editable=record?.status==='draft'&&!locked&&!published
  const pageRef=useRef<HTMLDivElement>(null),scoreRef=useRef<HTMLDivElement>(null)
  const [historyOpen,setHistoryOpen]=useState(false),[settingsOpen,setSettingsOpen]=useState(false),[progressOpen,setProgressOpen]=useState(false)
  const overlayOpen=historyOpen||settingsOpen||progressOpen
  function refocusScore(){requestAnimationFrame(()=>{if(!overlayOpen)focusScoreInput(scoreRef.current)})}
  useLayoutEffect(()=>{
    const page=pageRef.current;if(!page)return
    const resize=()=>page.style.setProperty('--marking-height',`${Math.max(240,(window.visualViewport?.height??window.innerHeight)-page.getBoundingClientRect().top-12)}px`)
    resize();window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize)
    const observer=new ResizeObserver(resize);if(page.parentElement)observer.observe(page.parentElement)
    return()=>{window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize);observer.disconnect()}
  },[])
  useEffect(()=>{if(!editable||overlayOpen)return;const frame=requestAnimationFrame(()=>focusScoreInput(scoreRef.current));return()=>cancelAnimationFrame(frame)},[task?.id,editable,overlayOpen])
  useUnsavedChanges(saveState==='正在保存本地草稿'||saveState==='本地保存失败'||(record?.status==='draft'&&scoreText!==String(record.task.score??'')))
  function showRecord(row:ReviewRecord){
    ++saveVersion.current;submitted.current=null;started.current=Date.now();setTemplateId(row.template.id);setQuestionId(row.question.id);setTask(row.task)
    const text=row.draftText??String(row.draft??'')
    setScoreText(text);setScoreError(text?scoreInputError(text,row.question.points,row.question.step):'')
    setSaveState('本地草稿已保存');setSkipWarn(false);setPan({x:0,y:0});setZoom(1)
  }
  function clearTask(){++saveVersion.current;setTask(null);setScoreText('');setScoreError('');setSkipWarn(false);setSaveState('')}
  useEffect(()=>{if(initialTemplateId||!workspace.ready||restored.current)return;restored.current=true;const drafts=workspace.records.filter(r=>r.status==='draft'&&(!groupId||r.template.group_id===groupId));const row=drafts.find(hasUnsentReview)||drafts.at(-1);if(row)showRecord(row)},[workspace.ready,workspace.records,groupId])

  const [pan, setPan] = useState({ x: 0, y: 0 }), drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  useEffect(() => { historyVersion.current++;setHistory([]);setError('') }, [templateId, questionId])
  useEffect(() => { if (!osd) return; const timer = setTimeout(() => setOsd(null), 1000); return () => clearTimeout(timer) }, [osd])
  async function cacheTask(row:Row) {
    if(!template)throw new Error('题卡配置不可用')
    const selected=template.questions.find(q=>q.id===row.question_id)
    if(!selected)throw new Error('题目配置不可用')
    const sheet=await loadReviewSheet(row.id)
    return cacheReview(workspace.user.id,row,{id:template.id,name:template.name,group_id:template.group_id,revision:template.revision,
      project_id:subject?.project_id||initialProjectId,project_name:project?.name,subject_name:subject?.name,exam_status:project?.exam_status},selected,new Blob([]),sheet)
  }
  async function openTask(row:Row){showRecord(await cacheTask(row))}
  async function availableTask(from?:string):Promise<ReviewRecord|null>{
    const local=(await listReviews(workspace.user.id)).filter(r=>r.template.id===templateId&&r.question.id===questionId)
    const drafts=local.filter(r=>r.status==='draft'&&r.task.id!==from&&(hasUnsentReview(r)||workspace.offline||r.task.status!=='claimed'||r.task.expires_at*1000>Date.now()))
    const cached=drafts.find(hasUnsentReview)||drafts.at(-1)
    if(cached&&hasUnsentReview(cached))return cached
    if(workspace.offline||!navigator.onLine)return cached||null
    const held=local.filter(r=>r.operation).map(r=>r.task.id)
    if(from&&!held.includes(from))held.push(from)
    let row:Row|null
    try{row=await send<Row|null>('/tasks/claim',{template_id:templateId,question_id:questionId,pending_task_ids:held})}
    catch(error){if(cached&&(!(error instanceof ApiError)||error.status===403))return cached;throw error}
    if(!row||held.includes(row.id))return null
    const saved=await cacheTask(row)
    return saved.status==='draft'?saved:null
  }
  useEffect(()=>{
    if(published||!task||!record||record.status!=='draft'||!automatic||workspace.offline||workspace.updateLocked||
      (task.status!=='claimed'&&!task.regrading))return
    const from=task.id
    // A cancelled or failed preload is retried through the ordinary claim action.
    const timer=setTimeout(()=>{
      const work=availableTask(from)
      ahead.current={from,work}
      void work.catch(()=>{if(ahead.current?.work===work)ahead.current=null})
    },0)
    return()=>clearTimeout(timer)
  },[task?.id,record?.status,automatic,workspace.offline,workspace.updateLocked,published])
  async function advance(from?:string,afterSkip=false){
    const prepared=from&&ahead.current?.from===from?ahead.current.work:null
    ahead.current=null
    const prefetched=prepared&&await prepared.catch(()=>null)
    if(prefetched){
      const latest=await getReview(workspace.user.id,prefetched.task.id)
      const arbitrationWaiting=(progress.data.my_arbitration_pending||0)>0
      if(latest?.status==='draft'&&(!arbitrationWaiting||latest.task.review_role==='arbitration'||hasUnsentReview(latest)||workspace.offline)&&(latest.task.status!=='claimed'||latest.task.expires_at*1000>Date.now()||workspace.offline||hasUnsentReview(latest))){showRecord(latest);return}
    }
    const saved=await availableTask(afterSkip?undefined:from)
    if(saved)showRecord(saved);else clearTask()
  }
  async function next() {
    if(!templateId||!questionId||workspace.updateLocked||published)return
    await action.run('claim',async()=>{setError('')
      try{await advance(task?.id)}catch(e){setError((e as Error).message)}
    })
  }
  const entered=useRef(false)
  useEffect(()=>{
    if(!initialTemplateId||!initialQuestionId||!workspace.ready||entered.current)return
    const drafts=workspace.records.filter(r=>r.template.id===initialTemplateId&&r.question.id===initialQuestionId&&r.status==='draft')
    const cached=drafts.find(hasUnsentReview)||drafts.at(-1)
    if(cached&&(workspace.offline||!navigator.onLine||hasUnsentReview(cached))){entered.current=true;showRecord(cached);return}
    if(!template||!question||workspace.offline||workspace.updateLocked||workspace.storageError||!groups.loaded)return
    entered.current=true
    if(published)openHistory();else void next()
  },[initialTemplateId,initialQuestionId,template?.id,question?.id,workspace.ready,workspace.offline,workspace.updateLocked,workspace.storageError,workspace.records,groups.loaded,published])
  function editScore(text:string) {
    if(!task||!editable)return
    const raw=text.trim(),score=raw&&Number.isFinite(Number(raw))?Number(raw):null
    setScoreText(text);setSkipWarn(false);setSaveState('正在保存本地草稿')
    setScoreError(raw&&question?scoreInputError(text,question.points,question.step):'')
    const version=++saveVersion.current
    void saveReviewDraft(workspace.user.id,task.id,score,text).then(()=>{if(version===saveVersion.current)setSaveState('本地草稿已保存')}).catch(e=>{if(version===saveVersion.current){setSaveState('本地保存失败');setError((e as Error).message)}})
  }
  async function submit() {
    if(!task||!editable||submitted.current===task.id)return
    if(!question)return
    const issue=scoreInputError(scoreText,question.points,question.step)
    if(issue||value===null){setScoreError(issue);refocusScore();return}
    await action.run('score',async()=>{setError('')
    try{
      await enqueueReview(workspace.user.id,task.id,value)
      submitted.current=task.id
      setSaveState('');setOsd({text:`评分：${value}分`});setCount(n=>n+1)
      const elapsed=(Date.now()-started.current)/1000;setSeconds(n=>n+elapsed)
      void workspace.sync()
      if(automatic)await advance(task.id)
    }catch(e){setError((e as Error).message)}})
    refocusScore()
  }
  useEffect(()=>{
    if(!record||record.status!=='confirmed'||busy)return
    if(task?.status!=='completed'||task.score_revision!==record.task.score_revision){setTask(record.task);setScoreText(String(record.task.score??''))}
  },[record?.status,record?.task.score_revision,busy])
  async function skip() {
    if(!task||locked||workspace.offline||record?.status!=='draft')return
    if(value===null&&!skipWarn){setSkipWarn(true);refocusScore();return}
    if(value!==null&&!window.confirm('当前分数尚未提交，确认跳过这份作答？'))return
    await action.run('skip',async()=>{try{await settleReviewWrites();if(task.status==='claimed'||task.regrading)await send(`/tasks/${task.id}/skip`);await forgetReview(workspace.user.id,task.id);await advance(task.id,true)}catch(e){setError((e as Error).message)}})
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
        <Select aria-label="考试科目与题卡" className="marking-template-select" showSearch optionFilterProp="label" placeholder="选择考试 / 科目 / 年级 / 题卡" value={templateId||undefined} options={templates.data.map(t=>({label:groupId?t.name:`${projects.data.find(p=>p.id===subjects.data.find(s=>s.id===groups.data.find(g=>g.id===t.group_id)?.subject_id)?.project_id)?.name||''} / ${subjects.data.find(s=>s.id===groups.data.find(g=>g.id===t.group_id)?.subject_id)?.name||''} / ${groups.data.find(g=>g.id===t.group_id)?.grade_name||'待设置年级'} / ${groups.data.find(g=>g.id===t.group_id)?.name||''} / ${t.name}`,value:t.id}))} disabled={locked||workspace.offline} onChange={id=>{setTemplateId(id);setQuestionId('');clearTask()}} />
        <Select aria-label="评阅题目" className="marking-question-select" placeholder="选择主观题" value={questionId||undefined} options={template?.questions.filter(q=>q.type==='subjective').map(q=>({label:`第 ${questionLabel(q)} 题 · ${q.points} 分`,value:q.id}))} disabled={locked||workspace.offline} onChange={id=>{setQuestionId(id);clearTask()}} />
        <Button type="primary" disabled={!question||workspace.updateLocked||!workspace.ready||busy||record?.status==='draft'} loading={action.pending==='claim'} onClick={next}>{task?'领取下一份':'进入阅卷'}</Button>
      </div>
      <Space size={4} wrap>
        {onExit&&<Button onClick={leave}>退出阅卷</Button>}<Button icon={<HistoryOutlined/>} disabled={!question||workspace.offline||locked} onClick={openHistory}>历史</Button>
        <Button icon={<BarChartOutlined/>} disabled={!question} onClick={()=>setProgressOpen(true)}>进度</Button>
        <Button icon={<SettingOutlined/>} onClick={()=>setSettingsOpen(true)}>设置</Button>
      </Space>
    </header>
    <div className="marking-notices">
      <ErrorNotice error={error||workspace.storageError||(workspace.offline?'':templates.error||assignments.error)} />
      {workspace.offline&&<Alert type="info" showIcon message="离线评阅：评分保存在本机，恢复连接后上传。"/>}
    </div>
    <div className="marking-context"><span title={origin}>{origin||'请选择阅卷任务'}{question&&` / 第 ${questionLabel(question)} 题`}{task?.grade_name&&` · ${task.grade_name}`}{task?.room_tags?.length?` · ${task.room_tags.map((t:Row)=>t.label||t.name).join('、')}`:''}</span>{task?.review_role==='arbitration'&&<Tag color="orange">仲裁</Tag>}{record?.status==='draft'&&saveState&&<Tag>{saveState}</Tag>}</div>

    {task&&question?<main className="marking-layout">
      <section className="marking-image-panel" aria-label="作答图像区">
        <div className="marking-image-toolbar"><strong>第 {questionLabel(question)} 题</strong><Space size={4}>
          <Button type="text" aria-label="缩小作答" icon={<ZoomOutOutlined/>} onClick={()=>{setZoom(z=>Math.max(.5,z-.25));refocusScore()}}/>
          <Button type="text" title="适应窗口" onClick={()=>{setZoom(1);setPan({x:0,y:0});refocusScore()}}>{Math.round(zoom*100)}%</Button>
          <Button type="text" aria-label="放大作答" icon={<ZoomInOutlined/>} onClick={()=>{setZoom(z=>Math.min(4,z+.25));refocusScore()}}/>
          <Checkbox checked={contrast>1} onChange={e=>{setContrast(e.target.checked?1.5:1);refocusScore()}}>优化显示</Checkbox>
        </Space></div>
        <div className="answer-viewport" onPointerDown={e=>{drag.current={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{const d=drag.current;if(d)setPan({x:d.px+e.clientX-d.x,y:d.py+e.clientY-d.y})}} onPointerUp={()=>{drag.current=null;refocusScore()}} onPointerCancel={()=>drag.current=null}>
          {record?<ReviewImage sheet={record.sheet} image={record.image} style={{transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`,filter:`contrast(${contrast})`}}/>:<Empty description="正在准备题图"/>}
        </div>
      </section>
      <aside className="marking-score-panel" aria-label="评分板">
        <div className="marking-score-heading"><strong>评分板</strong><span>{question.review_mode==='double'?'双评盲评':'单评'} · 满分 {question.points}</span>{task.regrading&&<Tag color="orange">重阅</Tag>}</div>
        <div className="marking-score-body">
          <div className="marking-score-entry" ref={scoreRef}>
            <label htmlFor="marking-score">给分 <span>Enter 提交</span></label>
            <Input id="marking-score" aria-label="给分" aria-describedby="marking-score-hint" aria-invalid={!!scoreError||skipWarn}
              readOnly={!editable} status={scoreError||skipWarn?'error':undefined} size="large" inputMode="decimal" autoComplete="off"
              value={scoreText} onChange={e=>editScore(e.target.value)} onPressEnter={e=>{e.preventDefault();if(!e.nativeEvent.isComposing&&!e.repeat)void submit()}}/>
            <div id="marking-score-hint" className={scoreError||skipWarn?'marking-score-hint error':'marking-score-hint'} role={scoreError||skipWarn?'alert':undefined}>{scoreError||(skipWarn?'再次点下一份可跳过当前作答':'输入分数或选择预设，然后按 Enter')}</div>
          </div>
          <div className="score-presets" aria-label="预设分值">{scorePresets(question.points,Math.max(step,question.step??.5)).filter(n=>!scoreInputError(String(n),question.points,question.step)).map(n=><Button key={n} type={value===n?'primary':'default'} disabled={!editable} onClick={()=>{editScore(String(n));refocusScore()}}>{n}</Button>)}</div>
          <Checkbox checked={automatic} onChange={e=>{setAutomatic(e.target.checked);refocusScore()}}>评分后自动下一份</Checkbox>
          <Button className="marking-submit" block type="primary" size="large" disabled={!editable} loading={action.pending==='score'} onClick={submit}>评分 / Enter</Button>
          <div className="marking-page-actions">
            <Button icon={<ArrowLeftOutlined/>} disabled={locked||workspace.offline||record?.status==='queued'||record?.status==='conflict'} loading={action.pending==='previous'} onClick={previous}>上一份</Button>
            <Button icon={<ArrowRightOutlined/>} disabled={published||locked||(workspace.offline&&editable)} loading={action.pending==='skip'} onClick={()=>record?.status==='draft'?skip():next()}>下一份</Button>
          </div>

        </div>
      </aside>
    </main>:<div className="marking-empty"><Empty description={published?'题卡成绩已发布':onExit?(busy||templateResource.loading?"正在加载作答":"当前没有可领取的作答"):"选择题目，进入阅卷"}>{onExit&&<Space>{published?<Button onClick={openHistory}>评分记录</Button>:<Button disabled={!question||locked||workspace.offline} onClick={next}>重新领取</Button>}<Button onClick={leave}>返回任务列表</Button></Space>}</Empty></div>}
    {osd&&<div className="score-osd" role="status">{osd.text}</div>}
    <footer className="marking-progress-footer">
      <div className="marking-progress-summary"><strong>我的进度 <b>{myCompleted}</b> / {myTotal} 份</strong><span>{Number(progress.data.my_progress||0).toFixed(0)}%</span></div>
      <Progress percent={progress.data.my_progress||0} showInfo={false} size="small"/>
      <div className="marking-session"><span>本次完成 {count} 份 · 平均 {count?(seconds/count).toFixed(1):'—'} 秒/份</span><Button size="small" type="text" icon={<ReloadOutlined/>} loading={progress.loading} disabled={!question||workspace.offline} onClick={progress.reload}>刷新进度</Button></div>
      <div ref={workspace.setQueueTarget} className="marking-queue-slot"/>
    </footer>
    <Drawer title="我的历史与回评" width={840} open={historyOpen} onClose={()=>setHistoryOpen(false)}>
      <ErrorNotice error={error}/><Table rowKey="id" dataSource={history} pagination={{defaultPageSize:50}} scroll={{x:700}} locale={{emptyText:'暂无历史评分'}} columns={[{title:'作答',dataIndex:'id',ellipsis:true},{title:'我的给分',dataIndex:'score'},{title:'实际给分',dataIndex:'final_score',render:v=>v??'待汇总'},{title:'评分时间',dataIndex:'created_at',render:v=>new Date(v*1000).toLocaleString()},{title:'操作',render:(_,row)=><Space><Button disabled={published||workspace.offline||locked||record?.status==='queued'||record?.status==='conflict'} loading={action.pending===`history:${row.id}`} onClick={()=>reviewHistory(row)}>回评</Button><Button disabled={published||workspace.offline||locked} onClick={()=>regradeFrom(row)}>从此处重阅</Button></Space>}]}/>
    </Drawer>
    <Drawer title="评阅进度" width={400} open={progressOpen} onClose={()=>setProgressOpen(false)}>
      <ErrorNotice error={progress.error}/><p>我的任务 {myCompleted} / {myTotal} 份</p><p>正在评阅 {progress.data.my_in_progress||0} · 待重阅 {progress.data.my_regrade_pending||0} · 本题作答 {progress.data.total_submissions||0}</p>
      <p>我的进度</p><Progress percent={progress.data.my_progress||0}/><p>本题全员进度</p><Progress percent={progress.data.question_progress||0}/><p>本卷全员进度</p><Progress percent={progress.data.paper_progress||0}/>
      <Button loading={progress.loading} disabled={workspace.offline} onClick={progress.reload}>刷新</Button>
    </Drawer>
    <Drawer title="阅卷设置" width={360} open={settingsOpen} onClose={()=>setSettingsOpen(false)}>
      <Space direction="vertical" size={20} style={{width:'100%'}}><label>评分步进 <InputNumber aria-label="评分步进" min={.01} max={10} value={step} onChange={n=>setStep(n||.5)}/></label><Typography.Text type="secondary">预设分值只填入给分框，按 Enter 或“评分”后提交。</Typography.Text>
      {task&&question&&<div className="marking-report-actions">{(['exception','excellent'] as const).map(kind=><Button size="small" type="text" key={kind} disabled={workspace.offline||locked} onClick={()=>Modal.confirm({title:kind==='exception'?'报告异常卷':'标记优秀卷',content:'将当前作答交由管理员查看。',afterClose:refocusScore,onOk:async()=>{await send(`/tasks/${task.id}/report`,{kind,reason:''});message.success('已报告')}})}>{kind==='exception'?'报告异常卷':'标记优秀卷'}</Button>)}</div>}
      {admin&&group&&subject&&project&&<Button href={examPath({projectId:project.id,subjectId:subject.id,gradeId:group.grade_id,groupId:group.id,section:'marking'})}>阅卷分配</Button>}</Space>
    </Drawer>
  </div>
}
