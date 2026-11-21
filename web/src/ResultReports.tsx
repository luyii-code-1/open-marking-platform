import {useState} from 'react'
import {Alert,Input,InputNumber,Tabs} from 'antd'
import type {ColumnsType} from 'antd/es/table'
import {Button} from './Button'
import {Table} from './DataTable'
import {useResource,type Row} from './api'
import {ResultExport} from './ResultExport'
import {resultState} from './resultFilterParams'

const reports={items:'小题分',averages:'小题平均分对比',questions:'试题分析',ranks:'名次段分析',bands:'分数段分析'}
type Report=keyof typeof reports
const display=(value:unknown)=>value==null?'—':String(value)
function columns(list:Row[]):ColumnsType<Row>{
  return list.map(col=>col.children?{title:col.title,key:col.key||col.title,children:columns(col.children)}:{
    title:col.title,key:col.key,dataIndex:col.key,width:col.key==='candidate_number'?122:Math.max(70,Math.min(170,col.width*7)),
    fixed:col.key==='candidate_number'?'left':undefined,render:display})
}

export function ClassCardReports({project,card,cls}:{project:Row;card:Row;cls:Row}){
  const [tab,setTab]=useState<Report|'scores'>('items')
  const [step,setStep]=useState<number|null>(10),[limits,setLimits]=useState('10,30,50,100,200')
  const [applied,apply]=useState({step:10,limits:'10,30,50,100,200'})
  const query=new URLSearchParams({group_id:card.id,class_ids:cls.id,score_step:String(applied.step),ranks:applied.limits})
  const formal=useResource<any>('/analysis/reports?'+query,null)
  const scores=useResource<any>(tab==='scores'?'/analysis/group?'+new URLSearchParams({group_id:card.id,class_ids:cls.id}):null,null)
  const data=tab==='scores'?scores:formal,report=tab==='scores'?null:formal.data?.reports[tab]
  const total=formal.data?.summary
  const ranking:ColumnsType<Row>=[{title:'姓名',dataIndex:'name',fixed:'left',width:92},{title:'准考证号',dataIndex:'candidate_number',width:122},{title:'原始分',dataIndex:'total',render:(v,r)=>r.status==='completed'?display(v):'—'},...(card.conversion_enabled?[{title:'赋分',dataIndex:'converted_score',render:display}]:[]),{title:'班内名次',dataIndex:'class_rank',render:display,defaultSortOrder:'ascend',sorter:(a,b)=>(a.class_rank??Infinity)-(b.class_rank??Infinity)},{title:'可见范围名次',dataIndex:'scope_rank',render:display},{title:'状态',dataIndex:'status',render:s=>resultState[s]||s}]
  return <section className="class-report-panel"><div className="class-report-heading"><h3>{card.name}</h3><ResultExport scope={{kind:'card',id:card.id,query,studentCount:total?.records||0}} quickReport={tab==='scores'?'ranking':tab} initialReport={tab==='scores'?'ranking':tab} parts={[project.name,cls.grade,cls.name,card.subject]} disabled={!data.data||!!data.error}/></div>
    {total&&<div className="report-counts"><span>应考 {total.records}</span><span>已结分 {total.completed}</span><span>待结分 {total.pending}</span><span>缺考 {total.absent}</span><span>未扫描 {total.unscanned}</span></div>}
    <Tabs activeKey={tab} onChange={key=>setTab(key as typeof tab)} items={Object.entries({...reports,scores:'成绩与名次'}).map(([key,label])=>({key,label}))}/>
    {(tab==='bands'||tab==='ranks')&&<div className="report-parameters">{tab==='bands'?<label>每段分数 <InputNumber value={step} onChange={setStep} min={0.01}/></label>:<label>累计名次 <Input value={limits} onChange={e=>setLimits(e.target.value)}/></label>}<Button onClick={()=>apply(prev=>tab==='bands'?{...prev,step:step??10}:{...prev,limits})}>应用</Button></div>}
    {data.error&&<Alert type="error" message={data.error}/>}
    <Table<Row> key={tab} bordered columnChooser={false} rowKey={r=>r.student_id||r.candidate_number||r.question||r.band||r.class||r.number} loading={data.loading} dataSource={data.error?[]:tab==='scores'?scores.data?.students||[]:report?.rows||[]} columns={tab==='scores'?ranking:columns(report?.columns||[])} scroll={{x:'max-content',y:'max(180px, calc(100dvh - 438px))'}}/>
  </section>
}
