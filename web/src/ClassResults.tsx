import {useEffect,useState} from 'react'
import {Alert,Drawer,Empty,Input,Select,Space,Spin,Tag,Typography} from 'antd'
import {ArrowLeftOutlined,ReadOutlined} from '@ant-design/icons'
import {Button} from './Button'
import {Table} from './DataTable'
import {useResource,type Row} from './api'
import {ResultExport} from './ResultExport'
import type {LessonScope} from './PaperLesson'
import {ClassCardReports} from './ResultReports'
import {CardWorkflow} from './CardWorkflow'
import {cardName,rememberExamContext} from './examNavigation'
import {resultState} from './resultFilterParams'
import './class-results.css'

const display=(value:unknown)=>value==null?'—':String(value)
const cardTitle=(card:Row)=>{
  const label=cardName(card,{id:card.subject,name:card.subject})
  return label===card.subject||label===card.subject+'题卡'?card.subject:`${card.subject} · ${label}`
}

function ClassDirectory({classes,onSelect}:{classes:Row[];onSelect:(id:string)=>void}){
  const [term,setTerm]=useState('')
  const grades=new Map<string,Row[]>()
  for(const cls of classes){
    const grade=String(cls.grade||'未设置年级')
    if(!(grade+cls.name).toLocaleLowerCase().includes(term.trim().toLocaleLowerCase()))continue
    if(!grades.has(grade))grades.set(grade,[])
    grades.get(grade)!.push(cls)
  }
  return <div className="class-directory">
    <div className="class-directory-heading"><h3>选择班级</h3><Input.Search allowClear placeholder="搜索年级或班级" aria-label="搜索年级或班级" value={term} onChange={e=>setTerm(e.target.value)}/></div>
    {[...grades].map(([grade,rows])=><section key={grade}><h4>{grade}</h4><div className="class-directory-list">{rows.sort((a,b)=>String(a.name).localeCompare(String(b.name),'zh-CN',{numeric:true})).map(cls=><button key={cls.id} type="button" onClick={()=>onSelect(cls.id)}>{cls.name}</button>)}</div></section>)}
    {!grades.size&&<Empty description={term?'没有匹配的班级':'此范围暂无可查看的班级'}/>}
  </div>
}

function ClassTotals({admin,project,cls,cards,onCard}:{admin:boolean;project:Row;cls:Row;cards:Row[];onCard:(id:string)=>void}){
  const query=new URLSearchParams({project_id:project.id,class_ids:cls.id})
  query.set('group_ids',cards.map(card=>card.id).join(','))
  const data=useResource<any>('/analysis/project/class-summary?'+query,null)
  const columns=(data.data?.columns||[]).filter((col:Row)=>cards.some(card=>card.id===col.id)).map((col:Row)=>{
    const duplicate=cards.filter(card=>card.subject===col.subject).length>1
    const title=<button className="report-subject-link" type="button" onClick={()=>onCard(col.id)}>{col.subject}{duplicate?' · '+col.group:''}</button>
    const score=(key:string)=>(_:unknown,row:Row)=>{
      const value=row.scores[col.id]
      return value?.status==='completed'?display(value[key]):resultState[value?.status]||'—'
    }
    return col.conversion_enabled?{key:col.id,title,children:[{key:col.id+'-raw',title:'原始分',width:76,render:score('raw')},{key:col.id+'-converted',title:'赋分',width:76,render:score('converted')}]}:{key:col.id,title,width:94,render:score('raw')}
  })
  return <section className="class-report-panel">
    <div className="class-report-heading"><h3>班级成绩总表</h3><ResultExport scope={{kind:'project',id:project.id,query,cardCount:cards.length}} parts={[project.name,cls.grade,cls.name]} disabled={!data.data||!!data.error} initialReport="class-summary" quickReport="class-summary"/></div>
    {cards.length>0&&<Space wrap size={[8,8]} style={{marginBottom:12}}>
      <Typography.Text type="secondary">{admin ? '单科成绩与复核：' : '单科明细：'}</Typography.Text>
      {cards.map(c=><Button key={c.id} size="small" onClick={()=>onCard(c.id)}>{cardTitle(c)} <Tag color={c.published?'green':undefined} style={{marginInlineStart:4,marginInlineEnd:0}}>{c.published?'已发布':'未发布'}</Tag></Button>)}
    </Space>}
    {data.error&&<Alert type="error" message={data.error} action={<Button onClick={data.reload}>重试</Button>}/>}
    {data.data?.warnings?.length>0&&<Alert type="warning" message="同一学生同科有多张题卡，点击科目可核对各题卡成绩。"/>}
    <Table<Row> bordered columnChooser={false} rowKey="student_id" loading={data.loading} dataSource={data.data?.students||[]} scroll={{x:'max-content',y:'max(180px, calc(100dvh - 400px))'}} columns={[
      {title:'姓名',dataIndex:'name',width:92,fixed:'left'},{title:'准考证号',dataIndex:'candidate_number',width:122},
      {title:cls.all_subjects?'班内名次':'合计班内名次',dataIndex:'class_rank',width:94,render:display,defaultSortOrder:'ascend',sorter:(a,b)=>(a.class_rank??Infinity)-(b.class_rank??Infinity)},
      {title:cls.all_subjects?'总分':'任教科目合计',dataIndex:'total',width:100,render:display},...columns,
      {title:'状态',dataIndex:'status',width:108,render:(s:string)=>resultState[s]||s},
    ]}/>
  </section>
}

export function ClassResults({admin,projectId,groupId,initialProject,refreshKey,onProjectChange,onCardChange,onLesson}:{onLesson?:(scope:LessonScope)=>void;admin:boolean;projectId?:string;groupId?:string;initialProject?:string;refreshKey?:number;onProjectChange?:(id:string)=>void;onCardChange?:(id:string)=>void}){
  const catalog=useResource<{projects:Row[]}>('/analysis/class-catalog',{projects:[]})
  const [choice,setChoice]=useState(initialProject||''),[classId,setClass]=useState(''),[cardId,setCard]=useState(''),[managing,setManaging]=useState(false)
  useEffect(()=>{if(initialProject&&initialProject!==choice)setChoice(initialProject)},[initialProject])
  useEffect(()=>{if(refreshKey)void catalog.reload()},[refreshKey])
  const projects=catalog.data.projects
  const project=projectId?projects.find(p=>p.id===projectId):groupId?projects.find(p=>p.cards.some((g:Row)=>g.id===groupId)):projects.find(p=>p.id===choice)||projects[0]
  const fixed=groupId?project?.cards.find((c:Row)=>c.id===groupId):undefined
  const classes:Row[]=(project?.classes||[]).filter((c:Row)=>!groupId||fixed?.class_ids.includes(c.id))
  const cls=classes.find(c=>c.id===classId)
  const cards:Row[]=(project?.cards||[]).filter((c:Row)=>c.class_ids.includes(classId)&&(!groupId||c.id===groupId))
  const card=cards.find(c=>c.id===(groupId||cardId))
  const managementCard=groupId?undefined:(card||(cls&&cards.length===1?cards[0]:undefined))
  function chooseCard(id:string){
    setCard(id)
    if(id){
      if(admin)rememberExamContext({projectId:project?.id,groupId:id})
      onCardChange?.(id)
    }
  }
  if(catalog.error)return <Alert type="error" message={catalog.error} action={<Button onClick={catalog.reload}>重试</Button>}/>
  if(!catalog.loaded)return <Spin/>
  return <section className="class-results">
    <div className="class-results-heading">
      {!projectId&&!groupId&&<Select aria-label="成绩考试" showSearch optionFilterProp="label" value={project?.id} placeholder="选择考试" options={projects.map(p=>({label:p.name,value:p.id}))} onChange={id=>{setChoice(id);setClass('');setCard('');setManaging(false);onProjectChange?.(id)}}/>}
      {cls&&<><Button type="text" icon={<ArrowLeftOutlined/>} onClick={()=>{if(card&&!groupId)setCard('');else{setClass('');setCard('')}setManaging(false)}}>{card&&!groupId?'班级总表':'班级列表'}</Button><strong>{[cls.grade,cls.name,card?.subject].filter(Boolean).join(' / ')}</strong></>}
      {onLesson&&cls&&project&&(card?.published||cards.some(c=>c.published))&&<Button type="primary" icon={<ReadOutlined/>} onClick={()=>onLesson({project:project.id,cls:cls.id,card:(card?.published?card.id:cards.find(c=>c.published)?.id)})}>讲评试卷</Button>}
      {admin&&managementCard&&<Button className="class-management" onClick={()=>setManaging(true)}>成绩管理</Button>}
    </div>
    {!project?<Empty description={admin?'暂无可查看的考试成绩，请先在考试项目中发布题卡并配置应考名单或扫描答卷':'暂无已发布的任教班级成绩'}/>:!cls?<ClassDirectory key={project.id} classes={classes} onSelect={id=>{setClass(id);setCard('')}}/>:card?<ClassCardReports key={card.id+cls.id} project={project} card={card} cls={cls}/>:<ClassTotals key={project.id+cls.id} admin={admin} project={project} cls={cls} cards={cards} onCard={chooseCard}/>}
    {admin&&managementCard&&<Drawer title={`题卡成绩管理 · ${[project?.name,managementCard.grade,cardTitle(managementCard)].filter(Boolean).join(' / ')}`} width={720} open={managing} onClose={()=>setManaging(false)}><CardWorkflow key={managementCard.id} groupId={managementCard.id} onSaved={catalog.reload}/></Drawer>}
  </section>
}
