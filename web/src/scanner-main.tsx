import { DownOutlined } from '@ant-design/icons'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, App, Breadcrumb, Card, ConfigProvider, Descriptions, Drawer, Dropdown, Empty, Input, Modal, Radio, Select, Space, Steps, Tag, Typography } from 'antd'
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
  async function openProject(id: string) { await action('openProject', { project_id: id }, () => { setInProject(true); setSubject(''); setGrade('');setGroup(''); setBatch('') }) }
  function openSubject(id:string){setSubject(id);setGrade('');setGroup('');setBatch('')}
  async function enterRoom(room?:Row){
    imageRequest.current++;selectionRequest.current++
    setScanView('room');setScanRun(null);setDeskPage(null);setAnswer(null)
    if(!group||!pack)return
    const roomId=room?.id
    const matches=state.batches.filter((b:Row)=>b.group_id===group.id&&roomKey(b)===(roomId||''))
    const local=matches.find((b:Row)=>b.status==='open')||matches.find((b:Row)=>b.status==='frozen')
    if(local){setBatch(local.id);setPage(1);return}
    if(group.template.sides===2&&!firstSide){setDeviceOpen(true);message.warning('请在扫描设置中选择双面出图顺序，然后重新开始扫描');return}
    await action('createBatch',{group_id:group.id,name:room?.name||'未指定考场',room_tag_ids:roomId?[roomId]:[],capture_mode:group.template.sides===2?'duplex':'separate',first_side:firstSide},r=>{setBatch(r.id);setPage(1)})
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
    ...(inProject && pack ? [{ title: <Button type="link" disabled={locked} onClick={() => { setSubject(''); setGrade('');setGroup(''); setBatch('') }}>{pack.project.name}</Button> }] : []),
    ...(inProject && subject ? [{ title: <Button type="link" disabled={locked} onClick={() => { setGrade('');setGroup(''); setBatch('') }}>{subject.name}</Button> }] : []),
    ...(inProject&&grade?[{title:<Button type="link" disabled={locked} onClick={()=>{setGroup('');setBatch('')}}>{grade.name}</Button>}]:[]),
    ...(inProject && group ? [{ title: <Button type="link" disabled={locked} onClick={() => setBatch('')}>{cardName(group,subject)}</Button> }] : []),
    ...(inProject && batch ? [{ title: batch.room_tags?.[0]?.name||'未指定考场' }] : []),
  ]
  if(state&&(!state.device_preferences||typeof state.session_open!=='boolean'))return <main className="scanner-unavailable"><Typography.Title level={3}>请更新扫描客户端</Typography.Title><p>从管理后台的扫描台下载安装包后重新打开。</p><Button onClick={()=>action('offlinePage')}>打开已安装版本的本地页面</Button></main>
  if (!hasScannerHost) return <main className="scanner-unavailable"><Typography.Title level={3}>扫描工作台</Typography.Title><Typography.Paragraph>请在扫描客户端打开此页面。可在管理后台的「扫描台」下载安装包，并连接本机扫描端。</Typography.Paragraph><a href="/#/scanner">打开管理后台扫描台</a></main>
  return <div className="scanner-app">
    <header className="scanner-header"><Space size={16}><Brand /><Typography.Title level={4}>扫描工作台</Typography.Title></Space><Space size={12}>{sessionOpen&&<Button onClick={()=>setDeviceOpen(true)} disabled={locked}>扫描设置</Button>}<Tag color={state?.online ? 'green' : undefined}>{!sessionOpen?'待连接':state?.online?'已连接':'离线'}</Tag>{sessionOpen&&<Dropdown menu={{ items: [
      { key: 'connect', label: '切换服务器', disabled: locked, onClick: () => { setConnection(true) } },
      { key: 'online', label: '打开管理网页', disabled: !state?.server_url || locked, onClick: () => action('onlinePage') },
      { key: 'offline', label: '打开离线页面', disabled: locked, onClick: () => action('offlinePage') },
    ] }}><Button icon={<DownOutlined />} iconPosition="end">连接设置</Button></Dropdown>}</Space></header>
    <main className="scanner-content">{sessionOpen&&<><Breadcrumb items={crumbs} /><Steps className="scan-workflow-steps" size="small" current={!batch?0:state.capturing||state.processing||!roomSheets.some(r=>r.total>0)?1:roomSheets.every(r=>r.status==='paired'||!r.total)?3:2}
        items={[{title:'选择考试和考场'},{title:'放好答题卡，开始扫描'},{title:'核对并上传'}]}/></>}
      {sessionOpen&&!state?.online && <Typography.Paragraph className="scanner-offline" type="secondary">已下载的项目可继续扫描，答卷保存在本机。</Typography.Paragraph>}
      {error && <Alert type="error" message={error} />}
      {!state ? <Card loading /> : !sessionOpen ? <ScanConnection servers={state.servers||[state.server_url].filter(Boolean)} server={state.server_url} busy={busy} defaultServer={state.default_server_url} cachedServers={state.cached_servers||(state.projects.length?[state.server_url]:[])} onDefault={server_url=>{void action('setDefaultServer',{server_url})}} onConnect={values=>{void action('connect',values,()=>setInProject(false))}} onOffline={server_url=>{void action('enterOffline',{server_url},()=>setInProject(false))}}/> : !inProject || !pack ? <ScanChoices title="选择考试项目" description="选择本次考试，然后依次选择科目、年级和考场。" extra={<Space wrap><Radio.Group value={projectStatus} onChange={e=>setProjectStatus(e.target.value)} optionType="button" options={[{value:'in_progress',label:'进行中'},{value:'completed',label:'已完成'},{value:'all',label:'全部'}]}/><Button loading={busyKey===actionKey('refreshCatalog')} disabled={locked||!state.online} onClick={()=>action('refreshCatalog')}>刷新项目</Button></Space>} items={filteredProjects.map(row=>({
          id:row.id,name:row.name,disabled:locked||!cached.has(row.id),status:<Tag color={row.exam_status==='completed'?'default':'blue'}>{row.exam_status==='completed'?'已完成':'进行中'}</Tag>,
          description:cached.has(row.id)?'考试资料已下载，可离线扫描':'连接服务器下载后即可扫描',
          action:<Button block loading={busyKey===actionKey('downloadProject',{project_id:row.id})} disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:row.id},()=>{setInProject(true);setSubject('');setGrade('');setGroup('');setBatch('')})}>{cached.has(row.id)?'更新考试资料':'下载并进入考试'}</Button>
        }))} onOpen={id=>void openProject(id)}/>
        : !subject ? <ScanChoices title={pack.project.name} description="选择扫描科目" items={pack.subjects.map((row:Row)=>({id:row.id,name:row.name,disabled:locked,facts:[{label:'可扫描年级',value:subjectGrades(row,pack.groups).filter(g=>g.count).length},{label:'题卡',value:pack.groups.filter((g:Row)=>g.subject_id===row.id).length}]}))} onOpen={openSubject} extra={<Button disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:pack.project.id})}>更新考试资料</Button>}/>
        : !grade ? <ScanChoices title={subject.name} description="选择年级" items={subjectGrades(subject,pack.groups).filter(g=>g.count).map(row=>({id:row.id,name:row.name,disabled:locked,facts:[{label:'题卡',value:row.count}]}))} onOpen={id=>{setGrade(id);setGroup('');setBatch('')}}/>
        : !group ? <ScanChoices title={grade.name} description="选择本次使用的题卡" items={pack.groups.filter((g:Row)=>g.subject_id===subject.id&&(g.grade_id||unassignedGrade)===gradeId).map((row:Row)=>({id:row.id,name:cardName(row,subject),description:row.template.paper+' · '+(row.template.sides===2?'双面':'单面'),status:<Tag>{row.frozen?'成绩已发布':'可扫描'}</Tag>,disabled:locked||row.frozen}))} onOpen={id=>{setGroup(id);setBatch('')}}/>
          : !batch ? <section className="scanner-section"><div className="scanner-title"><div><Typography.Title level={2}>{cardName(group,subject)}</Typography.Title><Typography.Text type="secondary">{group.grade_name&&`${group.grade_name} · `}{group.template.name} · {group.template.paper} · {group.template.sides === 2 ? '双面' : '单面'}</Typography.Text></div></div>

          <ScanChoices title="选择考场" description="点击考场进入工作台，也可以直接使用未指定考场。" items={[...(pack.room_tags||[]).filter((t:Row)=>t.group_id===group.id&&!t.archived),{id:'',name:'未指定考场',confirmed_sheets:group.unassigned_sheets??0}].map((row:Row)=>{
            const counts=scannerRoomCounts(state.batches,group.id,row.id)
            const exceptions=state.batches.some((b:Row)=>b.group_id===group.id&&roomKey(b)===row.id&&(b.blocked||b.status==='frozen'))
            const confirmed=row.confirmed_sheets??((row.scanned_students||0)+(row.confirmed_absent||0))
            return {id:row.id,name:row.name,disabled:locked||group.frozen,status:<Tag color={exceptions?'orange':confirmed>0?'green':undefined}>{exceptions?'待核对':counts.pending?'待上传':confirmed>0?'已上传':'待扫描'}</Tag>,
              facts:[{label:'预期份数',value:row.expected_students??'—'},{label:'本机已扫',value:counts.scanned??'—'},{label:'已上传确认',value:confirmed}]}
          })} onOpen={id=>void enterRoom((pack.room_tags||[]).find((r:Row)=>r.id===id))}/>
          <Typography.Paragraph type="secondary">题卡共确认 {group.confirmed_sheets??group.confirmed_students??0} 份 · 服务器统计以上次刷新为准</Typography.Paragraph>
          <Button disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:pack.project.id})}>刷新考场进度</Button>
          {state.batches.some((b:Row)=>b.group_id===group.id&&(b.blocked||b.status==='frozen'))&&<Table<Row> rowKey="id" dataSource={state.batches.filter((b:Row)=>b.group_id===group.id&&(b.blocked||b.status==='frozen'))} columns={[{title:'待核对',dataIndex:'name'},{title:'原因',dataIndex:'error'},{title:'操作',render:(_,r)=><Button onClick={()=>{setScanView('room');setScanRun(null);setBatch(r.id)}}>查看原图</Button>}]}/>}</section>
            : <ScanDesk rows={state.pages} papers={state.papers||[]} total={state.paper_total||0} page={page} onPage={changePage}
                selected={state.pages.find((r:Row)=>r.id===deskPage?.id)||deskPage}
                onSelect={selectDeskPage} capturing={state.capturing} syncing={state.syncing} processing={state.processing} processingRemaining={state.processing_remaining||0} needsReview={needsReview} uploaded={roomSheets.some(r=>r.total>0)&&roomSheets.every(r=>r.status==='paired'||!r.total)}
                context={<div><h2>{batch.room_tags?.[0]?.name||'未指定考场'}</h2><span>{pack.project.name} · {subject.name} · {group.grade_name} · {cardName(group,subject)} · {batch.paper} {batch.sides===2?'双面':'单面'}</span></div>}
                stats={[{label:'已扫描',value:sumVisible('total')+' 面'},{label:'正面',value:sumVisible('front_count')+' 面'},{label:'背面',value:sumVisible('back_count')+' 面'},{label:'待核对',value:sumVisible('blocked')+' 面'},{label:'待上传',value:sumVisible('pending')+' 面'},{label:'已上传',value:sumVisible('uploaded')+' 面'}]}
                scope={<Radio.Group value={scanView} onChange={e=>{clearSelection();setScanView(e.target.value);setPage(1)}} optionType="button" options={[{label:'本次扫描',value:'run',disabled:!scanRun},{label:'本考场全部',value:'room'}]}/>}
                actions={<>
              <Button size="large" type="primary" loading={busyKey===actionKey('start',{batch_id:batchId})} disabled={locked || group.frozen} onClick={startScan}>开始扫描</Button><Button danger loading={busyKey===actionKey('stop')} disabled={!state.capturing} onClick={() => action('stop')}>停止扫描</Button>
              <Dropdown menu={{items:[
                {key:'round',label:'开始新一轮扫描',disabled:locked||state.processing,onClick:async()=>{
                  const next=await action('createBatch',{group_id:group.id,name:batch.name,room_tag_ids:batch.room_tags.map((t:Row)=>t.id),capture_mode:batch.capture_mode,first_side:firstSide})
                  if(!next)return
                  setBatch(next.id);setScanRun({anchorId:next.id,previousIds:state.batches.map((r:Row)=>r.id),groupId,room:roomKey(batch)});setScanView('run');setPage(1);setDeskPage(null);setAnswer(null)
                }},
                {key:'import',label:'从文件导入答题卡',disabled:locked||batch.status!=='open',onClick:()=>action('import',{batch_id:batchId,side})},
                {key:'refresh',label:'刷新上传结果',disabled:locked||!state.online,onClick:()=>action('refreshBatch',{batch_id:batchId})},
                {type:'divider'},
                {key:'clear',label:'清理本考场旧数据',danger:true,disabled:locked||state.processing,onClick:clearRoom},
              ]}}><Button icon={<DownOutlined/>} iconPosition="end" disabled={locked}>更多操作</Button></Dropdown>
                </>}
                settings={<div className="scan-device-summary"><strong>{state.scan_settings?.dpi===600?'高清 · 600 DPI（较慢）':'标清 · 300 DPI'}</strong><span>{prefs?.device?.name||'尚未选择扫描仪'}</span><Button block disabled={locked} onClick={()=>setDeviceOpen(true)}>调整扫描设置</Button></div>}
                feedback={<>{batch.error&&<Alert type="warning" message={batch.error}/>}<Typography.Paragraph>{state.message||'将答题卡放入进纸口，再点击“开始扫描”。'}</Typography.Paragraph>{!device&&<Typography.Text type="warning">请先打开扫描设置，选择扫描仪</Typography.Text>}</>}
                upload={<><Typography.Paragraph>待上传 <strong>{currentCounts.pending??pendingSheets.length}</strong> 份</Typography.Paragraph><Typography.Text type="secondary">{needsReview?'请先处理待核对答卷':'答卷先保存在本机，核对后点击上传'}</Typography.Text><Button type="primary" block disabled={locked||!roomSheets.some(r=>r.total>0)} onClick={reviewRoom}>查看名单并上传</Button>{state.syncing&&<Typography.Paragraph role="status">正在上传 · 已上传 {roomSheets.reduce((n,r)=>n+r.uploaded,0)} 面</Typography.Paragraph>}{!state.syncing&&roomSheets.some(r=>r.total>0)&&roomSheets.every(r=>r.status==='paired'||!r.total)&&<Alert type="success" message="已扫答卷均已上传确认"/>}</>}
                imageTools={answer?<Space wrap>{answer.sides.map((r:Row,index:number)=><Button key={r.id} type={index===sideIndex?'primary':'default'} onClick={()=>{setDeskPage(state.pages.find((p:Row)=>p.id===r.id)||{...deskPage,...r});void openOriginal(answer,index)}}>{r.side==='front'?'正面':'背面'}</Button>)}<Button onClick={()=>openOriginal(answer,sideIndex,corrected?'original':'corrected')}>{corrected?'查看扫描原图':'查看校正图'}</Button></Space>:null}
                image={originalError?<Alert type="error" message={originalError}/>:original?<img src={original} alt={corrected?'自动校正图':'扫描原图'}/>:<Card loading/>}
                editor={answer?<div className="scan-identity-editor"><label>准考证号<Input value={number} inputMode="numeric" disabled={!answer.editable||locked||state.processing||state.batches.find((r:Row)=>r.id===answer.batch_id)?.status==='paired'} onChange={e=>setNumber(e.target.value.trim())}/></label><div><span>姓名</span><strong>{matchedName||'未匹配'}</strong></div><label>缺考标记<Select aria-label="核对缺考标记" disabled={!answer.editable||locked||state.processing} value={absent===null?undefined:String(absent)} placeholder="待核对" options={[{value:'false',label:'未标缺考'},{value:'true',label:'缺考'}]} onChange={v=>setAbsent(v==='true')}/></label>{answer.editable&&<Button type="primary" disabled={locked||state.processing||!matchedName||absent===null||state.batches.find((r:Row)=>r.id===answer.batch_id)?.status==='paired'} onClick={saveAnswer}>保存更正</Button>}</div>:null}
                pageActions={deskPage?<div className="scan-operation-buttons">{deskPage.error&&<Alert type="warning" message={deskPage.error}/>}<Status value={deskPage.status}/>{deskPage.local_cut_available&&<Button onClick={()=>showPreview(deskPage)}>查看切题</Button>}<Button disabled={locked||state.processing||deskPage.status==='uploaded'||deskPage.status==='excluded'} onClick={()=>action('retryPage',{batch_id:deskPage.batch_id||batchId,page_id:deskPage.id})}>重新识别</Button><Button danger disabled={locked||state.processing||deskPage.status==='uploaded'||deskPage.status==='excluded'} onClick={()=>exclude(deskPage)}>排除并重扫</Button>{deskPage.status==='blocked'&&<Button disabled={locked||!state.online} onClick={()=>modal.confirm({title:'上传这张原图供核查？',onOk:()=>action('sendForReview',{batch_id:deskPage.batch_id||batchId,page_id:deskPage.id})})}>上传原图供核查</Button>}</div>:null}
              />}
    </main>
    {state&&<><Drawer title={`${batch?.room_tags?.[0]?.name||'未指定考场'} · 已扫答卷`} open={review!==null} onClose={()=>setReview(null)} width="min(850px,95vw)" footer={<Button type="primary" disabled={!readyToUpload||!state.online||locked||!review?.some(r=>r.status==='local_paired')} onClick={()=>action('upload',{batch_id:batchId},()=>setReview(null))}>核对完毕，上传 {currentCounts.pending??pendingSheets.length} 份</Button>}>
      <Table<Row> rowKey="id" dataSource={review||[]} onRow={r=>rowNavigation(()=>{setReview(null);void selectDeskPage(state.pages.find((p:Row)=>p.id===r.sides[0].id)||{...r.sides[0],batch_id:r.batch_id,candidate:r.candidate})},r.candidate||'扫描原图')} columns={[
        {title:'准考证号',dataIndex:'candidate',render:v=>v||'未识别'},
        {title:'姓名',dataIndex:'name'},
        {title:'缺考标记',dataIndex:'absent',render:v=>v==null?'请核对原图':v?'已填涂':'未填涂'},
        {title:'状态',dataIndex:'status',render:v=><Status value={v}/>}
      ]}/>
    </Drawer>
    <Drawer title={`${answer?.name||''} ${answer?.candidate||''} · 答卷核对`} open={!!answer&&!deskPage} onClose={()=>{imageRequest.current++;setAnswer(null);setOriginal('')}} width="min(1000px,96vw)">
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
      {preview && <><Descriptions column={2} items={[{ label: '考号', children: preview.candidate || '—' }, { label: '状态', children: <Status value={preview.status} /> }]} /><Select aria-label="查看整页或切题" value={question} style={{ width: '100%', margin: '20px 0' }} onChange={value => showPreview(preview, value)} options={[{ value: '', label: '整页原图' }, ...(preview.local_cut_available ? (group?.template.questions || []) : []).filter((q: Row) => q.regions.some((r: any) => r.page === (preview.side === 'front' ? 1 : 2))).map((q: Row) => ({ value: q.id, label: `第${q.number}题 · 本地切题` }))]} />{preview.error && <Alert type="warning" message={preview.error} />}{previewBusy ? <Card loading /> : image && <img className="scanner-preview" src={image} alt={question ? '本地切题预览' : '扫描原图预览'} />}</>}
    </Drawer></>}
  </div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider locale={zhCN} theme={uiTheme}><App><Scanner /></App></ConfigProvider></React.StrictMode>)
