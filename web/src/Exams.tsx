import { RoomTagManager } from './RoomTags'
import { useEffect,useState } from 'react'
import { App,Breadcrumb,Card,Empty,Form,Input,Modal,Popconfirm,Select,Tooltip,Space,Spin,Tabs,Tag,Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ArrowLeftOutlined,RightOutlined,PlusOutlined } from '@ant-design/icons'
import { send,useResource,type Row,type Template } from './api'
import { HierarchyDelete } from './HierarchyDelete'
import { EntityTable,ErrorNotice } from './EntityTable'
import { ArchiveManager } from './ArchiveManager'
import { Roster } from './Roster'
import { TemplateEditor } from './TemplateEditor'
import { Scans } from './Management'
import { ReviewAllocation } from './ReviewAllocation'
import { Exceptions } from './Exceptions'
import { Results } from './Results'
import { ProjectStorage } from './StorageConnections'
import { cardName,examPath,groupSections,resolveExam,subjectGrades,unassignedGrade,type ExamLocation } from './examNavigation'
import { rowNavigation } from './rowNavigation'

const { Title,Text }=Typography
export function Exams({location,navigate}:{location:ExamLocation;navigate:(path:string,replace?:boolean)=>void}){
  const projects=useResource<Row[]>('/projects',[]),subjects=useResource<Row[]>('/subjects',[]),groups=useResource<Row[]>('/groups',[]),grades=useResource<Row[]>('/grades',[])
  const ready=projects.loaded&&subjects.loaded&&groups.loaded&&grades.loaded
  const {project,subject,group,invalid}=resolveExam(location,projects.data,subjects.data,groups.data)
  const returnKey='omp-designer-return:'+location.groupId
  const go=(value:ExamLocation)=>{if(value.section==='template'&&location.section!=='template')sessionStorage.setItem(returnKey,JSON.stringify({location,scrollY:window.scrollY}));navigate(examPath(value))}
  useEffect(()=>{if(!ready||location.section==='template')return;try{const stored=JSON.parse(sessionStorage.getItem(returnKey)||'null');if(stored&&examPath(stored.location)===examPath(location)){requestAnimationFrame(()=>window.scrollTo(0,stored.scrollY));sessionStorage.removeItem(returnKey)}}catch{}},[ready,location])
  const gradeId=location.gradeId,grade=subject?subjectGrades(subject,groups.data,grades.data).find(g=>g.id===gradeId):undefined
  const base={projectId:project?.id,subjectId:subject?.id,gradeId,groupId:group?.id}
  const error=projects.error||subjects.error||groups.error||grades.error
  const refresh=async()=>{await Promise.all([projects.reload(),subjects.reload(),groups.reload(),grades.reload()])}
  const canonical=!!group&&(!gradeId||gradeId===unassignedGrade&&!!group.grade_id)
  useEffect(()=>{if(ready&&canonical&&project&&subject&&group)navigate(examPath({...location,projectId:project.id,subjectId:subject.id,gradeId:group.grade_id||unassignedGrade}),true)},[ready,canonical,group?.id,group?.grade_id,gradeId])
  if(error&&(!ready||invalid&&!canonical))return <ErrorNotice error={error} retry={refresh}/>
  if(!ready||canonical)return <div className="workspace-loading"><Spin/></div>
  if(invalid)return <Card><Empty description="该考试位置不存在或已不可访问"><Button onClick={()=>go({})}>返回考试项目</Button></Empty></Card>
  const back:ExamLocation=group?{projectId:project!.id,subjectId:subject!.id,gradeId}:grade?{projectId:project!.id,subjectId:subject!.id}:subject?{projectId:project!.id}:{}
  const crumbs=[{title:<a href={examPath()}>考试项目</a>},
    ...project?[{title:<a href={examPath({projectId:project.id})}>{project.name}</a>}]:[],
    ...subject?[{title:<a href={examPath({projectId:project!.id,subjectId:subject.id})}>{subject.name}</a>}]:[],
    ...grade?[{title:<a href={examPath({projectId:project!.id,subjectId:subject!.id,gradeId})}>{grade.name}</a>}]:[],
    ...group?[{title:cardName(group,subject)}]:[]]
  if(group&&location.section==='template')return <div className="template-design-page"><header className="template-context"><Button icon={<ArrowLeftOutlined/>} onClick={()=>{let target:ExamLocation={...base,section:'overview'};try{const saved=JSON.parse(sessionStorage.getItem(returnKey)||'null');if(saved?.location?.groupId===group.id&&saved.location.section!=='template')target=saved.location}catch{}go(target)}}>返回工作台</Button><Breadcrumb items={[...crumbs,{title:'题卡设计'}]}/></header><TemplateEditor key={group.id} groupId={group.id}/></div>
  const children=groups.data.filter(g=>g.subject_id===subject?.id&&(g.grade_id||unassignedGrade)===gradeId)
  const enterCard=(row:Row)=>go({...base,groupId:row.id})
  const cardColumns=[
    {title:'题卡名称',dataIndex:'name',render:(_:string,row:Row)=><a href={examPath({...base,groupId:row.id})}>{cardName(row,subject)}</a>},
    {title:'版式',render:(_:unknown,row:Row)=>row.template_id?'已发布':'待设计'},
    {title:'应考名单',render:(_:unknown,row:Row)=>row.roster_mode==='selected'?'指定名单':row.grade_id?'年级全体':'待设置'},
    {title:'成绩',render:(_:unknown,row:Row)=><Tag color={row.frozen?'green':'default'}>{row.frozen?'已发布':'未发布'}</Tag>},
    {title:'操作',className:'row-actions',render:(_:unknown,row:Row)=><Space><Rename kind="groups" row={row} refresh={refresh}/><CardGrade group={row} grades={grades.data} onSaved={async()=>{await refresh();go({projectId:project!.id,subjectId:subject!.id})}}/><HierarchyDelete kind="groups" target={row} onDeleted={refresh}/></Space>},
  ]
  return <div className="exam-workspace"><ErrorNotice error={error} retry={refresh}/><Breadcrumb items={crumbs}/>
    {project&&<div className="workspace-heading"><Space align="start"><Button type="text" className="hierarchy-back" icon={<ArrowLeftOutlined/>} aria-label={group?'返回题卡列表':grade?'返回年级列表':subject?'返回科目列表':'返回考试项目'} onClick={()=>go(back)}/><div><Title level={3}>{group?cardName(group,subject):grade?.name||subject?.name||project.name}</Title><Text type="secondary">{group?`${subject!.name} · ${grade?.name} · ${group.frozen?'成绩已发布':'成绩未发布'}`:grade?`${children.length} 份题卡`:subject?`${subjectGrades(subject,groups.data).length} 个年级`:`${subjects.data.filter(s=>s.project_id===project.id).length} 门科目`}</Text></div></Space>{!grade||group?<HierarchyDelete kind={group?'groups':subject?'subjects':'projects'} target={group||subject||project} onDeleted={async()=>{navigate(examPath(back),true);await refresh()}}/>:null}</div>}
    {!project?<EntityTable path="/projects" title="考试项目" fields={[{name:'name',label:'考试名称'}]} resource={projects} onEnter={row=>go({projectId:row.id})} onCreated={async row=>{await refresh();if(row)go({projectId:row.id})}} columns={[
      {title:'考试名称',dataIndex:'name',render:(name:string,row:Row)=><a href={examPath({projectId:row.id})}>{name}</a>},
      {title:'科目',render:(_:unknown,row:Row)=>`${subjects.data.filter(s=>s.project_id===row.id).length} 门`},
      {title:'操作',className:'row-actions',render:(_:unknown,row:Row)=><Space><Rename kind="projects" row={row} refresh={refresh}/><HierarchyDelete kind="projects" target={row} onDeleted={refresh}/></Space>},
    ]}/>:group?<GroupWorkspace key={group.id} group={group} project={project} section={location.section||'overview'} onSection={section=>go({...base,section})} onRooms={()=>go({projectId:project.id,section:'rooms'})}/>:grade?grade.id===unassignedGrade?<Card title="待设置年级的题卡"><Table rowKey="id" dataSource={children} columns={cardColumns} onRow={row=>rowNavigation(()=>enterCard(row),cardName(row,subject))}/></Card>:<EntityTable key={subject!.id+grade.id} path="/groups" title="题卡" resource={groups} allowImport={false} scope={{subject_id:subject!.id,grade_id:grade.id}} fields={[{name:'name',label:'题卡名称'}]} onEnter={enterCard} onCreated={async row=>{await refresh();if(row)enterCard(row)}} columns={cardColumns}/>:subject?<SubjectGrades subject={subject} groups={groups.data} grades={grades.data} onEnter={id=>go({...base,gradeId:id})} refresh={refresh}/>:<Tabs activeKey={location.section||'subjects'} onChange={section=>go({projectId:project.id,section})} items={[
      {key:'subjects',label:'科目',children:<EntityTable key={project.id} path="/subjects" title="科目" resource={subjects} scope={{project_id:project.id}} fields={[{name:'name',label:'科目名称'}]} onEnter={row=>go({projectId:project.id,subjectId:row.id})} onCreated={async row=>{await refresh();if(row)go({projectId:project.id,subjectId:row.id})}} columns={[
        {title:'科目名称',dataIndex:'name',render:(name:string,row:Row)=><a href={examPath({projectId:project.id,subjectId:row.id})}>{name}</a>},
        {title:'年级',render:(_:unknown,row:Row)=>`${subjectGrades(row,groups.data).length} 个`},
        {title:'题卡',render:(_:unknown,row:Row)=>`${groups.data.filter(g=>g.subject_id===row.id).length} 份`},
        {title:'操作',className:'row-actions',render:(_:unknown,row:Row)=><Space><Rename kind="subjects" row={row} refresh={refresh}/><HierarchyDelete kind="subjects" target={row} onDeleted={refresh}/></Space>},
      ]}/>},
      {key:'rooms',label:'考场设置',children:<RoomTagManager projectId={project.id}/>},
      {key:'summary',label:'跨科成绩',children:<Results admin projectId={project.id} projectOnly/>},
      {key:'storage',label:'存储设置',children:<ProjectStorage project={project} onSaved={refresh}/>},
      {key:'archives',label:'归档与释放',children:<ArchiveManager projectId={project.id}/>},
    ]}/>}
  </div>
}
function Rename({kind,row,refresh}:{kind:string;row:Row;refresh:()=>Promise<void>}){
  const [open,setOpen]=useState(false),[name,setName]=useState(''),[busy,setBusy]=useState(false),{message}=App.useApp()
  return <><Button type="link" onClick={()=>{setName(row.name);setOpen(true)}}>编辑</Button><Modal title="编辑名称" open={open} onCancel={()=>!busy&&setOpen(false)} confirmLoading={busy} okButtonProps={{disabled:!name.trim()}} onOk={async()=>{setBusy(true);try{await send(`/${kind}/${row.id}/name`,{name},'PUT');setOpen(false);await refresh()}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}}><Input value={name} onChange={e=>setName(e.target.value)} maxLength={100}/></Modal></>
}
function CardGrade({group,grades,onSaved}:{group:Row;grades:Row[];onSaved:()=>Promise<void>}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[form]=Form.useForm(),{message}=App.useApp()
  async function save(body:object){setBusy(true);try{await send(`/groups/${group.id}/grade`,body,'PUT');setOpen(false);await onSaved()}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  return <><Button type="link" disabled={group.frozen} onClick={()=>{form.setFieldsValue({grade_id:group.grade_id});setOpen(true)}}>{group.grade_id?'调整年级':'设置年级'}</Button>
    <Modal title={`设置年级 · ${group.name==='Default'?'默认题卡':group.name}`} open={open} onCancel={()=>!busy&&setOpen(false)} onOk={()=>form.submit()} confirmLoading={busy}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="grade_id" label="全局年级" rules={[{required:true,message:'请选择年级'}]}><Select showSearch optionFilterProp="label" options={grades.filter(g=>!g.archived||g.id===group.grade_id).map(g=>({label:g.name,value:g.id}))}/></Form.Item></Form></Modal></>
}
function SubjectGrades({subject,groups,grades,onEnter,refresh}:{subject:Row;groups:Row[];grades:Row[];onEnter:(id:string)=>void;refresh:()=>Promise<void>}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[form]=Form.useForm(),{message}=App.useApp()
  const [editing,setEditing]=useState<Row|null>(null),[editForm]=Form.useForm()
  const rows=subjectGrades(subject,groups,grades),available=grades.filter(g=>!g.archived&&!rows.some(r=>r.id===g.id))
  async function save(body:object){setBusy(true);try{await send(`/subjects/${subject.id}/grades`,body);await refresh();setOpen(false);form.resetFields()}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  async function edit(body:object){if(!editing)return;setBusy(true);try{await send(`/grades/${editing.id}`,body,'PUT');await refresh();setEditing(null)}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  async function remove(id:string){try{await send(`/subjects/${subject.id}/grades/${id}`,undefined,'DELETE');await refresh()}catch(e){message.error((e as Error).message)}}
  return <Card title="年级" extra={<Button type="primary" icon={<PlusOutlined/>} disabled={!available.length} onClick={()=>setOpen(true)}>添加年级</Button>}>
    <Table rowKey="id" dataSource={rows} onRow={row=>rowNavigation(()=>onEnter(row.id),row.name)} columns={[{title:'年级',dataIndex:'name',render:(name:string,row:Row)=><Button type="link" onClick={()=>onEnter(row.id)}>{name}</Button>},{title:'题卡',dataIndex:'count',render:n=>`${n} 份`},{title:'操作',className:'row-actions',render:(_:unknown,row:Row)=>row.id===unassignedGrade?<Button type="link" onClick={()=>onEnter(row.id)}>设置题卡年级</Button>:<Space><Button type="link" onClick={()=>{editForm.setFieldsValue({name:row.name});setEditing(row)}}>编辑</Button><Tooltip title={row.count?'请先调整该年级下的题卡或删除题卡':undefined}><span><Popconfirm title="移除该科目的年级关联？" description="全局年级、班级和学生资料保留。" disabled={!!row.count} onConfirm={()=>remove(row.id)}><Button type="link" danger disabled={!!row.count}>移除</Button></Popconfirm></span></Tooltip></Space>}]} locale={{emptyText:'添加全局年级后，即可在该年级下创建题卡'}}/>
    {!grades.some(g=>!g.archived)&&<Text type="secondary">请先在人员管理中创建年级。</Text>}
    <Modal title="编辑年级" open={!!editing} onCancel={()=>!busy&&setEditing(null)} onOk={()=>editForm.submit()} confirmLoading={busy}><Typography.Paragraph type="secondary">年级属于全局资料，名称修改会同步显示在所有考试及人员管理中。</Typography.Paragraph><Form form={editForm} layout="vertical" onFinish={edit}><Form.Item name="name" label="年级名称" rules={[{required:true,whitespace:true,message:'请填写年级名称'}]}><Input maxLength={60}/></Form.Item></Form></Modal>
    <Modal title="添加年级" open={open} onCancel={()=>!busy&&setOpen(false)} onOk={()=>form.submit()} confirmLoading={busy}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="grade_id" label="全局年级" rules={[{required:true,message:'请选择年级'}]}><Select showSearch optionFilterProp="label" options={available.map(g=>({label:g.name,value:g.id}))}/></Form.Item></Form></Modal>
  </Card>
}
function GroupWorkspace({group,project,section,onSection,onRooms}:{group:Row;project:Row;section:string;onSection:(section:string)=>void;onRooms:()=>void}){
  return <Tabs activeKey={section} onChange={onSection} tabBarExtraContent={<Button onClick={()=>onSection('template')}>题卡设计</Button>} items={groupSections.filter(([key])=>key!=='template').map(([key,label])=>({key,label,children:
    key==='overview'?<GroupOverview group={group} onSection={onSection}/>:
    (key==='scans'||key==='marking')&&!group.template_id?<Card><Empty description={key==='scans'?'发布题卡后即可建立扫描批次':'发布题卡后即可分配教师与阅卷'}><Button type="primary" onClick={()=>onSection('template')}>设计题卡</Button></Empty></Card>:
    key==='template'?<TemplateEditor groupId={group.id}/>:key==='roster'?<Roster groupId={group.id}/>:
    key==='scans'?<Space direction="vertical" size={24} style={{width:'100%'}}><div><Button onClick={onRooms}>考场设置</Button></div><Scans groupId={group.id}/></Space>:key==='marking'?<ReviewAllocation templateId={group.template_id} frozen={!!group.frozen}/>:
    key==='exceptions'?<Exceptions groupId={group.id}/>:<Results admin groupId={group.id} projectId={project.id}/>,
  }))}/>
}
function GroupOverview({group,onSection}:{group:Row;onSection:(section:string)=>void}){
  const workflow=useResource<Row>(`/groups/${group.id}/workflow`,{} as Row)
  const templates=useResource<Template[]>('/templates',[]),roster=useResource<any>(`/groups/${group.id}/roster`,null)
  const template=templates.data.find(t=>t.id===group.template_id),drafts=templates.data.filter(t=>t.group_id===group.id&&t.status==='draft')
  const entries=[
    {key:'template',label:'题卡设计',detail:template?`${template.name} · 已发布`:drafts.length?`${drafts.length} 份草稿待发布`:'创建或从题卡库选用版式'},
    {key:'roster',label:'应考名单',detail:roster.data?.configured?`${roster.data.students.length} 名学生 · ${roster.data.mode==='selected'?'指定名单':'年级全体'}`:'设置年级或导入名单'},
    {key:'scans',label:'扫描与补扫',detail:workflow.data.group_id?`考场预期 ${workflow.data.room_expected} 人 · 已入库实考 ${workflow.data.scanned} 人 · ${workflow.data.open_batches} 个批次待完成`:'按考场查看批次、页面与配对情况'},
    {key:'marking',label:'阅卷分配',detail:workflow.data.results?`${workflow.data.results.pending} 份答卷待结分`:'管理阅卷池与仲裁池'},
    {key:'exceptions',label:'异常核查',detail:workflow.data.group_id?`${workflow.data.open_exceptions} 项待核查`:'核查识别与评阅中的待处理事项'},
    {key:'results',label:'成绩',detail:group.frozen?'成绩已发布':'检查统计并确认发布'},
  ]
  const w=workflow.data,next=!group.template_id?'template':w.roster_needs_review?'roster':w.open_exceptions?'exceptions':(w.open_batches||!w.scan_closed)?'scans':w.results?.pending?'marking':'results'
  return <><ErrorNotice error={templates.error||roster.error||workflow.error}/>{w.group_id&&!group.frozen&&<Card title="当前待办" style={{marginBottom:24}}><Space><Text>{entries.find(e=>e.key===next)?.detail}</Text><Button type="primary" onClick={()=>onSection(next)}>{next==='roster'?'核对应考名单':entries.find(e=>e.key===next)?.label}</Button></Space></Card>}<div className="group-work-grid">{entries.map(item=><button type="button" className="workspace-entry" key={item.key} onClick={()=>onSection(item.key)}><span className="workspace-entry-title">{item.label}<RightOutlined/></span><span className="workspace-entry-detail">{item.detail}</span></button>)}</div></>
}
