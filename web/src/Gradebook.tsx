import {useState} from 'react'
import {Alert,App,Card,Empty,Input,Modal,Select,Space,Tabs,Typography} from 'antd'
import {Table} from './DataTable'
import {Button} from './Button'
import {MultipleRecordSelect,RecordSelect} from './RecordSelect'
import {download,useResource,type Row} from './api'

type Scope={projectId?:string;subjectId?:string;gradeId?:string;groupId?:string}
type Column={key:string;label:string}
type Report={rows:Row[];columns:Column[];total:number;version:string;options:Record<string,Row[]>}
const blank:Report={rows:[],columns:[],total:0,version:'',options:{}}
const tableColumns=(columns:Column[])=>columns.map(c=>({key:c.key,title:c.label,dataIndex:c.key,sorter:false as const,render:(v:unknown)=>v===null||v===undefined?'—':String(v)}))

function ExportPreview({query,columns,onClose}:{query:string;columns:Column[];onClose:()=>void}){
  const [selected,setSelected]=useState(columns.map(c=>c.key)),[page,setPage]=useState(1),[format,setFormat]=useState('xlsx'),[busy,setBusy]=useState(false)
  const params=new URLSearchParams(query);params.set('columns',selected.join(','));params.set('page',String(page))
  const preview=useResource<Report>(selected.length?'/gradebook?'+params:null,blank),{message}=App.useApp()
  async function save(){
    if(!selected.length||!preview.data.version)return
    setBusy(true)
    try{params.set('format',format);params.set('preview_version',preview.data.version);await download('/gradebook?'+params,'成绩.'+format)}
    catch(e){message.error((e as Error).message);await preview.reload()}
    finally{setBusy(false)}
  }
  return <Modal title="导出配置与预览" width="90vw" open onCancel={()=>!busy&&onClose()} onOk={save} okText="下载" confirmLoading={busy} okButtonProps={{disabled:!selected.length||!preview.loaded||preview.loading||!!preview.error}}>
    <Space wrap><MultipleRecordSelect title="导出列" records={columns.map(c=>({id:c.key,name:c.label}))} value={selected} onChange={ids=>{setSelected(ids);setPage(1)}}/><Select aria-label="导出格式" value={format} onChange={setFormat} options={[{value:'xlsx',label:'Excel'},{value:'csv',label:'CSV'}]}/></Space>
    <Typography.Paragraph type="secondary">预览与下载使用相同的筛选、列及成绩版本；数据变化后需要重新预览。共 {preview.data.total} 行。</Typography.Paragraph>
    {preview.error&&<Alert type="error" message={preview.error}/>}
    <Table query="" columnChooser={false} rowKey="student_id" loading={preview.loading} dataSource={preview.loading?[]:preview.data.rows} columns={tableColumns(preview.data.columns)} pagination={{current:page,pageSize:50,total:preview.data.total,onChange:setPage,showSizeChanger:false}}/>
  </Modal>
}

export function Gradebook({projectId,subjectId,gradeId,groupId}:Scope){
  const projects=useResource<Row[]>(projectId?null:'/projects',[]),[chosen,setChosen]=useState('')
  const project=projectId||chosen
  return <Space direction="vertical" style={{width:'100%'}}>
    {!projectId&&<Card><RecordSelect title="考试项目" records={projects.data} value={chosen} onChange={setChosen}/>{projects.error&&<Alert type="error" message={projects.error}/>}</Card>}
    {project?<GradebookScope key={[project,subjectId,gradeId,groupId].join(':')} projectId={project} subjectId={subjectId} gradeId={gradeId} groupId={groupId}/>:<Empty description="选择考试项目查看或导出成绩"/>}
  </Space>
}

function GradebookScope({projectId,subjectId,gradeId,groupId}:Scope){
  const [view,setView]=useState('totals'),[metric,setMetric]=useState('raw'),[page,setPage]=useState(1),[filters,setFilters]=useState<Record<string,string[]>>({}),[text,setText]=useState(''),[q,setQ]=useState(''),[exporting,setExporting]=useState(false)
  const params=new URLSearchParams({project_id:projectId!,view,metric: view==='items'?'raw':metric,q})
  if(subjectId)params.set('subject_id',subjectId)
  if(gradeId)params.set('grade_id',gradeId)
  if(groupId)params.set('group_id',groupId)
  Object.entries(filters).forEach(([key,ids])=>{if(ids.length)params.set(key,ids.join(','))})
  const query=params.toString();params.set('page',String(page))
  const data=useResource<Report>('/gradebook?'+params,blank)
  const change=(key:string,ids:string[])=>{setFilters(f=>({...f,[key]:ids}));setPage(1)}
  return <>
    <Card><Space wrap align="start">
      {!subjectId&&<MultipleRecordSelect title="科目" records={data.data.options.subjects||[]} value={filters.subject_ids} onChange={ids=>change('subject_ids',ids)}/>}
      {!gradeId&&<MultipleRecordSelect title="年级" records={data.data.options.grades||[]} value={filters.grade_ids} onChange={ids=>change('grade_ids',ids)}/>}
      <MultipleRecordSelect title="班级" records={data.data.options.classes||[]} value={filters.class_ids} onChange={ids=>change('class_ids',ids)}/>
      <MultipleRecordSelect title="学生" records={data.data.options.students||[]} value={filters.student_ids} onChange={ids=>change('student_ids',ids)}/>
      {!groupId&&<MultipleRecordSelect title="题卡" records={data.data.options.groups||[]} value={filters.group_ids} onChange={ids=>change('group_ids',ids)}/>}
      <Select mode="multiple" aria-label="成绩状态" placeholder="成绩状态" style={{minWidth:160}} value={filters.statuses||[]} onChange={ids=>change('statuses',ids)} options={(data.data.options.statuses||[]).map(r=>({value:r.id,label:r.name}))}/>
      <Input.Search aria-label="搜索考生" placeholder="姓名或准考证号" style={{width:230}} value={text} onChange={e=>setText(e.target.value)} onSearch={()=>{setQ(text);setPage(1)}} allowClear/>
      <Button onClick={()=>{setFilters({});setText('');setQ('');setPage(1)}}>重置条件</Button>
    </Space></Card>
    <Alert type="info" showIcon message={groupId?'当前题卡自身成绩；总分按当前可见范围混合排名':'汇总已发布成绩；同一学生同科多份题卡记录标记为异常卷'} description="默认显示裸分；小题分始终显示原始得分。同分并列，后续名次跳号。"/>
    <Card title={groupId?'题卡成绩':subjectId?'科目成绩':'成绩总览'} extra={<Space>{view==='totals'&&<Select aria-label="总分口径" value={metric} onChange={v=>{setMetric(v);setPage(1)}} options={[{value:'raw',label:'裸分'},{value:'converted',label:'赋分'}]}/>}<Button onClick={data.reload}>刷新</Button><Button disabled={!data.loaded||data.loading||!!data.error} onClick={()=>setExporting(true)}>导出与预览</Button></Space>}>
      {data.error&&<Alert type="error" message={data.error}/>}
      <Tabs activeKey={view} onChange={v=>{setView(v);setPage(1)}} items={[{key:'totals',label:groupId?'裸分（总分）':'概览成绩'},{key:'items',label:'小题分'}]}/>
      <Table query="" columnChooser rowKey="student_id" loading={data.loading} dataSource={data.loading?[]:data.data.rows} columns={tableColumns(data.data.columns)} pagination={{current:page,pageSize:50,total:data.data.total,onChange:setPage,showSizeChanger:false}}/>
    </Card>
    {exporting&&<ExportPreview key={query} query={query} columns={data.data.columns} onClose={()=>setExporting(false)}/>}
  </>
}
