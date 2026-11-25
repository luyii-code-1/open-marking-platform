import {useEffect,useState} from 'react'
import {Alert,App,Card,Empty,InputNumber,Modal,Popconfirm,Space,Statistic,Tag,Typography,Upload} from 'antd'
import { Table } from './DataTable'
import {ArrowLeftOutlined,ReloadOutlined,UploadOutlined} from '@ant-design/icons'
import {Button} from './Button'
import {TagPicker} from './TagPicker'
import {describeStatus,download,request,send,useResource,type Row} from './api'
import {HierarchyPicker} from './HierarchyPicker'
import {ErrorNotice} from './EntityTable'
import {AssetImage} from './components'
import {cardScopeLabel,examPath,unassignedGrade} from './examNavigation'
import {rowNavigation} from './rowNavigation'

export function ScanCapture({groupId,selectedGroup:externalGroup,onGroupChange,selectedBatch:externalBatch,onBatchChange,onOpenCorrection}:{groupId?:string;selectedGroup?:string;onGroupChange?:(id:string)=>void;selectedBatch?:string;onBatchChange?:(id:string)=>void;onOpenCorrection?:(batchId:string)=>void}){
  const {message}=App.useApp(),[chosenGroup,setChosenGroup]=useState(externalGroup||''),group=groupId||(externalGroup??chosenGroup)
  const projects=useResource<Row[]>('/projects',[]),groups=useResource<Row[]>('/groups',[]),subjects=useResource<Row[]>('/subjects',[]),batches=useResource<Row[]>('/scan-batches',[])
  const [localBatch,setLocalBatch]=useState(externalBatch||''),selectedId=externalBatch??localBatch,[status,setStatus]=useState<string>(),[saving,setSaving]=useState(false)
  function setGroup(id:string){setChosenGroup(id);onGroupChange?.(id)}
  function setSelected(id:string){setLocalBatch(id);onBatchChange?.(id)}
  const selected=batches.data.find(b=>b.id===selectedId),pages=useResource<Row[]>(selectedId?`/scan-batches/${selectedId}/pages`:null,[])
  const [side,setSide]=useState('front'),[sequence,setSequence]=useState(1),[preview,setPreview]=useState<Row|null>(null)
  const currentGroup=groups.data.find(g=>g.id===group)
  const anonymous=!!currentGroup?.statistics_group
  const workflow=useResource<Row>(group?`/groups/${group}/workflow`:null,{} as Row),templates=useResource<Row[]>('/templates',[])
  const pageRows=pages.data.filter(p=>p.batch_id===selectedId)
  const selectedGroup=groups.data.find(g=>g.id===selected?.group_id),selectedSubject=subjects.data.find(s=>s.id===selectedGroup?.subject_id)
  const readOnly=!!selectedGroup?.frozen||selected?.status==='paired'||selected?.status==='frozen'
  const hasPageExceptions=pageRows.some(p=>['error','exception','quarantined','needs_review'].includes(p.status))
  const statistics=anonymous||!!templates.data.find(t=>t.id===currentGroup?.template_id)?.statistics_mode
  const rows=batches.data.map(b=>({...b,...workflow.data.batches?.find((v:Row)=>v.id===b.id)})).filter(b=>(!group||b.group_id===group)&&(!status||b.status===status))
  const label=(id:string)=>cardScopeLabel(groups.data.find(g=>g.id===id),subjects.data,projects.data)
  useEffect(()=>{if(!pages.loading)setSequence(Math.max(0,...pageRows.filter(p=>p.side===side).map(p=>p.sequence))+1)},[selectedId,side,pages.data,pages.loading])
  async function create(){
    setSaving(true)
    try{
      const batch=await send<Row>('/scan-batches',{group_id:groupId||group,back_order:'same'})
      await batches.reload()
      setSelected(batch.id)
    }catch(e){message.error((e as Error).message)}finally{setSaving(false)}
  }
  async function pair(){setSaving(true);try{await send(`/scan-batches/${selectedId}/pair`);await Promise.all([pages.reload(),batches.reload(),workflow.reload()]);message.success('配对已确认，答卷已入库')}catch(e){message.error((e as Error).message)}finally{setSaving(false)}}
  async function finishEmpty(){setSaving(true);try{await send(`/scan-batches/${selectedId}/finish-empty`,{confirm:true});await Promise.all([batches.reload(),workflow.reload()]);message.success('空记录已标记完成')}catch(e){message.error((e as Error).message)}finally{setSaving(false)}}
  async function upload(file:File){
    const body=new FormData();body.append('file',file);body.append('capture_id',crypto.randomUUID());body.append('side',side);body.append('sequence',String(sequence));setSaving(true)
    try{await request(`/scan-batches/${selectedId}/pages`,{method:'POST',body});await pages.reload();message.success('页面已上传')}catch(e){message.error((e as Error).message)}finally{setSaving(false)}
    return false
  }
  const frontCount=pageRows.filter(p=>p.side==='front'&&!p.excluded).length
  const backCount=pageRows.filter(p=>p.side==='back'&&!p.excluded).length
  const recordTitle=(row:Row)=>`记录 ${row.id.slice(0,8)}`
  return <Space direction="vertical" size={24} style={{width:'100%'}}>
    <ErrorNotice error={projects.error||groups.error||subjects.error||batches.error} retry={batches.reload}/>
    {!selected?<Card title="扫描记录" extra={<Space wrap><Button onClick={()=>download(`/exports/scans?${new URLSearchParams({...group?{group_id:group}:{}})}`,'扫描记录.csv').catch(e=>message.error(e.message))}>导出记录</Button><Button icon={<ReloadOutlined/>} onClick={batches.reload}>刷新</Button><Button type="primary" disabled={saving||!group||!!currentGroup?.frozen} loading={saving} onClick={create}>导入扫描图像</Button></Space>}>
      <div className="scan-filters">{!groupId&&<HierarchyPicker value={group} allowClear onChange={setGroup}/>}<TagPicker compact allowClear clearLabel="全部状态" value={status} onChange={setStatus} options={['front','frozen','paired'].map(value=>({value,label:describeStatus(value)}))}/></div>
      <Table rowKey="id" dataSource={rows} loading={batches.loading} onRow={row=>rowNavigation(()=>setSelected(row.id),recordTitle(row))} pagination={{defaultPageSize:50,showSizeChanger:true}} scroll={{x:'max-content'}} columns={[
        {title:'扫描记录',dataIndex:'id',render:(_,row:Row)=><Button type="link" onClick={()=>setSelected(row.id)}>{row.id.slice(0,8)}</Button>},
        ...!groupId?[{title:'题卡',dataIndex:'group_id',render:label}]:[],
        {title:'固定版式',render:(_:unknown,row:Row)=>{const t=templates.data.find(t=>t.id===row.template_id);return t?.name||'正式版式'}},
        {title:'服务端已接收',dataIndex:'received_pages',render:v=>v===undefined?'—':`${v} 页`},
        {title:'识读中 / 异常',render:(_:unknown,row:Row)=>row.processing_pages===undefined?'—':`${row.processing_pages} / ${row.exception_pages}`},
        {title:'已入库页数',dataIndex:'linked_pages',render:v=>v??'—'},
        {title:'处理状态',dataIndex:'status',render:v=><Tag color={v==='paired'?'green':v==='frozen'?'orange':'blue'}>{v==='paired'?'已完成':v==='frozen'?'待核查':'接收与配页中'}</Tag>},
        {title:'操作',className:'row-actions',render:(_:unknown,row:Row)=><Space><Button onClick={()=>setSelected(row.id)}>{row.status==='paired'?'查看记录':row.status==='frozen'?'查看异常':'续扫 / 配页'}</Button>{row.status==='frozen'&&onOpenCorrection&&<Button type="link" onClick={()=>onOpenCorrection(row.id)}>纠正与补扫</Button>}</Space>},
      ]}/>
    </Card>:<Card title={<Space><Button icon={<ArrowLeftOutlined/>} disabled={saving} onClick={()=>setSelected('')}>扫描记录</Button><span>{recordTitle(selected)}</span><Tag>{describeStatus(selected.status)}</Tag></Space>} extra={<Space wrap><Button onClick={()=>{void pages.reload();void batches.reload()}}>刷新页面</Button>{onOpenCorrection&&<Button onClick={()=>onOpenCorrection(selected.id)}>前往纠正与补扫</Button>}{!readOnly&&!pageRows.length&&<Popconfirm title="确认该记录无需接收页面？" description={statistics?'结束该记录的页面接收。':'结束空记录后不再阻塞成绩发布。'} onConfirm={finishEmpty}><Button loading={saving}>结束空记录</Button></Popconfirm>}<Popconfirm title="确认当前页面数量与正反面顺序正确？" description={anonymous?'确认后的每张完整题卡计为一份。':'确认后配对并关联考生入库。'} onConfirm={pair}><Button type="primary" disabled={readOnly||!pageRows.length} loading={saving}>确认配对并入库</Button></Popconfirm></Space>}>
      <Space direction="vertical" size={24} style={{width:'100%'}}>
        <Space wrap><Typography.Text>{label(selected.group_id)}</Typography.Text><Typography.Text type="secondary">背面{selected.back_order==='reverse'?'逆序':'同序'}</Typography.Text></Space>
        <ErrorNotice error={pages.error} retry={pages.reload}/>
        {selectedGroup?.frozen&&<Alert type="info" showIcon message={statistics?'统计收集已结束，当前记录只读。':'该题卡成绩已发布，当前记录只读。如需更正页面或补扫，请先发起成绩复核。'} action={!anonymous&&selectedSubject&&<Button href={examPath({projectId:selectedSubject.project_id,subjectId:selectedSubject.id,gradeId:selectedGroup.grade_id||unassignedGrade,groupId:selectedGroup.id,section:'results'})}>{statistics?'查看统计结果':'前往成绩复核'}</Button>}/>}
        {!selectedGroup?.frozen&&(selected.status==='frozen'||hasPageExceptions)&&<Alert type="warning" showIcon message="当前记录存在异常页面或处于待核查状态" description={anonymous?'请在「纠正与补扫」中核对选项、定位或排除异常页。':'请在「纠正与补扫」中核对考号、执行人工四点定位或排除异常页，恢复批次后再确认配对入库。'} action={onOpenCorrection&&<Button type="primary" onClick={()=>onOpenCorrection(selected.id)}>前往纠正与补扫处理当前记录</Button>}/>}
        <div className="stat-grid"><Statistic title="正面页数" value={frontCount}/><Statistic title="背面页数" value={backCount}/><Statistic title="异常页面" value={pageRows.filter(p=>['error','exception','quarantined','needs_review'].includes(p.status)).length}/></div>
        {!readOnly&&<div className="scan-filters"><Typography.Text strong>导入扫描图片</Typography.Text><TagPicker compact value={side} disabled={saving} onChange={v=>v&&setSide(v)} options={[{label:'正面',value:'front'},...(templates.data.find(t=>t.id===selected.template_id)?.sides===1?[]:[{label:'背面',value:'back'}])]}/><InputNumber disabled={saving} min={1} value={sequence} onChange={v=>setSequence(v||1)} addonBefore="序号"/><Upload accept="image/*" disabled={saving} showUploadList={false} beforeUpload={upload}><Button icon={<UploadOutlined/>} loading={saving}>上传页面</Button></Upload></div>}
        <Table rowKey="id" dataSource={pageRows} loading={pages.loading} columns={[{title:'面',dataIndex:'side',render:v=>v==='back'?'背面':'正面'},{title:'序号',dataIndex:'sequence'},...(!anonymous?[{title:'准考证号',dataIndex:'candidate_number',render:(v:string)=>v||'未识别'}]:[]),{title:'状态',dataIndex:'status',render:v=><Tag color={['error','exception','quarantined','needs_review'].includes(v)?'orange':v==='recognized'?'green':undefined}>{describeStatus(v)}</Tag>},{title:'操作',render:(_,row)=><Space><Button onClick={()=>setPreview(row)}>查看原图</Button>{!selectedGroup?.frozen&&onOpenCorrection&&<Button type="link" onClick={()=>onOpenCorrection(selected.id)}>核对与更正</Button>}</Space>}]}/>
      </Space>
    </Card>}

    <Modal width={900} open={!!preview} onCancel={()=>setPreview(null)} footer={null} title="扫描原图">{preview?.image_url?<AssetImage src={preview.image_url}/>:<Empty description="服务器尚未提供此页面图像"/>}</Modal>
  </Space>
}
