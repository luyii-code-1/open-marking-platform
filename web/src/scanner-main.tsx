import { MoreOutlined, DownOutlined } from '@ant-design/icons'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, App, Breadcrumb, Card, Checkbox, Collapse, ConfigProvider, Descriptions, Drawer, Dropdown, Empty, Form, Input, Modal, Select, Space, Tabs, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import zhCN from 'antd/locale/zh_CN'
import { hasScannerHost, scannerCall, watchScanner } from './scanner-bridge'
import { uiTheme } from './uiTheme'
import { Brand } from './Brand'
import { cardName,subjectGrades,unassignedGrade } from './examNavigation'
import { rowNavigation } from './rowNavigation'
import './scanner.css'

type Row = Record<string, any> & { id: string }
const statusLabels: Record<string, string> = { open: '采集中', frozen: '待核查', local_paired: '已确认，等待同步', paired: '已同步', pending: '等待上传', uploaded: '已上传', blocked: '待核查', excluded: '已排除' }
function Status({ value }: { value: string }) { return <Tag color={value === 'blocked' || value === 'frozen' ? 'orange' : value === 'paired' || value === 'uploaded' ? 'green' : undefined}>{statusLabels[value] || value}</Tag> }

function Scanner() {
  const [state, setState] = useState<any>(null), [busyKey, setBusyKey] = useState(''), [error, setError] = useState(''), [connection, setConnection] = useState(false)
  const [inProject, setInProject] = useState(false), [subjectId, setSubject] = useState(''), [groupId, setGroup] = useState(''),[gradeId,setGrade]=useState(''), [batchId, setBatch] = useState(''), [page, setPage] = useState(1)
  const [firstSide,setFirstSide]=useState(localStorage.getItem('duplex-first-side')||''), [driver, setDriver] = useState('Twain'), [devices, setDevices] = useState<Row[]>([]), [device, setDevice] = useState(''), [side, setSide] = useState('front')
  const [preview, setPreview] = useState<Row | null>(null), [image, setImage] = useState(''), [question, setQuestion] = useState(''), [previewBusy, setPreviewBusy] = useState(false)
  const [connectForm] = Form.useForm(), { message, modal } = App.useApp()
  const currentBatch = useRef(batchId), currentPage = useRef(page), reloadBusy = useRef(false), mounted = useRef(true)
  currentBatch.current = batchId; currentPage.current = page
  const reload = useCallback(async () => {
    if (reloadBusy.current || !hasScannerHost) return
    reloadBusy.current = true
    try { const next = await scannerCall('state', { batch_id: currentBatch.current, offset: (currentPage.current - 1) * 50 }); if (mounted.current) { setState(next); setError('') } }
    catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { reloadBusy.current = false }
  }, [])
  useEffect(() => {
    mounted.current = true; void reload(); let scheduled: ReturnType<typeof setTimeout> | undefined
    const stop = watchScanner(() => { if (scheduled) return; scheduled = setTimeout(() => { scheduled = undefined; void reload() }, 250) })
    const poll = setInterval(reload, 3000)
    return () => { mounted.current = false; stop(); clearInterval(poll); if (scheduled) clearTimeout(scheduled) }
  }, [reload])
  useEffect(() => { void reload() }, [batchId, page, reload])
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
  const pack = state?.package, subject = pack?.subjects.find((s: Row) => s.id === subjectId), group = pack?.groups.find((g: Row) => g.id === groupId), batch = state?.batches.find((b: Row) => b.id === batchId)
  const cached = new Map((state?.projects || []).map((p: Row) => [p.id, p]))
  const projects: Row[] = [...new Map([...(state?.catalog.projects || []), ...(state?.projects || [])].map((p: Row) => [p.id, p])).values()] as Row[]
  const grade=subject?subjectGrades(subject,pack?.groups||[]).find(g=>g.id===gradeId):undefined
  const roomKey=(row:Row)=>(row.room_tags||[]).map((t:Row)=>t.id).sort().join(',')
  const roomSheets:Row[]=batch?state.batches.filter((r:Row)=>r.group_id===batch.group_id&&roomKey(r)===roomKey(batch)):[]
  const pendingSheets=roomSheets.filter(r=>r.status==='local_paired')
  const needsReview=roomSheets.some(r=>r.status==='frozen'||r.status==='open'&&(r.pending||r.blocked||r.uploaded))
  const room=batch?.room_tags?.[0]&&pack?.room_tags?.find((r:Row)=>r.id===batch.room_tags[0].id)
  const readyToUpload=pendingSheets.length>0&&!needsReview&&!state?.capturing
  const roomComplete=room?.expected_students>0&&pendingSheets.length+(room.scanned_students||0)+(room.confirmed_absent||0)>=room.expected_students
  const [review,setReview]=useState<Row[]|null>(null),[answer,setAnswer]=useState<Row|null>(null)
  const [original,setOriginal]=useState(''),[sideIndex,setSideIndex]=useState(0),[originalError,setOriginalError]=useState('')
  const imageRequest=useRef(0)
  async function reviewRoom(){
    await action('roomReview',{batch_id:batchId},(rows:Row[])=>{
      const names=new Map<string,string>((group?.roster||[]).map((r:Row)=>[r.candidate_number,r.name]))
      setReview(rows.map(r=>({...r,name:names.get(r.candidate)||'未匹配'})))
    })
  }
  async function openOriginal(row:Row,index:number){
    const request=++imageRequest.current
    setAnswer(row);setSideIndex(index);setOriginal('');setOriginalError('')
    try{
      const result=await scannerCall('originalPage',{batch_id:row.batch_id,page_id:row.sides[index].id})
      if(request===imageRequest.current)setOriginal(result.url)
    }catch(e){if(request===imageRequest.current)setOriginalError((e as Error).message)}
  }
  const locked = busy || !!state?.capturing || !!state?.syncing
  async function openProject(id: string) { await action('openProject', { project_id: id }, () => { setInProject(true); setSubject(''); setGrade('');setGroup(''); setBatch('') }) }
  function openSubject(id:string){setSubject(id);setGrade('');setGroup('');setBatch('')}
  async function enterRoom(room?:Row){
    if(!group||!pack)return
    const roomId=room?.id
    const local=state.batches.find((b:Row)=>b.group_id===group.id&&b.status==='open'&&(b.room_tags?.[0]?.id||'')===(roomId||''))
    if(local){setBatch(local.id);setPage(1);return}
    if(group.template.sides===2&&!firstSide){message.warning('请先选择已校准的双面出图顺序');return}
    await action('createBatch',{group_id:group.id,name:room?.name||'未指定考场',room_tag_ids:roomId?[roomId]:[],capture_mode:group.template.sides===2?'duplex':'separate',first_side:firstSide},r=>{setBatch(r.id);setPage(1)})
  }
  async function showPreview(row: Row, qid = '') {
    setPreview(row); setPreviewBusy(true); setImage(''); setQuestion(qid)
    try { const result = await scannerCall('preview', { batch_id: batchId, page_id: row.id, question_id: qid }); setImage(result.url) }
    catch (e) { message.error((e as Error).message) }
    finally { setPreviewBusy(false) }
  }
  function exclude(row: Row) {
    modal.confirm({ title: batch.capture_mode === 'duplex' ? `排除第${row.sequence}张纸并整张重扫？` : `排除此${row.side === 'front' ? '正' : '背'}面？`, content: '已采集原图保留，已上传页面会在同步时排除。', okText: '排除并保留原图', okButtonProps: { danger: true }, onOk: () => action('exclude', { batch_id: batchId, page_id: row.id }) })
  }
  const crumbs = [
    { title: <Button type="link" disabled={locked} onClick={() => setInProject(false)}>考试项目</Button> },
    ...(inProject && pack ? [{ title: <Button type="link" disabled={locked} onClick={() => { setSubject(''); setGrade('');setGroup(''); setBatch('') }}>{pack.project.name}</Button> }] : []),
    ...(inProject && subject ? [{ title: <Button type="link" disabled={locked} onClick={() => { setGrade('');setGroup(''); setBatch('') }}>{subject.name}</Button> }] : []),
    ...(inProject&&grade?[{title:<Button type="link" disabled={locked} onClick={()=>{setGroup('');setBatch('')}}>{grade.name}</Button>}]:[]),
    ...(inProject && group ? [{ title: <Button type="link" disabled={locked} onClick={() => setBatch('')}>{cardName(group,subject)}</Button> }] : []),
    ...(inProject && batch ? [{ title: batch.room_tags?.[0]?.name||'未指定考场' }] : []),
  ]
  if(state&&!state.room_review)return <main className="scanner-unavailable"><Typography.Title level={3}>请更新扫描客户端</Typography.Title><p>从管理后台的扫描台下载安装包后重新打开。</p><Button onClick={()=>action('offlinePage')}>打开已安装版本的本地页面</Button></main>
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
      {!state ? <Card loading /> : !inProject || !pack ? <section className="scanner-section"><div className="scanner-title"><div><Typography.Title level={2}>考试项目</Typography.Title><Typography.Text type="secondary">打开本机已下载的考试，或连接服务器下载项目配置。</Typography.Text></div><Button onClick={() => { connectForm.setFieldsValue({ server_url: state.server_url }); setConnection(true) }}>连接服务器</Button></div>
        <Table<Row> rowKey="id" onRow={row=>locked||!cached.has(row.id)?{}:rowNavigation(()=>void openProject(row.id),row.name)} dataSource={projects} locale={{ emptyText: <Empty description="尚未下载考试项目" /> }} pagination={{ defaultPageSize:50 }} columns={[
          { title: '考试', dataIndex: 'name' }, { title: '本地配置', render: (_, row) => cached.has(row.id) ? <Tag>已下载</Tag> : <Typography.Text type="secondary">未下载</Typography.Text> },
          { title: '操作', className: 'row-actions', width: 240, render: (_, row) => <Space><Button loading={busyKey===actionKey('downloadProject',{project_id:row.id})} disabled={!state.online || locked} onClick={() => action('downloadProject', { project_id: row.id }, () => { setInProject(true); setSubject(''); setGrade('');setGroup(''); setBatch('') })}>{cached.has(row.id) ? '更新配置' : '下载配置'}</Button></Space> },
        ]} /></section> : !subject ? <section className="scanner-section"><div className="scanner-title"><Typography.Title level={2}>{pack.project.name}</Typography.Title><Button loading={busyKey===actionKey('downloadProject',{project_id:pack.project.id})} disabled={!state.online || locked} onClick={() => action('downloadProject', { project_id: pack.project.id })}>更新项目配置</Button></div><Table<Row> rowKey="id" dataSource={pack.subjects} onRow={row=>locked?{}:rowNavigation(()=>openSubject(row.id),row.name)} pagination={false} columns={[{title:'科目',dataIndex:'name'},{title:'可扫描年级',render:(_,row)=>subjectGrades(row,pack.groups).filter(g=>g.count).length},{title:'题卡',render:(_,row)=>pack.groups.filter((g:Row)=>g.subject_id===row.id).length}]}/></section>
        : !grade ? <section className="scanner-section"><Typography.Title level={2}>{subject.name}</Typography.Title><Table<Row> rowKey="id" dataSource={subjectGrades(subject,pack.groups).filter(g=>g.count)} onRow={row=>locked?{}:rowNavigation(()=>{setGrade(row.id);setGroup('');setBatch('')},row.name)} pagination={false} columns={[{title:'年级',dataIndex:'name'},{title:'题卡',dataIndex:'count'}]}/></section>
        : !group ? <section className="scanner-section"><Typography.Title level={2}>{grade.name}</Typography.Title><Table<Row> rowKey="id" dataSource={pack.groups.filter((g:Row)=>g.subject_id===subject.id&&(g.grade_id||unassignedGrade)===gradeId)} onRow={row=>locked?{}:rowNavigation(()=>{setGroup(row.id);setBatch('')},cardName(row,subject))} pagination={{defaultPageSize:50}} columns={[{title:'题卡',render:(_,row)=>cardName(row,subject)},{title:'版式',render:(_,row)=>row.template.name},{title:'状态',render:(_,row)=>row.frozen?<Tag>成绩已发布</Tag>:<Tag>可扫描</Tag>}]}/></section>
          : !batch ? <section className="scanner-section"><div className="scanner-title"><div><Typography.Title level={2}>{cardName(group,subject)}</Typography.Title><Typography.Text type="secondary">{group.grade_name&&`${group.grade_name} · `}{group.template.name} · {group.template.paper} · {group.template.sides === 2 ? '双面' : '单面'}</Typography.Text></div><Button type="primary" disabled={locked||group.frozen} onClick={()=>enterRoom()}>不指定考场扫描</Button></div>
          {group.template.sides===2&&<Form.Item label="双面出图顺序"><Select style={{width:200}} value={firstSide||undefined} placeholder="选择试扫结果" options={[{value:'front',label:'正面先出'},{value:'back',label:'背面先出'}]} onChange={v=>{setFirstSide(v);localStorage.setItem('duplex-first-side',v)}}/></Form.Item>}
          <Table<Row> rowKey="id" dataSource={(pack.room_tags||[]).filter((t:Row)=>t.group_id===group.id&&!t.archived)} onRow={r=>locked||group.frozen?{}:rowNavigation(()=>void enterRoom(r),r.name)} columns={[{title:'考场',dataIndex:'name'},{title:'预期人数',dataIndex:'expected_students'},{title:'实考',dataIndex:'scanned_students'},{title:'缺考',dataIndex:'confirmed_absent'},{title:'待扫',dataIndex:'remaining_students'},{title:'已确认进度',render:(_,r)=>r.over_expected>0?'超出预期':r.expected_students!=null&&r.remaining_students===0?'已扫齐':r.scanned_students+r.confirmed_absent>0?'进行中':'未扫描'}]}/>
          <Typography.Paragraph>题卡已确认 {group.confirmed_students??0} 人 · 未指定考场 {group.unassigned?.length??0} 份</Typography.Paragraph>
          {!!group.unassigned?.length&&<Table<Row> rowKey="id" dataSource={group.unassigned} columns={[{title:'未指定考场的准考证号',dataIndex:'candidate_number'},{title:'补选考场',render:(_,r)=><Select disabled={!state.online||locked||group.frozen} placeholder="选择考场" style={{width:180}} options={(pack.room_tags||[]).filter((t:Row)=>!t.archived&&t.group_id===group.id).map((t:Row)=>({value:t.id,label:t.name}))} onChange={room_id=>action('assignRoom',{submission_id:r.id,room_id})}/>}]}/>}
          <Button disabled={!state.online||locked} onClick={()=>action('downloadProject',{project_id:pack.project.id})}>刷新考场进度</Button>
          {state.batches.some((b:Row)=>b.group_id===group.id&&(b.blocked||b.status==='frozen'))&&<Table<Row> rowKey="id" dataSource={state.batches.filter((b:Row)=>b.group_id===group.id&&(b.blocked||b.status==='frozen'))} columns={[{title:'待核对',dataIndex:'name'},{title:'原因',dataIndex:'error'},{title:'操作',render:(_,r)=><Button onClick={()=>setBatch(r.id)}>查看原图</Button>}]}/>}</section>
            : <section className="scanner-section"><div className="scanner-title"><div><Space align="center"><Typography.Title level={2}>{batch.room_tags?.[0]?.name||'未指定考场'}</Typography.Title><Status value={batch.status} /></Space><Typography.Paragraph type="secondary">{batch.paper} · {batch.sides === 2 ? '双面' : '单面'} · {batch.capture_mode === 'duplex' ? '自动双面' : '分面采集'} · 已上传 {batch.uploaded}/{batch.total}</Typography.Paragraph></div><Space>
              <Button type="primary" loading={busyKey===actionKey('start',{batch_id:batchId})} disabled={locked || !device || group.frozen} onClick={async()=>{let id=batchId;if(batch.status!=='open'){const next=await action('createBatch',{group_id:group.id,name:batch.name,room_tag_ids:batch.room_tags.map((t:Row)=>t.id),capture_mode:batch.capture_mode,first_side:firstSide});if(!next)return;id=next.id;setBatch(id)}await action('start',{batch_id:id,device_id:device,side})}}>开始扫描</Button><Button danger loading={busyKey===actionKey('stop')} disabled={!state.capturing} onClick={() => action('stop')}>停止</Button>
              <Dropdown menu={{ items: [
                { key: 'import', label: '导入扫描图像', disabled: locked || batch.status !== 'open', onClick: () => action('import', { batch_id: batchId, side }) },
                { key: 'refresh', label: '刷新服务端状态', disabled: locked || !state.online, onClick: () => action('refreshBatch', { batch_id: batchId }) },
              ] }}><Button icon={<DownOutlined />} iconPosition="end">更多操作</Button></Dropdown>
            </Space></div>
              {roomSheets.some(r=>r.total>0)&&<Alert type={needsReview?'warning':'info'} message={needsReview?'本考场有待核对答卷':readyToUpload&&roomComplete?'已达到考场预期人数，请核对后开始上传':`已暂存 ${pendingSheets.length} 份，请核对后开始上传`} action={<Button disabled={locked} onClick={reviewRoom}>核对答卷</Button>}/>}
              {batch.error && <Alert type="warning" message={batch.error} />}
              <Collapse defaultActiveKey={['device']} items={[{ key: 'device', label: '设备设置', children: <Space wrap size={12}><Select aria-label="分辨率" disabled={locked} value={state.scan_settings?.dpi||300} options={[150,200,300,600].map(value=>({value,label:value+' DPI'}))} onChange={dpi=>action('scanSettings',{dpi,color:state.scan_settings?.color||'gray'})}/><Select aria-label="颜色" disabled={locked} value={state.scan_settings?.color||'gray'} options={[{value:'gray',label:'灰度'},{value:'bw',label:'黑白'},{value:'color',label:'彩色'}]} onChange={color=>action('scanSettings',{dpi:state.scan_settings?.dpi||300,color})}/><Select aria-label="驱动接口" value={driver} disabled={locked} style={{ width: 130 }} onChange={value => { setDriver(value); setDevices([]); setDevice('') }} options={[{ value: 'Twain', label: 'TWAIN' }, { value: 'Wia', label: 'WIA' }, { value: 'Escl', label: 'eSCL' },{value:'external',label:'外部插件'}]} />{driver==='external'&&<Button disabled={locked} onClick={()=>action('choosePlugin',{},()=>{setDevices([]);setDevice('')})}>选择插件程序</Button>}<Button loading={busyKey===actionKey('devices')} disabled={locked} onClick={() => action('devices', { driver }, rows => { setDevices(rows); setDevice(rows[0]?.id || '') })}>发现扫描仪</Button><Select aria-label="扫描仪" placeholder="选择扫描仪" disabled={locked} value={device || undefined} style={{ minWidth: 260 }} options={devices.map(d => ({ value: d.id, label: d.name }))} onChange={setDevice} />{batch.capture_mode !== 'duplex' && batch.sides === 2 && <Select aria-label="扫描面" disabled={locked} value={side} onChange={setSide} options={[{ value: 'front', label: '正面' }, { value: 'back', label: '背面' }]} />}</Space> }]} />
              <Typography.Paragraph className="scanner-progress" type="secondary" role="status" aria-live="polite">{state.message || '\u00a0'}</Typography.Paragraph>
              <Table<Row> rowKey="id" dataSource={state.pages} pagination={{ current: page, pageSize: 50, total: state.page_total, showSizeChanger: false, onChange: setPage }} columns={[
                { title: '纸张序号', dataIndex: 'sequence', width: 100 }, { title: '扫描面', dataIndex: 'side', width: 90, render: value => value === 'front' ? '正面' : '背面' }, { title: '考号', dataIndex: 'candidate' }, { title: '状态', dataIndex: 'status', render: value => <Status value={value} /> },
                { title: '核查信息', render: (_, row) => row.error || row.quality }, { title: '操作', className: 'row-actions', width: 110, render: (_, row) => <Space><Button type="link" onClick={() => showPreview(row)}>查看</Button><Dropdown menu={{ items: [{ key: 'retry', label: '重试本地识读', disabled: locked || row.status === 'excluded' || batch.status === 'paired', onClick: () => action('retryPage', { batch_id: batchId, page_id: row.id }) }, { key: 'review', label: '上传原图供核查', disabled: locked || !state.online || row.status !== 'blocked', onClick: () => modal.confirm({ title: '将原图和质量报告送交管理员核查？', okText: '上传待核查原图', onOk: () => action('sendForReview', { batch_id: batchId, page_id: row.id }) }) }, { key: 'exclude', label: batch.capture_mode === 'duplex' ? '排除整张重扫' : '排除此面', danger: true, disabled: locked || row.status === 'excluded' || batch.status === 'paired', onClick: () => exclude(row) }] }}><Button type="text" icon={<MoreOutlined />} aria-label={`第${row.sequence}张扫描图更多操作`} /></Dropdown></Space> },
              ]} />
            </section>}
    </main>
    <Drawer title={`${batch?.room_tags?.[0]?.name||'未指定考场'} · 已扫答卷`} open={review!==null} onClose={()=>setReview(null)} width="min(850px,95vw)" footer={<Button type="primary" disabled={!readyToUpload||!state.online||locked||!review?.some(r=>r.status==='local_paired')} onClick={()=>action('upload',{batch_id:batchId},()=>setReview(null))}>核对完毕，开始上传</Button>}>
      <Table<Row> rowKey="id" dataSource={review||[]} onRow={r=>rowNavigation(()=>void openOriginal(r,0),r.candidate||'扫描原图')} columns={[
        {title:'准考证号',dataIndex:'candidate',render:v=>v||'未识读'},
        {title:'姓名',dataIndex:'name'},
        {title:'缺考标记',dataIndex:'absent',render:v=>v==null?'请核对原图':v?'已填涂':'未填涂'},
        {title:'状态',dataIndex:'status',render:v=><Status value={v}/>}
      ]}/>
    </Drawer>
    <Drawer title={`${answer?.name||''} ${answer?.candidate||''} · 扫描原图`} open={!!answer} onClose={()=>{imageRequest.current++;setAnswer(null);setOriginal('')}} width="min(1000px,96vw)">
      {answer&&<Space direction="vertical" style={{width:'100%'}}><Space>{answer.sides.map((s:Row,i:number)=><Button key={s.id} type={i===sideIndex?'primary':'default'} onClick={()=>openOriginal(answer,i)}>{s.side==='front'?'正面':'背面'}</Button>)}</Space>
      {originalError?<Alert type="error" message={originalError}/>:original?<img className="scanner-preview" src={original} alt="扫描原图"/>:<Card loading/>}</Space>}
    </Drawer>
    <Drawer title="连接服务器" open={connection} onClose={() => setConnection(false)} width={420}><Form form={connectForm} layout="vertical" onFinish={values => action('connect', values, () => { connectForm.setFieldValue('pairing_code', ''); setConnection(false); setInProject(false); setSubject(''); setGrade('');setGroup(''); setBatch('') })}>
      <Form.Item name="server_url" label="服务端地址" rules={[{ required: true }]}><Input placeholder="https://服务器地址" /></Form.Item>
      <Typography.Paragraph type="secondary">已登记的设备可直接连接。首次使用时在管理后台生成配对码，再在此处填写完成绑定。</Typography.Paragraph>
      <Form.Item name="pairing_code" label="配对码（首次连接）"><Input autoComplete="one-time-code" maxLength={14}/></Form.Item><Button htmlType="submit" type="primary" loading={busyKey===actionKey('connect')}>连接</Button><Typography.Paragraph style={{marginTop:32}} type="secondary">本机数据目录</Typography.Paragraph><Typography.Text copyable>{state?.storage_path}</Typography.Text>
    </Form></Drawer>
    <Drawer title={preview ? `第${preview.sequence}张 · ${preview.side === 'front' ? '正面' : '背面'}` : '页面核查'} open={!!preview} onClose={() => { setPreview(null); setImage('') }} width="min(880px,90vw)">
      {preview && <><Descriptions column={2} items={[{ label: '考号', children: preview.candidate || '—' }, { label: '状态', children: <Status value={preview.status} /> }]} /><Select aria-label="查看整页或切题" value={question} style={{ width: '100%', margin: '20px 0' }} onChange={value => showPreview(preview, value)} options={[{ value: '', label: '整页原图' }, ...(preview.local_cut_available ? (group?.template.questions || []) : []).filter((q: Row) => q.regions.some((r: any) => r.page === (preview.side === 'front' ? 1 : 2))).map((q: Row) => ({ value: q.id, label: `第${q.number}题 · 本地切题` }))]} />{preview.error && <Alert type="warning" message={preview.error} />}{previewBusy ? <Card loading /> : image && <img className="scanner-preview" src={image} alt={question ? '本地切题预览' : '扫描原图预览'} />}</>}
    </Drawer>
  </div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider locale={zhCN} theme={uiTheme}><App><Scanner /></App></ConfigProvider></React.StrictMode>)
