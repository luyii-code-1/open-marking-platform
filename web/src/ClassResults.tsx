import {useEffect,useLayoutEffect,useRef,useState} from 'react'
import {Alert,Drawer,Empty,Segmented,Select,Space,Tag,Typography} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {useResource,type Row} from './api'
import {ResultExport} from './ResultExport'
import {ResultReports,reportColumns} from './ResultReports'
import {CardWorkflow} from './CardWorkflow'
import './class-results.css'

const states:Record<string,string>={completed:'已完成',pending:'待结分',absent:'缺考',unscanned:'未扫描',duplicate_subject:'科目题卡重复'}
const display=(value:unknown)=>value===null||value===undefined?'—':String(value)
const lastClass=()=>{try{return localStorage.getItem('omp-result-class')||''}catch{return ''}}

export function ClassResults({admin,projectId,groupId}:{admin:boolean;projectId?:string;groupId?:string}){
  const catalog=useResource<{projects:Row[]}>('/analysis/class-catalog',{projects:[]})
  const [project,setProject]=useState(projectId||''),[classId,setClass]=useState(lastClass),[card,setCard]=useState(groupId||''),[view,setView]=useState('scores'),[analysis,setAnalysis]=useState(false),[managing,setManaging]=useState(false)
  const tableBox=useRef<HTMLDivElement>(null),[tableHeight,setTableHeight]=useState(320)
  const selected=catalog.data.projects.find(p=>p.id===project)
  const classes=(selected?.classes||[]).filter((c:Row)=>!groupId||selected?.cards.find((g:Row)=>g.id===groupId)?.class_ids.includes(c.id))
  const cls=classes.find((c:Row)=>c.id===classId)
  const cards=(selected?.cards||[]).filter((c:Row)=>c.class_ids.includes(classId)&&(!groupId||c.id===groupId))
  const active=cards.find((c:Row)=>c.id===card)
  useEffect(()=>{
    if(!catalog.loaded)return
    if(projectId&&project!==projectId){setProject(projectId);return}
    const available=groupId?catalog.data.projects.filter(p=>p.cards.some((c:Row)=>c.id===groupId)):catalog.data.projects
    if(!available.some(p=>p.id===(projectId||project)))setProject(projectId||available[0]?.id||'')
  },[catalog.loaded,catalog.data,groupId,projectId,project])
  useEffect(()=>{
    if(!selected)return
    if(!classes.some((c:Row)=>c.id===classId))setClass(classes.length===1?classes[0].id:'')
  },[selected,classId,groupId])
  useEffect(()=>{
    const id=groupId||(cards.length===1&&!cls?.all_subjects?cards[0].id:'')
    if(!cards.some((c:Row)=>c.id===card))setCard(id)
    else if(groupId&&card!==groupId)setCard(groupId)
  },[selected,classId,card,groupId])
  useEffect(()=>{setView('scores');setAnalysis(false)},[card,classId,project])
  const base=new URLSearchParams({project_id:project,class_ids:classId})
  const cardQuery=new URLSearchParams({group_id:card,class_ids:classId})
  const summary=useResource<any>(project&&classId&&!card?`/analysis/project/class-summary?${base}`:null,null)
  const subject=useResource<any>(card&&classId&&view==='scores'?`/analysis/group?${cardQuery}`:null,null)
  const items=useResource<any>(card&&classId&&view==='items'?`/analysis/reports?${cardQuery}`:null,null)
  const resource=card?(view==='items'?items:subject):summary
  const rows=resource.loading?[]:resource.data?.students||[]
  useLayoutEffect(()=>{
    const box=tableBox.current;if(!box)return
    const measure=()=>{
      const body=box.querySelector('.ant-table-body'),pager=box.querySelector('.ant-pagination')
      if(body)setTableHeight(Math.max(120,Math.floor(window.innerHeight-body.getBoundingClientRect().top-(pager?.getBoundingClientRect().height||32)-64)))
    }
    measure();const observer=new ResizeObserver(measure);observer.observe(box)
    window.addEventListener('resize',measure)
    return()=>{observer.disconnect();window.removeEventListener('resize',measure)}
  },[classId,card,view,resource.loading,rows.length])
  const scoreCell=(record:Row)=>record.status==='completed'?display(record.total):states[record.status]||'—'
  const allSubjectColumns=(summary.data?.columns||[]).map((column:Row)=>({key:column.id,title:<Button type="link" onClick={()=>setCard(column.id)}>{column.subject}{column.grade&&cards.filter((c:Row)=>c.subject===column.subject).length>1?' · '+column.grade:''}</Button>,children:[
    {title:'原始分',key:column.id+'-raw',render:(_:unknown,row:Row)=>{const value=row.scores[column.id];return value?value.status==='completed'?display(value.raw):states[value.status]||'—':'—'}},
    ...(column.conversion_enabled?[{title:'赋分',key:column.id+'-converted',render:(_:unknown,row:Row)=>display(row.scores[column.id]?.converted)}]:[])
  ]}))
  const totalsLabel=cls?.all_subjects?'总分':'任教科目合计'
  const summaryColumns=[{title:'准考证号',dataIndex:'candidate_number',fixed:'left' as const,width:150},{title:'姓名',dataIndex:'name',fixed:'left' as const,width:100},...allSubjectColumns,{title:totalsLabel,dataIndex:'total',render:display},{title:cls?.all_subjects?'班内名次':'合计班内名次',dataIndex:'class_rank',render:display,defaultSortOrder:'ascend' as const,sorter:(a:Row,b:Row)=>(a.class_rank??Infinity)-(b.class_rank??Infinity)},{title:'状态',dataIndex:'status',render:(value:string)=>states[value]||value}]
  const subjectColumns=[{title:'准考证号',dataIndex:'candidate_number',fixed:'left' as const,width:150},{title:'姓名',dataIndex:'name',fixed:'left' as const,width:100},{title:'原始分',render:(_:unknown,row:Row)=>scoreCell(row)},...(active?.conversion_enabled?[{title:'赋分',dataIndex:'converted_score',render:display}]:[]),{title:'班内名次',dataIndex:'class_rank',render:display,defaultSortOrder:'ascend' as const,sorter:(a:Row,b:Row)=>(a.class_rank??Infinity)-(b.class_rank??Infinity)},{title:'可见范围名次',dataIndex:'scope_rank',render:display},{title:'状态',dataIndex:'status',render:(value:string)=><Tag>{states[value]||value}</Tag>}]
  const classGroups=[...new Set(classes.map((c:Row)=>String(c.grade||'未设置年级')))].map(grade=>({label:grade,options:classes.filter((c:Row)=>String(c.grade||'未设置年级')===grade).map((c:Row)=>({label:c.name,value:c.id}))}))
  return <section className="class-results">
    <div className="class-results-toolbar">
      <div className="class-results-selectors">
        {!projectId&&!groupId&&<label>考试<Select aria-label="成绩考试" showSearch optionFilterProp="label" value={project||undefined} placeholder="选择考试" options={catalog.data.projects.map(p=>({value:p.id,label:p.name}))} onChange={id=>{setProject(id);setCard('')}}/></label>}
        <label>班级<Select aria-label="成绩班级" showSearch optionFilterProp="label" value={cls?classId:undefined} placeholder="选择班级" disabled={!selected} options={classGroups} onChange={id=>{setClass(id);setCard(groupId||'');try{localStorage.setItem('omp-result-class',id)}catch{}}}/></label>
        {!groupId&&<label>科目<Select aria-label="成绩科目" showSearch optionFilterProp="label" value={active?card:''} disabled={!cls} options={[{label:cls?.all_subjects?'全科总表':'任教科目汇总',value:''},...cards.map((c:Row)=>({value:c.id,label:c.subject+(cards.filter((other:Row)=>other.subject===c.subject).length>1?' · '+c.name:'')}))]} onChange={setCard}/></label>}
      </div>
      <div className="class-results-actions">
        <Button onClick={()=>void resource.reload()} disabled={!cls} loading={resource.loading}>刷新</Button>
        {card&&cls&&<Button onClick={()=>setAnalysis(true)}>分析报表</Button>}
        {admin&&card&&<Button onClick={()=>setManaging(true)}>成绩管理</Button>}
        {selected&&cls&&<ResultExport scope={card?{kind:'card',id:card,query:cardQuery,studentCount:subject.data?.summary?.records||0}:{kind:'project',id:project,query:base,cardCount:cards.length}} parts={[selected.name,String(cls.grade||''),cls.name,active?.subject||'']} disabled={resource.loading||!!resource.error} initialReport="workbook"/>}
      </div>
    </div>
    {(catalog.error||resource.error)&&<Alert type="error" message={catalog.error||resource.error}/>}
    {!cls?<Empty description={catalog.loading?'正在加载考试和班级…':!selected?'暂无可查看的题卡成绩':classes.length?'选择班级后查看成绩':'当前考试暂无可查看班级'}/>:<>
      <div className="class-results-context"><Typography.Text strong>{[selected?.name,cls.grade,cls.name,active?.subject].filter(Boolean).join(' / ')}</Typography.Text>
        {active?<Segmented aria-label="成绩视图" value={view} onChange={setView} options={[{value:'scores',label:'成绩名单'},{value:'items',label:'小题分'}]}/>:<Typography.Text type="secondary">{cls.all_subjects?'点击科目查看单科成绩与小题分':'仅显示已授权的任教科目成绩'}</Typography.Text>}
      </div>
      {card&&view==='scores'&&subject.data&&<div className="class-results-summary"><span>应考 {subject.data.summary.records} 人</span><span>已结分 {subject.data.summary.completed} 人</span><span>平均 {display(subject.data.summary.average)} 分</span><span>缺考 {subject.data.summary.absent} · 未扫描 {subject.data.summary.unscanned} · 待结分 {subject.data.summary.pending}</span></div>}
      {summary.data?.warnings?.length>0&&!card&&<Alert type="warning" message="同一学生同一科目有多份题卡成绩，暂不合计。请切换科目查看各题卡明细。"/>}
      <div ref={tableBox} className="class-results-table">{card&&view==='items'?<Table rowKey="candidate_number" loading={items.loading} dataSource={items.loading?[]:items.data?.reports?.items?.rows||[]} columns={reportColumns(items.data?.reports?.items?.columns||[])} scroll={{x:'max-content',y:tableHeight}}/>:<Table<Row> rowKey="student_id" loading={resource.loading} dataSource={rows} columns={card?subjectColumns:summaryColumns} scroll={{x:'max-content',y:tableHeight}}/>}</div>
    </>}
    {card&&cls&&<ResultReports key={card+classId} groupId={card} classId={classId} open={analysis} onClose={()=>setAnalysis(false)}/>}
    <Drawer title="题卡成绩管理" width={720} open={managing} onClose={()=>setManaging(false)}>{card&&admin&&<CardWorkflow key={card} groupId={card} onSaved={async()=>{await resource.reload();await catalog.reload()}}/>}</Drawer>
  </section>
}
