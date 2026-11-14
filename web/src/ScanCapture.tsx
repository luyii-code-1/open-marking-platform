import {useEffect,useState} from 'react'
import {App,Card,Empty,Form,Input,InputNumber,Modal,Popconfirm,Select,Space,Statistic,Tag,Typography,Upload} from 'antd'
import { Table } from './DataTable'
import {ArrowLeftOutlined,PlusOutlined,ReloadOutlined,UploadOutlined} from '@ant-design/icons'
import {Button} from './Button'
import {describeStatus,download,request,send,useResource,type Row} from './api'
import {RoomTagBadges,RoomTagPicker} from './RoomTags'
import {HierarchyPicker} from './HierarchyPicker'
import {ErrorNotice} from './EntityTable'
import {AssetImage} from './components'
import {cardName} from './examNavigation'
import {rowNavigation} from './rowNavigation'

export function ScanCapture({groupId}:{groupId?:string}){
  const {message}=App.useApp(),[chosenGroup,setGroup]=useState(''),group=groupId||chosenGroup
  const groups=useResource<Row[]>('/groups',[]),subjects=useResource<Row[]>('/subjects',[]),batches=useResource<Row[]>('/scan-batches',[])
  const [selectedId,setSelected]=useState(''),[roomTag,setRoomTag]=useState<string>(),[status,setStatus]=useState<string>(),[saving,setSaving]=useState(false)
  const selected=batches.data.find(b=>b.id===selectedId),pages=useResource<Row[]>(selectedId?`/scan-batches/${selectedId}/pages`:null,[])
  const [side,setSide]=useState('front'),[sequence,setSequence]=useState(1),[preview,setPreview]=useState<Row|null>(null)
  const currentGroup=groups.data.find(g=>g.id===group)
  const workflow=useResource<Row>(group?`/groups/${group}/workflow`:null,{} as Row),templates=useResource<Row[]>('/templates',[])
  const rooms=useResource<Row[]>(group?`/room-tags?group_id=${group}`:null,[])
  const pageRows=pages.data.filter(p=>p.batch_id===selectedId)
  const selectedGroup=groups.data.find(g=>g.id===selected?.group_id),readOnly=!!selectedGroup?.frozen||selected?.status==='paired'||selected?.status==='frozen'
  const rows=batches.data.map(b=>({...b,...workflow.data.batches?.find((v:Row)=>v.id===b.id)})).filter(b=>(!group||b.group_id===group)&&(!roomTag||b.room_tags?.some((t:Row)=>t.id===roomTag))&&(!status||b.status===status))
  const label=(id:string)=>{const g=groups.data.find(g=>g.id===id),s=subjects.data.find(s=>s.id===g?.subject_id);return g?[s?.name,g.grade_name,cardName(g,s)].filter(Boolean).join(' / '):'题卡不可用'}
  useEffect(()=>{if(!pages.loading)setSequence(Math.max(0,...pageRows.filter(p=>p.side===side).map(p=>p.sequence))+1)},[selectedId,side,pages.data,pages.loading])
  async function create(value:object){setSaving(true);try{const batch=await send<Row>('/scan-batches',{...value,...groupId?{group_id:groupId}:{}});await batches.reload();setSelected(batch.id)}catch(e){message.error((e as Error).message)}finally{setSaving(false)}}
  async function pair(){setSaving(true);try{await send(`/scan-batches/${selectedId}/pair`);await Promise.all([pages.reload(),batches.reload(),rooms.reload(),workflow.reload()]);message.success('配对已确认，答卷已入库')}catch(e){message.error((e as Error).message)}finally{setSaving(false)}}
  async function upload(file:File){
    const body=new FormData();body.append('file',file);body.append('capture_id',crypto.randomUUID());body.append('side',side);body.append('sequence',String(sequence));setSaving(true)
    try{await request(`/scan-batches/${selectedId}/pages`,{method:'POST',body});await pages.reload();message.success('页面已上传')}catch(e){message.error((e as Error).message)}finally{setSaving(false)}
    return false
  }
  return <Space direction="vertical" size={24} style={{width:'100%'}}>
    <ErrorNotice error={groups.error||subjects.error||batches.error||rooms.error} retry={batches.reload}/>
    {!selected?<Card title="扫描记录" extra={<Space wrap><Button onClick={()=>download(`/exports/scans?${new URLSearchParams({...group?{group_id:group}:{},...roomTag?{room_tag_id:roomTag}:{}})}`,'扫描记录.csv').catch(e=>message.error(e.message))}>导出记录</Button><Button icon={<ReloadOutlined/>} onClick={batches.reload}>刷新</Button><Button type="primary" disabled={saving||!group||!!currentGroup?.frozen} onClick={()=>create({group_id:group,room_tag_ids:roomTag?[roomTag]:[],back_order:'same'})}>导入扫描图像</Button></Space>}>
      <div className="scan-filters">{!groupId&&<HierarchyPicker value={chosenGroup} allowClear onChange={id=>{setGroup(id);setRoomTag(undefined)}}/>}<RoomTagPicker groupId={group} value={roomTag} onChange={setRoomTag}/><Select allowClear placeholder="全部状态" value={status} onChange={setStatus} style={{width:150}} options={['front','frozen','paired'].map(value=>({value,label:describeStatus(value)}))}/></div>
      {group&&rooms.data.length>0&&<div className="stat-grid compact"><Statistic title="考场" value={rooms.data.filter(r=>!r.archived).length}/><Statistic title="预期人数" value={rooms.data.filter(r=>!r.archived&&(!roomTag||r.id===roomTag)).reduce((n,r)=>n+(r.expected_students||0),0)}/><Statistic title="已确认实考" value={rooms.data.filter(r=>!roomTag||r.id===roomTag).reduce((n,r)=>n+(r.scanned_students||0),0)}/></div>}
      <Table rowKey="id" dataSource={rows} loading={batches.loading} onRow={row=>rowNavigation(()=>setSelected(row.id),`批次${row.id.slice(0,8)}`)} pagination={{defaultPageSize:50,showSizeChanger:true}} scroll={{x:'max-content'}} columns={[
        {title:'扫描记录',dataIndex:'id',render:id=><Button type="link" onClick={()=>setSelected(id)}>{id.slice(0,8)}</Button>},
        ...!groupId?[{title:'题卡',dataIndex:'group_id',render:label}]:[],
        {title:'年级－考场',render:(_:unknown,row:Row)=><RoomTagBadges tags={row.room_tags}/>},
        {title:'考场备注',dataIndex:'room',render:v=>v||'—'},
        {title:'固定版式',render:(_:unknown,row:Row)=>{const t=templates.data.find(t=>t.id===row.template_id);return t?.name||'正式版式'}},
        {title:'服务端已接收',dataIndex:'received_pages',render:v=>v===undefined?'—':`${v} 页`},
        {title:'识读中 / 异常',render:(_:unknown,row:Row)=>row.processing_pages===undefined?'—':`${row.processing_pages} / ${row.exception_pages}`},
        {title:'已入库页数',dataIndex:'linked_pages',render:v=>v??'—'},
        {title:'处理状态',dataIndex:'status',render:v=><Tag>{v==='paired'?'已完成':v==='frozen'?'待核查':'接收与配页中'}</Tag>},
        {title:'操作',className:'row-actions',render:(_:unknown,row:Row)=><Button onClick={()=>setSelected(row.id)}>{row.status==='paired'?'查看记录':row.status==='frozen'?'查看异常':'续扫 / 配页'}</Button>},
      ]}/>
    </Card>:<Card title={<Space><Button icon={<ArrowLeftOutlined/>} disabled={saving} onClick={()=>setSelected('')}>扫描记录</Button><span>记录 {selected.id.slice(0,8)}</span><Tag>{describeStatus(selected.status)}</Tag></Space>} extra={<Space><Button onClick={()=>{void pages.reload();void batches.reload()}}>刷新页面</Button><Popconfirm title="确认本批次页面数量与正反面顺序正确？" description="按本批次题卡和考场配对并关联考生。" onConfirm={pair}><Button type="primary" disabled={readOnly||!pageRows.length} loading={saving}>确认配对并入库</Button></Popconfirm></Space>}>
      <Space direction="vertical" size={24} style={{width:'100%'}}>
        <Space wrap><Typography.Text>{label(selected.group_id)}</Typography.Text><RoomTagBadges tags={selected.room_tags}/><Typography.Text type="secondary">背面{selected.back_order==='reverse'?'逆序':'同序'}</Typography.Text></Space>
        <ErrorNotice error={pages.error} retry={pages.reload}/>
        <div className="stat-grid"><Statistic title="正面页数" value={pageRows.filter(p=>p.side==='front').length}/><Statistic title="背面页数" value={pageRows.filter(p=>p.side==='back').length}/><Statistic title="异常页面" value={pageRows.filter(p=>['error','exception'].includes(p.status)).length}/></div>
        {!readOnly&&<div className="scan-filters"><Typography.Text strong>导入扫描图片</Typography.Text><Select value={side} disabled={saving} onChange={setSide} options={[{label:'正面',value:'front'},{label:'背面',value:'back'}]}/><InputNumber disabled={saving} min={1} value={sequence} onChange={v=>setSequence(v||1)} addonBefore="序号"/><Upload accept="image/*" disabled={saving} showUploadList={false} beforeUpload={upload}><Button icon={<UploadOutlined/>} loading={saving}>上传页面</Button></Upload></div>}
        <Table rowKey="id" dataSource={pageRows} loading={pages.loading} columns={[{title:'面',dataIndex:'side',render:v=>v==='back'?'背面':'正面'},{title:'序号',dataIndex:'sequence'},{title:'准考证号',dataIndex:'candidate_number'},{title:'状态',dataIndex:'status',render:v=><Tag>{describeStatus(v)}</Tag>},{title:'原图',render:(_,row)=><Button onClick={()=>setPreview(row)}>查看原图</Button>}]}/>
      </Space>
    </Card>}

    <Modal width={900} open={!!preview} onCancel={()=>setPreview(null)} footer={null} title="扫描原图">{preview?.image_url?<AssetImage src={preview.image_url}/>:<Empty description="服务器尚未提供此页面图像"/>}</Modal>
  </Space>
}
