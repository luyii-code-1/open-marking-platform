import { MoreOutlined, DownOutlined } from '@ant-design/icons'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, App, Breadcrumb, Card, Checkbox, Collapse, ConfigProvider, Descriptions, Drawer, Dropdown, Empty, Form, Input, Modal, Radio, Select, Space, Tabs, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import zhCN from 'antd/locale/zh_CN'
import { hasScannerHost, scannerCall, watchScanner } from './scanner-bridge'
import { uiTheme } from './uiTheme'
import { Brand } from './Brand'
import { cardName,subjectGrades,unassignedGrade } from './examNavigation'
import { rowNavigation } from './rowNavigation'
import {scannerRoomCounts} from './scannerRoomCounts'
import {scannerRoomState,type ScanRun} from './scannerRoomPages'
import {ScanDesk} from './ScanDesk'
import {ScanChoices} from './ScanChoices'
import './scanner.css'

type Row = Record<string, any> & { id: string }
const statusLabels: Record<string, string> = { open: '采集中', frozen: '待核查', local_paired: '已确认，等待同步', paired: '已同步', pending: '本地暂存', recognizing: '识读中', uploaded: '已上传', blocked: '待核查', excluded: '已排除' }
function Status({ value }: { value: string }) { return <Tag color={value === 'blocked' || value === 'frozen' ? 'orange' : value === 'paired' || value === 'uploaded' ? 'green' : undefined}>{statusLabels[value] || value}</Tag> }

function Scanner() {
  const [state, setState] = useState<any>(null), [busyKey, setBusyKey] = useState(''), [error, setError] = useState(''), [connection, setConnection] = useState(false)
  const [inProject, setInProject] = useState(false), [subjectId, setSubject] = useState(''), [groupId, setGroup] = useState(''),[gradeId,setGrade]=useState(''), [batchId, setBatch] = useState(''), [page, setPage] = useState(1)
  const [firstSide,setFirstSide]=useState(localStorage.getItem('duplex-first-side')||''), [side, setSide] = useState('front')
  const [deskPage,setDeskPage]=useState<Row|null>(null)
  const selectionRequest=useRef(0)
  const [preview, setPreview] = useState<Row | null>(null), [image, setImage] = useState(''), [question, setQuestion] = useState(''), [previewBusy, setPreviewBusy] = useState(false)
  const [connectForm] = Form.useForm(), { message, modal } = App.useApp()
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
    catch (e) { message.error((e as Error).message) }
    finally { if(activeAction.current===token){activeAction.current=null;setBusyKey('')} }
  }
  const prefs = state?.device_preferences, driver = prefs?.driver || "Twain", device = prefs?.device?.id || ""
  const pack = state?.package, subject = pack?.subjects.find((s: Row) => s.id === subjectId), group = pack?.groups.find((g: Row) => g.id === groupId), batch = state?.batches.find((b: Row) => b.id === batchId)
  const cached = new Map((state?.projects || []).map((p: Row) => [p.id, p]))
  const projects: Row[] = [...new Map([...(state?.catalog.projects || []), ...(state?.projects || [])].map((p: Row) => [p.id, p])).values()] as Row[]
  const grade=subject?subjectGrades(subject,pack?.groups||[]).find(g=>g.id===gradeId):undefined
  const roomKey=(row:Row)=>(row.room_tags||[]).map((t:Row)=>t.id).sort().join(',')
  const roomSheets:Row[]=batch?state.batches.filter((r:Row)=>r.group_id===batch.group_id&&roomKey(r)===roomKey(batch)):[]
  const runSheets=scanRun&&scanRun.groupId===groupId&&batch&&scanRun.room===roomKey(batch)?roomSheets.filter(r=>r.id===scanRun.anchorId||!scanRun.previousIds.includes(r.id)):[]
  const visibleSheets=scanView==='run'&&scanRun?runSheets:roomSheets
  const sumVisible=(key:string)=>visibleSheets.reduce((n,r)=>n+(r[key]||0),0)
  const pendingSheets=roomSheets.filter(r=>r.status==='local_paired')
  const needsReview=roomSheets.some(r=>r.status==='frozen'||r.status==='open'&&(r.pending||r.blocked||r.uploaded))
  const room=batch?.room_tags?.[0]&&pack?.room_tags?.find((r:Row)=>r.id===batch.room_tags[0].id)
  const readyToUpload=pendingSheets.length>0&&!needsReview&&!state?.capturing
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
    if(updated)setAnswer({...updated,name:names.get(updated.candidate)||'未匹配'})
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
    if(group.template.sides===2&&!firstSide){message.warning('请先选择已校准的双面出图顺序');return}
    await action('createBatch',{group_id:group.id,name:room?.name||'未指定考场',room_tag_ids:roomId?[roomId]:[],capture_mode:group.template.sides===2?'duplex':'separate',first_side:firstSide},r=>{setBatch(r.id);setPage(1)})
  }
  async function clearRoom(){
    const scope=batchId
    const impact=await action('clearRoom',{batch_id:scope})
    if(!impact)return
    modal.confirm({
      title:'清理本考场旧扫描数据？',
      content:`将删除本机该考场的 ${impact.pages} 面原图及识读结果，其中 ${impact.pending} 面尚未上传。清理后从空列表开始扫描。服务器已接收的数据继续保留。`,
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
  async function startScan(){
    let id=batchId
    if(batch.status!=='open'){
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
      const rows=await scannerCall<Row[]>('roomReview',{batch_id:row.batch_id||batchId})
      if(request!==selectionRequest.current)return
      const found=rows.find(r=>r.sides.some((side:Row)=>side.id===row.id))
      const names=new Map<string,string>((group?.roster||[]).map((r:Row)=>[r.candidate_number,r.name]))
      const record:Row=found?{...found,name:names.get(found.candidate)||'未匹配'}:{...row,batch_id:row.batch_id||batchId,editable:false,sides:[row]}
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
  if(state&&!state.device_preferences)return <main className="scanner-unavailable"><Typography.Title level={3}>请更新扫描客户端</Typography.Title><p>从管理后台的扫描台下载安装包后重新打开。</p><Button onClick={()=>action('offlinePage')}>打开已安装版本的本地页面</Button></main>
  if (!hasScannerHost) return <main className="scanner-unavailable"><Typography.Title level={3}>扫描工作台</Typography.Title><Typography.Paragraph>请在扫描客户端打开此页面。</Typography.Paragraph></main>
  return <div className="scanner-app">
    <header className="scanner-header"><Space size={16}><Brand /><Typography.Title level={4}>扫描工作台</Typography.Title></Space><Space size={12}><Tag color={state?.online ? 'green' : undefined}>{state?.online ? '已连接' : '离线'}</Tag><Dropdown menu={{ items: [
      { key: 'connect', label: '连接服务器', disabled: locked, onClick: () => { connectForm.setFieldsValue({ server_url: state?.server_url }); setConnection(true) } },
      { key: 'online', label: '打开服务端页面', disabled: !state?.server_url || locked, onClick: () => action('onlinePage') },
      { key: 'offline', label: '打开离线页面', disabled: locked, onClick: () => action('offlinePage') },
    ] }}><Button icon={<DownOutlined />} iconPosition="end">连接设置</Button></Dropdown></Space></header>
    <main className="scanner-content"><Breadcrumb items={crumbs} />
      {!state?.online && <Typography.Paragraph className="scanner-offline" type="secondary">已下载的项目可继续扫描，答卷保存在本机。</Typography.Paragraph>}
      {error && <Alert type="error" message={error} />}
      {!state ? <Card loading /> : !inProject || !pack ? <ScanChoices title="选择考试项目" description="选择考试，进入题卡和考场开始扫描。" items={projects.map(row=>({
          id:row.id,name:row.name,disabled:locked||!cached.has(row.id),status:<Tag>{cached.has(row.id)?'本机已就绪':'待下载配置'}</Tag>,
          description:cached.has(row.id)?'已下载配置，可离线扫描':'连接服务器下载后即可扫描',
          action:<Button block loading={busyKey===actionKey('downloadProject',{project_id:row.id})} disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:row.id},()=>{setInProject(true);setSubject('');setGrade('');setGroup('');setBatch('')})}>{cached.has(row.id)?'更新配置':'下载配置'}</Button>
        }))} onOpen={id=>void openProject(id)}/>
        : !subject ? <ScanChoices title={pack.project.name} description="选择扫描科目" items={pack.subjects.map((row:Row)=>({id:row.id,name:row.name,disabled:locked,facts:[{label:'可扫描年级',value:subjectGrades(row,pack.groups).filter(g=>g.count).length},{label:'题卡',value:pack.groups.filter((g:Row)=>g.subject_id===row.id).length}]}))} onOpen={openSubject} extra={<Button disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:pack.project.id})}>更新项目配置</Button>}/>
        : !grade ? <ScanChoices title={subject.name} description="选择年级" items={subjectGrades(subject,pack.groups).filter(g=>g.count).map(row=>({id:row.id,name:row.name,disabled:locked,facts:[{label:'题卡',value:row.count}]}))} onOpen={id=>{setGrade(id);setGroup('');setBatch('')}}/>
        : !group ? <ScanChoices title={grade.name} description="选择本次使用的题卡" items={pack.groups.filter((g:Row)=>g.subject_id===subject.id&&(g.grade_id||unassignedGrade)===gradeId).map((row:Row)=>({id:row.id,name:cardName(row,subject),description:row.template.paper+' · '+(row.template.sides===2?'双面':'单面'),status:<Tag>{row.frozen?'成绩已发布':'可扫描'}</Tag>,disabled:locked||row.frozen}))} onOpen={id=>{setGroup(id);setBatch('')}}/>
          : !batch ? <section className="scanner-section"><div className="scanner-title"><div><Typography.Title level={2}>{cardName(group,subject)}</Typography.Title><Typography.Text type="secondary">{group.grade_name&&`${group.grade_name} · `}{group.template.name} · {group.template.paper} · {group.template.sides === 2 ? '双面' : '单面'}</Typography.Text></div></div>
          {group.template.sides===2&&<Form.Item label="双面出图顺序"><Select style={{width:200}} value={firstSide||undefined} placeholder="选择试扫结果" options={[{value:'front',label:'正面先出'},{value:'back',label:'背面先出'}]} onChange={v=>{setFirstSide(v);localStorage.setItem('duplex-first-side',v)}}/></Form.Item>}
          <ScanChoices title="选择考场" description="点击考场进入工作台，也可以直接使用未指定考场。" items={[...(pack.room_tags||[]).filter((t:Row)=>t.group_id===group.id&&!t.archived),{id:'',name:'未指定考场',confirmed_sheets:group.unassigned_sheets??0}].map((row:Row)=>{
            const counts=scannerRoomCounts(state.batches,group.id,row.id)
            const exceptions=state.batches.some((b:Row)=>b.group_id===group.id&&roomKey(b)===row.id&&(b.blocked||b.status==='frozen'))
            const confirmed=row.confirmed_sheets??((row.scanned_students||0)+(row.confirmed_absent||0))
            return {id:row.id,name:row.name,disabled:locked||group.frozen,status:<Tag color={exceptions?'orange':confirmed>0?'green':undefined}>{exceptions?'待核对':counts.pending?'待上传':confirmed>0?'已上传':'待扫描'}</Tag>,
              facts:[{label:'预期份数',value:row.expected_students??'—'},{label:'本机已扫',value:counts.scanned??'—'},{label:'已上传确认',value:confirmed}]}
          })} onOpen={id=>void enterRoom((pack.room_tags||[]).find((r:Row)=>r.id===id))}/>
          <Typography.Paragraph type="secondary">题卡共确认 {group.confirmed_sheets??group.confirmed_students??0} 份 · 服务端统计以上次刷新为准</Typography.Paragraph>
          <Button disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:pack.project.id})}>刷新考场进度</Button>
          {state.batches.some((b:Row)=>b.group_id===group.id&&(b.blocked||b.status==='frozen'))&&<Table<Row> rowKey="id" dataSource={state.batches.filter((b:Row)=>b.group_id===group.id&&(b.blocked||b.status==='frozen'))} columns={[{title:'待核对',dataIndex:'name'},{title:'原因',dataIndex:'error'},{title:'操作',render:(_,r)=><Button onClick={()=>{setScanView('room');setScanRun(null);setBatch(r.id)}}>查看原图</Button>}]}/>}</section>
            : <ScanDesk rows={state.pages} total={state.page_total} page={page} onPage={setPage}
                selected={state.pages.find((r:Row)=>r.id===deskPage?.id)||deskPage}
                onSelect={selectDeskPage} capturing={state.capturing} syncing={state.syncing}
                context={<div><h2>{batch.room_tags?.[0]?.name||'未指定考场'}</h2><span>{pack.project.name} · {subject.name} · {group.grade_name} · {cardName(group,subject)} · {batch.paper} {batch.sides===2?'双面':'单面'}</span></div>}
                stats={[{label:'已采集',value:sumVisible('total')+' 面'},{label:'正面',value:sumVisible('front_count')+' 面'},{label:'背面',value:sumVisible('back_count')+' 面'},{label:'待核对',value:sumVisible('blocked')+' 面'},{label:'本地暂存',value:sumVisible('pending')+' 面'},{label:'已上传',value:sumVisible('uploaded')+' 面'}]}
                scope={<Radio.Group value={scanView} onChange={e=>{setScanView(e.target.value);setPage(1)}} optionType="button" options={[{label:'本次扫描',value:'run',disabled:!scanRun},{label:'本考场全部',value:'room'}]}/>}
                actions={<>
              <Button type="primary" loading={busyKey===actionKey('start',{batch_id:batchId})} disabled={locked || !device || group.frozen} onClick={startScan}>开始扫描</Button><Button danger loading={busyKey===actionKey('stop')} disabled={!state.capturing} onClick={() => action('stop')}>停止进纸</Button>
              <Button disabled={locked} onClick={async()=>{
                const next=await action('createBatch',{group_id:group.id,name:batch.name,room_tag_ids:batch.room_tags.map((t:Row)=>t.id),capture_mode:batch.capture_mode,first_side:firstSide})
                if(!next)return
                setBatch(next.id);setScanRun({anchorId:next.id,previousIds:state.batches.map((r:Row)=>r.id),groupId,room:roomKey(batch)});setScanView('run');setPage(1);setDeskPage(null);setAnswer(null)
              }}>开始新一轮</Button>
              <Button danger disabled={locked} onClick={clearRoom}>清理本地旧数据</Button>
              <Dropdown menu={{ items: [
                { key: 'import', label: '导入扫描图像', disabled: locked || batch.status !== 'open', onClick: () => action('import', { batch_id: batchId, side }) },
                { key: 'refresh', label: '刷新服务端状态', disabled: locked || !state.online, onClick: () => action('refreshBatch', { batch_id: batchId }) },
              ] }}><Button icon={<DownOutlined />} iconPosition="end">更多操作</Button></Dropdown>

                </>}
                settings={<Collapse defaultActiveKey={[]} items={[{ key: 'device', label: '设备设置', children: <Space wrap size={12}><Select aria-label="分辨率" disabled={locked} value={state.scan_settings?.dpi||300} options={[150,200,300,600].map(value=>({value,label:value+' DPI'}))} onChange={dpi=>action('scanSettings',{dpi,color:state.scan_settings?.color||'gray'})}/><Select aria-label="颜色" disabled={locked} value={state.scan_settings?.color||'gray'} options={[{value:'gray',label:'灰度'},{value:'bw',label:'黑白'},{value:'color',label:'彩色'}]} onChange={color=>action('scanSettings',{dpi:state.scan_settings?.dpi||300,color})}/><Select aria-label="驱动接口" value={driver} disabled={locked} onChange={driver=>action('selectDriver',{driver})} options={[{value:'Hi5100S',label:'Hi-5100S（内置）'},{value:'Twain',label:'TWAIN'},{value:'Wia',label:'WIA'},{value:'Escl',label:'eSCL'},{value:'external',label:'外部插件'}]} />
                {driver==='external' && <>
                  <Select aria-label="已添加的插件" placeholder="选择插件" value={prefs?.plugin_id||undefined} disabled={locked} options={prefs?.plugins.map((p:Row)=>({value:p.id,label:p.name+(p.available?'':'（文件缺失）')}))} onChange={plugin_id=>action('selectDriver',{driver,plugin_id})}/>
                  <Button disabled={locked} onClick={()=>action('choosePlugin')}>添加插件</Button>
                  {prefs?.plugin_id && <Button disabled={locked} onClick={()=>action('forgetPlugin')}>移除插件</Button>}
                </>}
                <Button loading={busyKey===actionKey('devices')} disabled={locked} onClick={()=>action('devices',{driver})}>发现扫描仪</Button>
                <Select aria-label="扫描仪" placeholder="选择扫描仪" disabled={locked} value={device||undefined} style={{width:'100%'}} options={prefs?.devices.map((d:Row)=>({value:d.id,label:d.name}))} onChange={id=>action('selectDevice',{id})}/>
                {batch.capture_mode !== 'duplex' && batch.sides === 2 && <Select aria-label="扫描面" disabled={locked} value={side} onChange={setSide} options={[{ value: 'front', label: '正面' }, { value: 'back', label: '背面' }]} />}</Space> }]} />}
                feedback={<>{batch.error&&<Alert type="warning" message={batch.error}/>}<Typography.Paragraph>{state.message||'等待开始扫描'}</Typography.Paragraph>{!device&&<Typography.Text type="warning">请在设备设置中选择扫描仪</Typography.Text>}</>}
                upload={<><Typography.Paragraph>待上传 <strong>{currentCounts.pending??pendingSheets.length}</strong> 份</Typography.Paragraph><Typography.Text type="secondary">{needsReview?'请先处理待核对答卷':'答卷先保存在本机，核对后点击上传'}</Typography.Text><Button type="primary" block disabled={locked||!roomSheets.some(r=>r.total>0)} onClick={reviewRoom}>核对答卷并上传</Button>{state.syncing&&<Typography.Paragraph role="status">正在上传 · 已上传 {roomSheets.reduce((n,r)=>n+r.uploaded,0)} 面</Typography.Paragraph>}{!state.syncing&&roomSheets.some(r=>r.total>0)&&roomSheets.every(r=>r.status==='paired'||!r.total)&&<Alert type="success" message="已扫答卷均已上传确认"/>}</>}
                imageTools={answer?<Space wrap>{answer.sides.map((r:Row,index:number)=><Button key={r.id} type={index===sideIndex?'primary':'default'} onClick={()=>{setDeskPage(state.pages.find((p:Row)=>p.id===r.id)||{...deskPage,...r});void openOriginal(answer,index)}}>{r.side==='front'?'正面':'背面'}</Button>)}<Button onClick={()=>openOriginal(answer,sideIndex,corrected?'original':'corrected')}>{corrected?'查看扫描原图':'查看校正图'}</Button></Space>:null}
                image={originalError?<Alert type="error" message={originalError}/>:original?<img src={original} alt={corrected?'自动校正图':'扫描原图'}/>:<Card loading/>}
                editor={answer?<div className="scan-identity-editor"><label>准考证号<Input value={number} inputMode="numeric" disabled={!answer.editable||locked||state.batches.find((r:Row)=>r.id===answer.batch_id)?.status==='paired'} onChange={e=>setNumber(e.target.value.trim())}/></label><div><span>姓名</span><strong>{matchedName||'未匹配'}</strong></div><label>缺考标记<Select aria-label="核对缺考标记" disabled={!answer.editable||locked} value={absent===null?undefined:String(absent)} placeholder="待核对" options={[{value:'false',label:'未标缺考'},{value:'true',label:'缺考'}]} onChange={v=>setAbsent(v==='true')}/></label>{answer.editable&&<Button type="primary" disabled={locked||!matchedName||absent===null||state.batches.find((r:Row)=>r.id===answer.batch_id)?.status==='paired'} onClick={saveAnswer}>保存更正</Button>}</div>:null}
                pageActions={deskPage?<div className="scan-operation-buttons">{deskPage.error&&<Alert type="warning" message={deskPage.error}/>}<Status value={deskPage.status}/>{deskPage.local_cut_available&&<Button onClick={()=>showPreview(deskPage)}>查看切题</Button>}<Button disabled={locked||deskPage.status==='uploaded'||deskPage.status==='excluded'} onClick={()=>action('retryPage',{batch_id:deskPage.batch_id||batchId,page_id:deskPage.id})}>重新识读</Button><Button danger disabled={locked||deskPage.status==='uploaded'||deskPage.status==='excluded'} onClick={()=>exclude(deskPage)}>排除并重扫</Button>{deskPage.status==='blocked'&&<Button disabled={locked||!state.online} onClick={()=>modal.confirm({title:'上传这张原图供核查？',onOk:()=>action('sendForReview',{batch_id:deskPage.batch_id||batchId,page_id:deskPage.id})})}>上传原图供核查</Button>}</div>:null}
              />}
    </main>
    <Drawer title={`${batch?.room_tags?.[0]?.name||'未指定考场'} · 已扫答卷`} open={review!==null} onClose={()=>setReview(null)} width="min(850px,95vw)" footer={<Button type="primary" disabled={!readyToUpload||!state.online||locked||!review?.some(r=>r.status==='local_paired')} onClick={()=>action('upload',{batch_id:batchId},()=>setReview(null))}>核对完毕，上传 {currentCounts.pending??pendingSheets.length} 份</Button>}>
      <Table<Row> rowKey="id" dataSource={review||[]} onRow={r=>rowNavigation(()=>{setReview(null);void selectDeskPage(state.pages.find((p:Row)=>p.id===r.sides[0].id)||{...r.sides[0],batch_id:r.batch_id,candidate:r.candidate})},r.candidate||'扫描原图')} columns={[
        {title:'准考证号',dataIndex:'candidate',render:v=>v||'未识读'},
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
        <Button type="primary" disabled={locked||!matchedName||absent===null} onClick={saveAnswer}>确认更正</Button>
      </Space>}
      {original&&<Space><Tag>{corrected?'自动校正图':'扫描原图'}</Tag><Button onClick={()=>openOriginal(answer,sideIndex,corrected?'original':'corrected')}>{corrected?'查看扫描原图':'查看校正图'}</Button></Space>}
      {originalError?<Alert type="error" message={originalError}/>:original?<img className="scanner-preview" src={original} alt={corrected?"自动校正图":"扫描原图"}/>:<Card loading/>}</Space>}
    </Drawer>
    <Drawer title="连接服务器" open={connection} onClose={() => setConnection(false)} width={420}><Form form={connectForm} layout="vertical" onFinish={values => action('connect', values, () => { connectForm.setFieldValue('pairing_code', ''); setConnection(false); setInProject(false); setSubject(''); setGrade('');setGroup(''); setBatch('') })}>
      <Form.Item name="server_url" label="服务端地址" rules={[{ required: true }]}><Input placeholder="https://服务器地址" /></Form.Item>
      <Typography.Paragraph type="secondary">已登记的设备可直接连接。首次使用时在管理后台生成配对码，再在此处填写完成绑定。</Typography.Paragraph>
      <Form.Item name="pairing_code" label="配对码（首次连接）"><Input autoComplete="one-time-code" maxLength={14}/></Form.Item><Button htmlType="submit" type="primary" loading={busyKey===actionKey('connect')}>连接</Button><Typography.Paragraph style={{marginTop:32}} type="secondary">本机数据目录</Typography.Paragraph><Typography.Text copyable>{state?.storage_path}</Typography.Text>
    </Form></Drawer>
    <Drawer title={preview ? `第${preview.sheet_number??preview.sequence}张 · ${preview.side === 'front' ? '正面' : '背面'}` : '页面核查'} open={!!preview} onClose={() => { setPreview(null); setImage('') }} width="min(880px,90vw)">
      {preview && <><Descriptions column={2} items={[{ label: '考号', children: preview.candidate || '—' }, { label: '状态', children: <Status value={preview.status} /> }]} /><Select aria-label="查看整页或切题" value={question} style={{ width: '100%', margin: '20px 0' }} onChange={value => showPreview(preview, value)} options={[{ value: '', label: '整页原图' }, ...(preview.local_cut_available ? (group?.template.questions || []) : []).filter((q: Row) => q.regions.some((r: any) => r.page === (preview.side === 'front' ? 1 : 2))).map((q: Row) => ({ value: q.id, label: `第${q.number}题 · 本地切题` }))]} />{preview.error && <Alert type="warning" message={preview.error} />}{previewBusy ? <Card loading /> : image && <img className="scanner-preview" src={image} alt={question ? '本地切题预览' : '扫描原图预览'} />}</>}
    </Drawer>
  </div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider locale={zhCN} theme={uiTheme}><App><Scanner /></App></ConfigProvider></React.StrictMode>)
