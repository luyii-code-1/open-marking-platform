import { DownOutlined } from '@ant-design/icons'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, App, Breadcrumb, Card, ConfigProvider, Descriptions, Drawer, Dropdown, Empty, Input, InputNumber, Modal, Radio, Select, Space, Steps, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import zhCN from 'antd/locale/zh_CN'
import { hasScannerHost, scannerCall, watchScanner } from './scanner-bridge'
import { uiTheme } from './uiTheme'
import { Brand } from './Brand'
import { cardName,subjectGrades,unassignedGrade } from './examNavigation'
import { rowNavigation } from './rowNavigation'
import {scannerRoomCounts} from './scannerRoomCounts'
import {scannerRoomState,type Paper,type ScanRun} from './scannerRoomPages'
import {ScanDesk} from './ScanDesk'
import {ScanChoices} from './ScanChoices'
import {ScanConnection} from './ScanConnection'
import {ScannerSettings} from './ScannerSettings'
import './scanner.css'

type Row = Record<string, any> & { id: string }
const statusLabels: Record<string, string> = { open: '正在扫描', frozen: '待核查', local_paired: '待上传', paired: '已上传确认', pending: '待上传', recognizing: '正在识别', uploaded: '已上传', blocked: '待核查', excluded: '已排除' }
function Status({ value }: { value: string }) { return <Tag color={value === 'blocked' || value === 'frozen' ? 'orange' : value === 'paired' || value === 'uploaded' ? 'green' : undefined}>{statusLabels[value] || value}</Tag> }

function Scanner() {
  const [state, setState] = useState<any>(null), [busyKey, setBusyKey] = useState(''), [error, setError] = useState(''), [connection, setConnection] = useState(false)
  const [inProject, setInProject] = useState(false), [subjectId, setSubject] = useState(''), [groupId, setGroup] = useState(''),[gradeId,setGrade]=useState(''), [batchId, setBatch] = useState(''), [page, setPage] = useState(1)
  const [firstSide,setFirstSide]=useState(localStorage.getItem('duplex-order-v2')||'front'), [side, setSide] = useState('front')
  const [deskPage,setDeskPage]=useState<Row|null>(null)
  const selectionRequest=useRef(0)
  const [preview, setPreview] = useState<Row | null>(null), [image, setImage] = useState(''), [question, setQuestion] = useState(''), [previewBusy, setPreviewBusy] = useState(false)
  const [deviceOpen,setDeviceOpen]=useState(false)
  const devicePrompt=useRef('')
  const [projectStatus,setProjectStatus]=useState('in_progress')
  const [newBatchOpen,setNewBatchOpen]=useState(false)
  const [newBatchName,setNewBatchName]=useState('')
  const [newBatchCount,setNewBatchCount]=useState<number|null>(null)
  const [batchCounts,setBatchCounts]=useState<Record<string,number>>(()=>{try{return JSON.parse(localStorage.getItem('omp-scan-batch-counts')||'{}')}catch{return {}}})
  function rememberBatchCount(id:string,count:number|null){
    if(!count||count<=0)return
    setBatchCounts(prev=>{const next={...prev,[id]:count};try{localStorage.setItem('omp-scan-batch-counts',JSON.stringify(next))}catch{};return next})
  }
  const { message, modal } = App.useApp()
  const [scanRun,setScanRun]=useState<(ScanRun&{groupId:string;room:string})|null>(null)
  const [scanView,setScanView]=useState<'run'|'room'>('room')
  const activeRun=useRef<ScanRun|undefined>(undefined)
  activeRun.current=scanView==='run'&&scanRun?scanRun:undefined
  const currentBatch = useRef(batchId), currentPage = useRef(page), reloadBusy = useRef(false), mounted = useRef(true)
  currentBatch.current = batchId; currentPage.current = page
  const reload = useCallback(async () => {
    if (reloadBusy.current || !hasScannerHost) return
    reloadBusy.current = true
    const requestedBatch=currentBatch.current,requestedPage=currentPage.current,requestedRun=activeRun.current
    try { const next = await scannerRoomState(scannerCall,requestedBatch,requestedPage,requestedRun); if (mounted.current&&requestedBatch===currentBatch.current&&requestedPage===currentPage.current&&requestedRun===activeRun.current) { setState(next); setError('') } }
    catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { reloadBusy.current = false }
  }, [])
  useEffect(() => {
    mounted.current = true; void reload(); let scheduled: ReturnType<typeof setTimeout> | undefined
    const stop = watchScanner(() => { if (scheduled) return; scheduled = setTimeout(() => { scheduled = undefined; void reload() }, 250) })
    const poll = setInterval(reload, 3000)
    return () => { mounted.current = false; stop(); clearInterval(poll); if (scheduled) clearTimeout(scheduled) }
  }, [reload])
  useEffect(() => { void reload() }, [batchId, page, scanView, scanRun, reload])
  const busy=!!busyKey, activeAction=useRef<symbol|null>(null)
  const actionKey=(method:string,args:Record<string,unknown>={})=>`${method}:${args.project_id||args.page_id||args.batch_id||args.group_id||''}`
  async function action(method: string, args: Record<string, unknown> = {}, completed?: (result: any) => void) {
    if(activeAction.current&&method!=='stop')return
    const token=Symbol(method);activeAction.current=token
    setBusyKey(actionKey(method,args)); setError('')
    try { const result = await scannerCall(method, args); completed?.(result); await reload(); return result }
    catch (e) { message.error((e as Error).message);await reload() }
    finally { if(activeAction.current===token){activeAction.current=null;setBusyKey('')} }
  }
  const prefs = state?.device_preferences, driver = prefs?.driver || "Twain", device = prefs?.device?.id || ""
  const pack = state?.package, subject = pack?.subjects.find((s: Row) => s.id === subjectId), group = pack?.groups.find((g: Row) => g.id === groupId), batch = state?.batches.find((b: Row) => b.id === batchId)
  const anonymous=group?.template?.statistics_sheet===true
  const sessionOpen=state?.session_open===true
  const deviceReady=!!device&&(driver!=='external'||prefs?.plugins?.some((p:Row)=>p.id===prefs.plugin_id&&p.available))
  useEffect(()=>{
    if(sessionOpen&&batchId&&!deviceReady&&devicePrompt.current!==batchId){devicePrompt.current=batchId;setDeviceOpen(true)}
  },[sessionOpen,batchId,deviceReady])
  const cached = new Map((state?.projects || []).map((p: Row) => [p.id, p]))
  const projects: Row[] = [...new Map([...(state?.projects || []), ...(state?.catalog.projects || [])].map((p: Row) => [p.id, p])).values()] as Row[]
  const filteredProjects=projects.filter(p=>projectStatus==='all'||(p.exam_status||'in_progress')===projectStatus)
  const grade=subject?subjectGrades(subject,pack?.groups||[]).find(g=>g.id===gradeId):undefined
  const roomKey=(row:Row)=>(row.room_tags||[]).map((t:Row)=>t.id).sort().join(',')
  const roomSheets:Row[]=batch?state.batches.filter((r:Row)=>r.group_id===batch.group_id&&roomKey(r)===roomKey(batch)):[]
  const runSheets=scanRun&&scanRun.groupId===groupId&&batch&&scanRun.room===roomKey(batch)?roomSheets.filter(r=>r.id===scanRun.anchorId||!scanRun.previousIds.includes(r.id)):[]
  const visibleSheets=scanView==='run'&&scanRun?runSheets:roomSheets
  const sumVisible=(key:string)=>visibleSheets.reduce((n,r)=>n+(r[key]||0),0)
  const pendingSheets=roomSheets.filter(r=>r.status==='local_paired')
  const needsReview=roomSheets.some(r=>r.status==='frozen'||r.status==='open'&&(r.pending||r.blocked||r.uploaded))
  const room=batch?.room_tags?.[0]&&pack?.room_tags?.find((r:Row)=>r.id===batch.room_tags[0].id)
  const readyToUpload=pendingSheets.length>0&&!needsReview&&!state?.capturing&&!state?.processing
  const currentCounts=scannerRoomCounts(state?.batches||[],groupId,room?.id||batch?.room_tags?.[0]?.id)
  const roomComplete=room?.expected_students>0&&(currentCounts.pending??0)+(room.confirmed_sheets??((room.scanned_students||0)+(room.confirmed_absent||0)))>=room.expected_students
  const [review,setReview]=useState<Row[]|null>(null),[answer,setAnswer]=useState<Row|null>(null)
  const [corrected,setCorrected]=useState(false)
  const [original,setOriginal]=useState(''),[sideIndex,setSideIndex]=useState(0),[originalError,setOriginalError]=useState('')
  const [number,setNumber]=useState(''),[absent,setAbsent]=useState<boolean|null>(null)
  const matchedName=(group?.roster||[]).find((r:Row)=>r.candidate_number===number)?.name
  const imageRequest=useRef(0)
  async function reviewRoom(){
    await action('roomReview',{batch_id:batchId},(rows:Row[])=>{
      const names=new Map<string,string>((group?.roster||[]).map((r:Row)=>[r.candidate_number,r.name]))
      setReview(rows.map(r=>({...r,name:names.get(r.candidate)||'未匹配'})))
    })
  }
  async function openOriginal(row:Row,index:number,view="corrected"){
    const request=++imageRequest.current
    if(answer?.id!==row.id){setNumber(row.candidate||'');setAbsent(row.absent??null)}
    setAnswer(row);setSideIndex(index);setOriginal('');setOriginalError('')
    try{
      const result=await scannerCall('originalPage',{batch_id:row.batch_id,page_id:row.sides[index].id,view})
      if(request===imageRequest.current){setOriginal(result.url);setCorrected(!!result.corrected)}
    }catch(e){if(request===imageRequest.current)setOriginalError((e as Error).message)}
  }
  async function saveAnswer(){
    if(!answer||!matchedName||absent===null)return
    const rows=await action('correctAnswer',{batch_id:answer.batch_id,page_id:answer.id,candidate_number:number,absent})
    if(!rows)return
    const names=new Map((group?.roster||[]).map((r:Row)=>[r.candidate_number,r.name]))
    if(review!==null)setReview(rows.map((r:Row)=>({...r,name:names.get(r.candidate)||'未匹配'})))
    const updated=rows.find((r:Row)=>r.id===answer.id)
    if(updated)setAnswer(current=>{
      if(!current||current.id!==updated.id||current.batch_id!==updated.batch_id)return current
      return {...updated,sides:current.sides.map((side:Row)=>updated.sides.find((r:Row)=>r.id===side.id)||side),name:names.get(updated.candidate)||'未匹配'}
    })
  }
  const locked = busy || !!state?.capturing || !!state?.syncing
  function enterProject(result: Row) {
    const statistics = result.package?.groups?.find((item: Row) => item.template?.statistics_sheet)
    setInProject(true)
    setSubject(statistics?.subject_id || '')
    setGrade(statistics ? statistics.grade_id || unassignedGrade : '')
    setGroup(statistics?.id || '')
    setBatch('')
  }
  async function openProject(id: string) { await action('openProject', { project_id: id }, enterProject) }
  function openSubject(id:string){setSubject(id);setGrade('');setGroup('');setBatch('')}
  async function createCountedBatch(customName?:string,expectedCount?:number|null){
    imageRequest.current++;selectionRequest.current++
    setScanView('room');setScanRun(null);setDeskPage(null);setAnswer(null)
    if(!group||!pack)return
    if(group.template.sides===2&&!firstSide){setDeviceOpen(true);message.warning('请在扫描设置中选择双面出图顺序，然后重新开始扫描');return}
    const existingCount=state.batches.filter((b:Row)=>b.group_id===group.id).length
    const baseLabel=(customName||'').trim()||`第 ${existingCount+1} 批`
    const fullName=expectedCount&&expectedCount>0?`${baseLabel}（${expectedCount}张）`:baseLabel
    const created=await action('createBatch',{group_id:group.id,name:fullName,room_tag_ids:[],capture_mode:group.template.sides===2?'duplex':'separate',first_side:firstSide},r=>{
      if(expectedCount&&expectedCount>0)rememberBatchCount(r.id,expectedCount)
      setBatch(r.id);setPage(1)
    })
    if(created){
      setNewBatchOpen(false)
      setNewBatchName('')
      setNewBatchCount(null)
    }
  }
  const expectedForBatch=(b?:Row)=>{
    if(!b)return null
    if(batchCounts[b.id])return batchCounts[b.id]
    const m=String(b.name||'').match(/（(\d+)张）/)
    return m?Number(m[1]):null
  }
  async function clearRoom(){
    const scope=batchId
    const impact=await action('clearRoom',{batch_id:scope})
    if(!impact)return
    modal.confirm({
      title:'清理本考场旧扫描数据？',
      content:`将删除本机该考场的 ${impact.pages} 面原图及识别结果，其中 ${impact.pending} 面尚未上传。清理后从空列表开始扫描。服务器已接收的数据继续保留。`,
      okText:'删除本地旧数据',okButtonProps:{danger:true},
      onOk:async()=>{
        const result=await scannerCall('clearRoom',{batch_id:scope,confirm:true,signature:impact.signature})
        if(!result?.cleared)return
        imageRequest.current++;selectionRequest.current++
        setScanRun(null);setScanView('room');setBatch('');setPage(1);setDeskPage(null);setAnswer(null)
        await reload()
        message.success(result.files_removed?'本地旧数据已清理，请选择考场开始新扫描':'记录已清理，部分占用文件将在下次清理时重试')
      },
    })
  }
  function clearSelection(){
    setState((prev:any)=>prev&&({...prev,pages:[],papers:[]}))
    imageRequest.current++;selectionRequest.current++
    setDeskPage(null);setAnswer(null);setOriginal('');setOriginalError('')
  }
  function changePage(next:number){
    if(next!==page){clearSelection();setPage(next)}
  }
  async function startScan(){
    if(!deviceReady){setDeviceOpen(true);return}
    if(state.scan_settings?.dpi!==300&&state.scan_settings?.dpi!==600){
      const updated=await action('scanSettings',{dpi:300,color:state.scan_settings?.color||'gray',jpeg_quality:state.scan_settings?.jpeg_quality})
      if(!updated)return
    }
    let id=batchId
    if(batch.status!=='open'||batch.total>0&&(batch.sides===1||batch.capture_mode==='duplex')){
      const next=await action('createBatch',{group_id:group.id,name:batch.name,room_tag_ids:batch.room_tags.map((t:Row)=>t.id),capture_mode:batch.capture_mode,first_side:firstSide})
      if(!next)return
      id=next.id;setBatch(id)
    }
    const started=await action('start',{batch_id:id,device_id:device,side})
    if(started){
      setScanRun({anchorId:id,previousIds:state.batches.map((r:Row)=>r.id),groupId,room:roomKey(batch)})
      setScanView('run');setPage(1)
    }
  }
  async function selectDeskPage(row:Row){
    const request=++selectionRequest.current
    imageRequest.current++
    setDeskPage(row);setAnswer(null);setOriginal('');setOriginalError('')
    try{
      const rows=await scannerCall<Row[]>('pageReview',{batch_id:row.batch_id||batchId})
      if(request!==selectionRequest.current)return
      const paper=state.papers?.find((p:Paper)=>p.front?.id===row.id||p.back?.id===row.id)
      const anchor=paper?.front||row
      const found=rows.find(r=>r.sides.some((side:Row)=>side.id===anchor.id))
      const names=new Map<string,string>((group?.roster||[]).map((r:Row)=>[r.candidate_number,r.name]))
      const record:Row=found?{...found,...(paper?{sides:[paper.front,paper.back].filter(Boolean),editable:!!paper.front&&found.editable}:{}),name:names.get(found.candidate)||'未匹配'}:{...row,batch_id:row.batch_id||batchId,editable:false,sides:[row]}
      await openOriginal(record,record.sides.findIndex((side:Row)=>side.id===row.id))
    }catch(e){if(request===selectionRequest.current)setOriginalError((e as Error).message)}
  }
  async function showPreview(row: Row, qid = '') {
    setPreview(row); setPreviewBusy(true); setImage(''); setQuestion(qid)
    try { const result = await scannerCall('preview', { batch_id: row.batch_id||batchId, page_id: row.id, question_id: qid }); setImage(result.url) }
    catch (e) { message.error((e as Error).message) }
    finally { setPreviewBusy(false) }
  }
  function exclude(row: Row) {
    modal.confirm({ title: batch.capture_mode === 'duplex' ? `排除第${row.sheet_number??row.sequence}张纸并整张重扫？` : `排除此${row.side === 'front' ? '正' : '背'}面？`, content: '已采集原图保留，已上传页面会在同步时排除。', okText: '排除并保留原图', okButtonProps: { danger: true }, onOk: () => action('exclude', { batch_id: row.batch_id||batchId, page_id: row.id }) })
  }
  const crumbs = [
    { title: <Button type="link" disabled={locked} onClick={() => setInProject(false)}>考试项目</Button> },
    ...(inProject && pack ? [{ title: <Button type="link" disabled={locked} onClick={() => enterProject({ id: pack.project.id, package: pack })}>{pack.project.name}</Button> }] : []),
    ...(inProject && subject ? [{ title: <Button type="link" disabled={locked} onClick={() => { setGrade('');setGroup(''); setBatch('') }}>{subject.name}</Button> }] : []),
    ...(inProject&&grade?[{title:<Button type="link" disabled={locked} onClick={()=>{setGroup('');setBatch('')}}>{grade.name}</Button>}]:[]),
    ...(inProject && group ? [{ title: <Button type="link" disabled={locked} onClick={() => setBatch('')}>{cardName(group,subject)}</Button> }] : []),
    ...(inProject && batch ? [{ title: batch.name || `批次 ${batch.id.slice(0,8)}` }] : []),
  ]
  if(state&&(!state.device_preferences||typeof state.session_open!=='boolean'))return <main className="scanner-unavailable"><Typography.Title level={3}>请更新扫描客户端</Typography.Title><p>从管理后台的扫描台下载安装包后重新打开。</p><Button onClick={()=>action('offlinePage')}>打开已安装版本的本地页面</Button></main>
  if (!hasScannerHost) return <main className="scanner-unavailable"><Typography.Title level={3}>扫描工作台</Typography.Title><Typography.Paragraph>请在扫描客户端打开此页面。可在管理后台的「扫描台」下载安装包，并连接本机扫描端。</Typography.Paragraph><a href="/#/scanner">打开管理后台扫描台</a></main>
  const currentBatchExpected=expectedForBatch(batch)
  const currentBatchFront=sumVisible('front_count')
  return <div className="scanner-app">
    <header className="scanner-header"><Space size={16}><Brand /><Typography.Title level={4}>扫描工作台</Typography.Title></Space><Space size={12}>{sessionOpen&&<Button onClick={()=>setDeviceOpen(true)} disabled={locked}>扫描设置</Button>}<Tag color={state?.online ? 'green' : undefined}>{!sessionOpen?'待连接':state?.online?'已连接':'离线'}</Tag>{sessionOpen&&<Dropdown menu={{ items: [
      { key: 'connect', label: '切换服务器', disabled: locked, onClick: () => { setConnection(true) } },
      { key: 'online', label: '打开管理网页', disabled: !state?.server_url || locked, onClick: () => action('onlinePage') },
      { key: 'offline', label: '打开离线页面', disabled: locked, onClick: () => action('offlinePage') },
    ] }}><Button icon={<DownOutlined />} iconPosition="end">连接设置</Button></Dropdown>}</Space></header>
    <main className="scanner-content">{sessionOpen&&<><Breadcrumb items={crumbs} /><Steps className="scan-workflow-steps" size="small" current={!batch?0:state.capturing||state.processing||!roomSheets.some(r=>r.total>0)?1:roomSheets.every(r=>r.status==='paired'||!r.total)?3:2}
        items={[{title:'选择考试与批次'},{title:'放好答题卡，开始扫描'},{title:'核对并上传'}]}/></>}
      {sessionOpen&&!state?.online && <Typography.Paragraph className="scanner-offline" type="secondary">已下载的项目可继续扫描，答卷保存在本机。</Typography.Paragraph>}
      {error && <Alert type="error" message={error} />}
      {!state ? <Card loading /> : !sessionOpen ? <ScanConnection servers={state.servers||[state.server_url].filter(Boolean)} server={state.server_url} busy={busy} defaultServer={state.default_server_url} cachedServers={state.cached_servers||(state.projects.length?[state.server_url]:[])} onDefault={server_url=>{void action('setDefaultServer',{server_url})}} onConnect={values=>{void action('connect',values,()=>setInProject(false))}} onOffline={server_url=>{void action('enterOffline',{server_url},()=>setInProject(false))}}/> : !inProject || !pack ? <ScanChoices title="选择考试项目" description="选择本次考试，然后依次选择科目、年级和题卡开始分批扫描。" extra={<Space wrap><Radio.Group value={projectStatus} onChange={e=>setProjectStatus(e.target.value)} optionType="button" options={[{value:'in_progress',label:'进行中'},{value:'completed',label:'已完成'},{value:'all',label:'全部'}]}/><Button loading={busyKey===actionKey('refreshCatalog')} disabled={locked||!state.online} onClick={()=>action('refreshCatalog')}>刷新项目</Button></Space>} items={filteredProjects.map(row=>({
          id:row.id,name:row.name,disabled:locked||!cached.has(row.id),status:<Tag color={row.exam_status==='completed'?'default':'blue'}>{row.exam_status==='completed'?'已完成':'进行中'}</Tag>,
          description:cached.has(row.id)?'考试资料已下载，可离线扫描':'连接服务器下载后即可扫描',
          action:<Button block loading={busyKey===actionKey('downloadProject',{project_id:row.id})} disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:row.id},enterProject)}>{cached.has(row.id)?'更新项目资料':'下载并进入项目'}</Button>
        }))} onOpen={id=>void openProject(id)}/>
        : !subject && pack.project.category==='statistics' ? <Card title={pack.project.name}><Space>
          <Typography.Text>发布统计题卡后可开始扫描。</Typography.Text><Button disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:pack.project.id},enterProject)}>刷新题卡</Button>
        </Space></Card>
        : !subject ? <ScanChoices title={pack.project.name} description="选择扫描科目" items={pack.subjects.map((row:Row)=>({id:row.id,name:row.name,disabled:locked,facts:[{label:'可扫描年级',value:subjectGrades(row,pack.groups).filter(g=>g.count).length},{label:'题卡',value:pack.groups.filter((g:Row)=>g.subject_id===row.id).length}]}))} onOpen={openSubject} extra={<Button disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:pack.project.id})}>更新考试资料</Button>}/>
        : !grade ? <ScanChoices title={subject.name} description="选择年级" items={subjectGrades(subject,pack.groups).filter(g=>g.count).map(row=>({id:row.id,name:row.name,disabled:locked,facts:[{label:'题卡',value:row.count}]}))} onOpen={id=>{setGrade(id);setGroup('');setBatch('')}}/>
        : !group ? <ScanChoices title={grade.name} description="选择本次使用的题卡" items={pack.groups.filter((g:Row)=>g.subject_id===subject.id&&(g.grade_id||unassignedGrade)===gradeId).map((row:Row)=>({id:row.id,name:cardName(row,subject),description:row.template.paper+' · '+(row.template.sides===2?'双面':'单面'),status:<Tag>{row.frozen?'成绩已发布':'可扫描'}</Tag>,disabled:locked||row.frozen}))} onOpen={id=>{setGroup(id);setBatch('')}}/>
          : !batch ? <section className="scanner-section"><div className="scanner-title"><div><Typography.Title level={2}>{cardName(group,subject)}</Typography.Title><Typography.Text type="secondary">{group.grade_name&&`${group.grade_name} · `}{group.template.name} · {group.template.paper} · {group.template.sides === 2 ? '双面' : '单面'}</Typography.Text></div><Space wrap><Button type="primary" disabled={locked||group.frozen} onClick={()=>{setNewBatchName(`第 ${state.batches.filter((b:Row)=>b.group_id===group.id).length+1} 批`);setNewBatchCount(null);setNewBatchOpen(true)}}>新建扫描批次</Button><Button disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:pack.project.id})}>刷新进度</Button></Space></div>
          <Card size="small" style={{marginBottom:16}}><Space wrap align="center">
            <Typography.Text strong>快速新建批次：</Typography.Text>
            <Input style={{width:160}} placeholder="批次名（如 第1批）" value={newBatchName} onChange={e=>setNewBatchName(e.target.value)}/>
            <InputNumber min={1} max={10000} precision={0} style={{width:170}} placeholder="预计张数（如 37）" addonAfter="张" value={newBatchCount} onChange={v=>setNewBatchCount(typeof v==='number'?v:null)}/>
            <Button type="primary" disabled={locked||group.frozen} onClick={()=>void createCountedBatch(newBatchName,newBatchCount)}>新建并进入扫描</Button>
          </Space></Card>
          <ScanChoices title="已有扫描批次" description="点击已有批次继续扫描或核对，或点击上方「新建扫描批次」开始新一叠。" items={state.batches.filter((b:Row)=>b.group_id===group.id).map((row:Row)=>{
            const exp=expectedForBatch(row)
            const scannedSheets=row.front_count??(row.sides===2?Math.ceil((row.total||0)/2):(row.total||0))
            return {id:row.id,name:row.name||`批次 ${row.id.slice(0,8)}`,disabled:locked||group.frozen,status:<Status value={row.status}/>,
              facts:[{label:'批次计数',value:exp?`${scannedSheets} / ${exp} 张`:`${scannedSheets} 张`},{label:'待核对',value:row.blocked||0},{label:'待上传',value:row.pending||0}]}
          })} onOpen={id=>{setScanView('room');setScanRun(null);setBatch(id);setPage(1)}}/>
          <Typography.Paragraph type="secondary">本题卡服务器已确认 {group.confirmed_sheets??group.confirmed_students??0} 份 · 统计以上次刷新为准</Typography.Paragraph>
          </section>
            : <ScanDesk rows={state.pages} papers={state.papers||[]} total={state.paper_total||0} page={page} onPage={changePage}
                selected={state.pages.find((r:Row)=>r.id===deskPage?.id)||deskPage}
                onSelect={selectDeskPage} capturing={state.capturing} syncing={state.syncing} processing={state.processing} processingRemaining={state.processing_remaining||0} needsReview={needsReview} uploaded={roomSheets.some(r=>r.total>0)&&roomSheets.every(r=>r.status==='paired'||!r.total)}
                context={<div><h2>{batch.name||`批次 ${batch.id.slice(0,8)}`}{currentBatchExpected?<Tag color={currentBatchFront===currentBatchExpected?'green':'blue'} style={{marginLeft:8}}>计数 {currentBatchFront} / {currentBatchExpected} 张</Tag>:null}</h2><span>{pack.project.name} · {subject.name} · {group.grade_name} · {cardName(group,subject)} · {batch.paper} {batch.sides===2?'双面':'单面'}</span></div>}
                stats={[{label:'本批计数',value:currentBatchExpected?`${currentBatchFront} / ${currentBatchExpected} 张`:`${currentBatchFront} 张`},{label:'正面',value:sumVisible('front_count')+' 面'},{label:'背面',value:sumVisible('back_count')+' 面'},{label:'待核对',value:sumVisible('blocked')+' 面'},{label:'待上传',value:sumVisible('pending')+' 面'},{label:'已上传',value:sumVisible('uploaded')+' 面'}]}
                scope={<Radio.Group value={scanView} onChange={e=>{clearSelection();setScanView(e.target.value);setPage(1)}} optionType="button" options={[{label:'本次扫描',value:'run',disabled:!scanRun},{label:'本批全部',value:'room'}]}/>}
                actions={<>
              <Button size="large" type="primary" loading={busyKey===actionKey('start',{batch_id:batchId})} disabled={locked || group.frozen} onClick={startScan}>开始扫描</Button><Button danger loading={busyKey===actionKey('stop')} disabled={!state.capturing} onClick={() => action('stop')}>停止扫描</Button>
              <Dropdown menu={{items:[
                {key:'round',label:'新建下一批次（可设张数）',disabled:locked||state.processing,onClick:()=>{
                  setNewBatchName(`第 ${state.batches.filter((b:Row)=>b.group_id===group.id).length+1} 批`)
                  setNewBatchCount(null)
                  setNewBatchOpen(true)
                }},
                {key:'import',label:'从文件导入答题卡',disabled:locked||batch.status!=='open',onClick:()=>action('import',{batch_id:batchId,side})},
                {key:'refresh',label:'刷新上传结果',disabled:locked||!state.online,onClick:()=>action('refreshBatch',{batch_id:batchId})},
                {type:'divider'},
                {key:'clear',label:'清理本批旧数据',danger:true,disabled:locked||state.processing,onClick:clearRoom},
              ]}}><Button icon={<DownOutlined/>} iconPosition="end" disabled={locked}>更多操作</Button></Dropdown>
                </>}
                settings={<div className="scan-device-summary"><strong>{state.scan_settings?.dpi===600?'高清 · 600 DPI（较慢）':'标清 · 300 DPI'}</strong><span>{prefs?.device?.name||'尚未选择扫描仪'}</span><Button block disabled={locked} onClick={()=>setDeviceOpen(true)}>调整扫描设置</Button></div>}
                feedback={<>{batch.error&&<Alert type="warning" message={batch.error}/>}<Typography.Paragraph>{state.message||'将答题卡放入进纸口，再点击“开始扫描”。'}</Typography.Paragraph>{!device&&<Typography.Text type="warning">请先打开扫描设置，选择扫描仪</Typography.Text>}</>}
                upload={<><Typography.Paragraph>待上传 <strong>{currentCounts.pending??pendingSheets.length}</strong> 份</Typography.Paragraph><Typography.Text type="secondary">{needsReview?'请先处理待核对答卷':'答卷先保存在本机，核对后点击上传'}</Typography.Text><Button type="primary" block disabled={locked||!roomSheets.some(r=>r.total>0)} onClick={reviewRoom}>{anonymous?'核对答卷并上传':'查看名单并上传'}</Button>{state.syncing&&<Typography.Paragraph role="status">正在上传 · 已上传 {roomSheets.reduce((n,r)=>n+r.uploaded,0)} 面</Typography.Paragraph>}{!state.syncing&&roomSheets.some(r=>r.total>0)&&roomSheets.every(r=>r.status==='paired'||!r.total)&&<Alert type="success" message="已扫答卷均已上传确认"/>}</>}
                imageTools={answer?<Space wrap>{answer.sides.map((r:Row,index:number)=><Button key={r.id} type={index===sideIndex?'primary':'default'} onClick={()=>{setDeskPage(state.pages.find((p:Row)=>p.id===r.id)||{...deskPage,...r});void openOriginal(answer,index)}}>{r.side==='front'?'正面':'背面'}</Button>)}<Button onClick={()=>openOriginal(answer,sideIndex,corrected?'original':'corrected')}>{corrected?'查看扫描原图':'查看校正图'}</Button></Space>:null}
                image={originalError?<Alert type="error" message={originalError}/>:original?<img src={original} alt={corrected?'自动校正图':'扫描原图'}/>:<Card loading/>}
                editor={answer&&!anonymous?<div className="scan-identity-editor"><label>准考证号<Input value={number} inputMode="numeric" disabled={!answer.editable||locked||state.processing||state.batches.find((r:Row)=>r.id===answer.batch_id)?.status==='paired'} onChange={e=>setNumber(e.target.value.trim())}/></label><div><span>姓名</span><strong>{matchedName||'未匹配'}</strong></div><label>缺考标记<Select aria-label="核对缺考标记" disabled={!answer.editable||locked||state.processing} value={absent===null?undefined:String(absent)} placeholder="待核对" options={[{value:'false',label:'未标缺考'},{value:'true',label:'缺考'}]} onChange={v=>setAbsent(v==='true')}/></label>{answer.editable&&<Button type="primary" disabled={locked||state.processing||!matchedName||absent===null||state.batches.find((r:Row)=>r.id===answer.batch_id)?.status==='paired'} onClick={saveAnswer}>保存更正</Button>}</div>:null}
                pageActions={deskPage?<div className="scan-operation-buttons">{deskPage.error&&<Alert type="warning" message={deskPage.error}/>}<Status value={deskPage.status}/>{deskPage.local_cut_available&&<Button onClick={()=>showPreview(deskPage)}>查看切题</Button>}<Button disabled={locked||state.processing||deskPage.status==='uploaded'||deskPage.status==='excluded'} onClick={()=>action('retryPage',{batch_id:deskPage.batch_id||batchId,page_id:deskPage.id})}>重新识别</Button><Button danger disabled={locked||state.processing||deskPage.status==='uploaded'||deskPage.status==='excluded'} onClick={()=>exclude(deskPage)}>排除并重扫</Button>{deskPage.status==='blocked'&&<Button disabled={locked||!state.online} onClick={()=>modal.confirm({title:'上传这张原图供核查？',onOk:()=>action('sendForReview',{batch_id:deskPage.batch_id||batchId,page_id:deskPage.id})})}>上传原图供核查</Button>}</div>:null}
              />}
    </main>
    {state&&<><Modal title="新建扫描批次" open={newBatchOpen} onCancel={()=>setNewBatchOpen(false)} onOk={()=>void createCountedBatch(newBatchName,newBatchCount)} okText="新建并进入">
      <Space direction="vertical" size={12} style={{width:'100%'}}>
        <Input placeholder="批次名称（如 第1批）" value={newBatchName} onChange={e=>setNewBatchName(e.target.value)}/>
        <InputNumber min={1} max={10000} precision={0} style={{width:'100%'}} placeholder="预计扫描张数（如 37，留空不限）" addonAfter="张" value={newBatchCount} onChange={v=>setNewBatchCount(typeof v==='number'?v:null)}/>
      </Space>
    </Modal>
    <Drawer title={`${batch?.name||'当前批次'} · 已扫答卷`} open={review!==null} onClose={()=>setReview(null)} width="min(850px,95vw)" footer={<Button type="primary" disabled={!readyToUpload||!state.online||locked||!review?.some(r=>r.status==='local_paired')} onClick={()=>action('upload',{batch_id:batchId},()=>setReview(null))}>核对完毕，上传 {currentCounts.pending??pendingSheets.length} 份</Button>}>
      <Table<Row> rowKey="id" dataSource={review||[]} onRow={r=>rowNavigation(()=>{setReview(null);void selectDeskPage(state.pages.find((p:Row)=>p.id===r.sides[0].id)||{...r.sides[0],batch_id:r.batch_id,candidate:r.candidate})},r.candidate||'扫描原图')} columns={[
        ...(anonymous?[{title:'采集序号',render:(_:unknown,row:Row)=>row.sides[0]?.sequence}]:[
          {title:'准考证号',dataIndex:'candidate',render:(v:string)=>v||'未识别'},
          {title:'姓名',dataIndex:'name'},
          {title:'缺考标记',dataIndex:'absent',render:(v:boolean|null)=>v==null?'请核对原图':v?'已填涂':'未填涂'},
        ]),
        {title:'状态',dataIndex:'status',render:v=><Status value={v}/>}
      ]}/>
    </Drawer>
    <Drawer title={`${anonymous?'统计答卷':([answer?.name,answer?.candidate].filter(Boolean).join(' ')||'答卷')}核对`} open={!!answer&&!deskPage} onClose={()=>{imageRequest.current++;setAnswer(null);setOriginal('')}} width="min(1000px,96vw)">
      {answer&&<Space direction="vertical" style={{width:'100%'}}><Space>{answer.sides.map((s:Row,i:number)=><Button key={s.id} type={i===sideIndex?'primary':'default'} onClick={()=>openOriginal(answer,i)}>{s.side==='front'?'正面':'背面'}</Button>)}</Space>
      {answer.editable&&<Space wrap align="end">
        <label>准考证号<Input value={number} inputMode="numeric" onChange={e=>setNumber(e.target.value.trim())}/></label>
        <div>姓名<div>{matchedName||'未匹配'}</div></div>
        <label>缺考标记<Select aria-label="缺考标记" value={absent===null?undefined:String(absent)} placeholder="请核对" options={[{value:'true',label:'缺考'},{value:'false',label:'未标缺考'}]} onChange={v=>setAbsent(v==='true')}/></label>
        <Button type="primary" disabled={locked||state.processing||!matchedName||absent===null} onClick={saveAnswer}>确认更正</Button>
      </Space>}
      {original&&<Space><Tag>{corrected?'自动校正图':'扫描原图'}</Tag><Button onClick={()=>openOriginal(answer,sideIndex,corrected?'original':'corrected')}>{corrected?'查看扫描原图':'查看校正图'}</Button></Space>}
      {originalError?<Alert type="error" message={originalError}/>:original?<img className="scanner-preview" src={original} alt={corrected?"自动校正图":"扫描原图"}/>:<Card loading/>}</Space>}
    </Drawer>
    <Drawer title="扫描设置" open={deviceOpen} onClose={()=>setDeviceOpen(false)} width="min(480px,94vw)" footer={<Button type="primary" block disabled={!deviceReady||busy} onClick={()=>setDeviceOpen(false)}>完成设置</Button>}>
      <ScannerSettings state={state} active={deviceOpen} locked={locked} discovering={busyKey===actionKey('devices')} firstSide={firstSide}
        estimateContext={inProject && group ? { paper: group.template.paper === 'A3' ? 'A3' : 'A4', batch_id: batch?.id, group_id: group.id, template_id: group.template.id } : { paper: 'A4' }}
        manualSide={batch&&batch.capture_mode!=='duplex'&&batch.sides===2?side:undefined} onManualSide={setSide}
        onFirstSide={value=>{setFirstSide(value);localStorage.setItem('duplex-order-v2',value)}} action={action}/>
    </Drawer>
    <Drawer title="切换服务器" open={connection} onClose={()=>setConnection(false)} width="min(520px,96vw)">
      <ScanConnection servers={state.servers||[]} server={state.server_url} defaultServer={state.default_server_url}
        cachedServers={state.cached_servers||(state.projects.length?[state.server_url]:[])} busy={busy}
        onDefault={server_url=>{void action('setDefaultServer',{server_url})}}
        onOffline={server_url=>{void action('enterOffline',{server_url},()=>{setConnection(false);setInProject(false);setBatch('')})}}
        onConnect={values=>{void action('connect',values,()=>{setConnection(false);setInProject(false);setSubject('');setGrade('');setGroup('');setBatch('')})}}/>
    </Drawer>
    <Drawer title={preview ? `第${preview.sheet_number??preview.sequence}张 · ${preview.side === 'front' ? '正面' : '背面'}` : '页面核查'} open={!!preview} onClose={() => { setPreview(null); setImage('') }} width="min(880px,90vw)">
      {preview && <><Descriptions column={2} items={[...(!anonymous?[{ label: '考号', children: preview.candidate || '—' }]:[]), { label: '状态', children: <Status value={preview.status} /> }]} /><Select aria-label="查看整页或切题" value={question} style={{ width: '100%', margin: '20px 0' }} onChange={value => showPreview(preview, value)} options={[{ value: '', label: '整页原图' }, ...(preview.local_cut_available ? (group?.template.questions || []) : []).filter((q: Row) => q.regions.some((r: any) => r.page === (preview.side === 'front' ? 1 : 2))).map((q: Row) => ({ value: q.id, label: `第${q.number}题 · 本地切题` }))]} />{preview.error && <Alert type="warning" message={preview.error} />}{previewBusy ? <Card loading /> : image && <img className="scanner-preview" src={image} alt={question ? '本地切题预览' : '扫描原图预览'} />}</>}
    </Drawer></>}
  </div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider locale={zhCN} theme={uiTheme}><App><Scanner /></App></ConfigProvider></React.StrictMode>)
