import {AnswerDetails} from './AnswerDetails'
import {CardWorkflow} from './CardWorkflow'
import { RoomTagBadges, RoomTagPicker } from './RoomTags'
import { useEffect,useId,useState,type ReactNode } from 'react'
import {DownOutlined} from '@ant-design/icons'
import { Alert, App, Empty, InputNumber, Progress, Select, Space, Statistic, Switch, Tabs, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ContentCard as Card } from './components'
import { useResource, type Row } from './api'
import { HierarchyPicker } from './HierarchyPicker'
import { cardName,examPath,unassignedGrade } from './examNavigation'
import { ResultExport } from './ResultExport'
import {ResultOverview} from './ResultOverview'
import {ResultFilters,useResultFilterOptions,classLabel,type ResultFilterOptions} from './ResultFilters'
import {RecordSelect} from './RecordSelect'
import {emptyResultFilters,withResultFilters,type ResultFilterValue} from './resultFilterParams'
import {ClassResultSummary} from './ClassResultSummary'
import './result-settings.css'
import {ClassResults} from './ClassResults'
import {PaperLesson,type LessonScope} from './PaperLesson'

const number=(value:unknown)=>value===null||value===undefined?'—':String(value)
const statusName:Record<string,string>={absent:'缺考',pending:'待结分',completed:'已完成',unscanned:'未扫描'}
const numeric=(a:any,b:any,key:string)=>(a[key]??-Infinity)-(b[key]??-Infinity)
const measures=[['analyzed','统计人数'],['average','平均分'],['median','中位数'],['minimum','最低分'],['maximum','最高分'],['standard_deviation','标准差'],['score_rate','得分率%'],['pass_rate','及格率%'],['excellent_rate','优秀率%']].map(([key,title])=>({title,dataIndex:key,render:number,sorter:(a:any,b:any)=>numeric(a,b,key)}))

function ResultSettings({summary,actions,children}:{summary:string;actions:ReactNode;children:ReactNode}){
  const [expanded,setExpanded]=useState(false),id=useId()
  return <Card className="result-settings"><div className="result-settings-header">
    <Button type="text" icon={<DownOutlined rotate={expanded?180:0}/>} aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起筛选与设置':'展开筛选与设置'}</Button>
    <Typography.Text type="secondary" ellipsis title={summary} className="result-settings-summary">{summary}</Typography.Text>
    <div className="result-settings-actions">{actions}</div>
  </div><div id={id} hidden={!expanded} className="result-settings-content">{children}</div></Card>
}

function rangeSummary(filters:ResultFilterValue,options:ResultFilterOptions){
  const classes=filters.classIds.map(id=>{const row=options.classes.find(row=>row.id===id);return row?classLabel(row):'班级'})
  return [filters.groupIds.length?`${filters.groupIds.length} 张题卡`:'',classes.length?classes.length>2?`${classes.slice(0,2).join('、')}等 ${classes.length} 个班级`:classes.join('、'):'全部班级',filters.studentIds.length?`${filters.studentIds.length} 名指定学生`:'',filters.statuses.map(id=>options.statuses.find(row=>row.id===id)?.name||statusName[id]||id).join('、'),filters.q.trim()?`关键词：${filters.q.trim()}`:''].filter(Boolean).join(' · ')
}

export function Results(props:{admin:boolean;groupId?:string;projectId?:string;projectOnly?:boolean}){
  const [tab,setTab]=useState('classes'),[exam,setExam]=useState('')
  const [lesson,setLesson]=useState<LessonScope>({})
  const openLesson=(scope:LessonScope)=>{setLesson(scope);setTab('lesson')}
  const openExam=(id:string)=>{
    if(props.admin&&(props.groupId||props.projectId&&props.projectId!==id)){window.location.hash=examPath({projectId:id,section:'summary'});return}
    setExam(id);setTab('classes')
  }
  return <>{props.admin&&props.groupId&&<CardWorkflow key={props.groupId} groupId={props.groupId}/>}
    <Tabs activeKey={tab} onChange={setTab} destroyOnHidden items={[{key:'classes',label:'班级成绩',children:<ClassResults key={exam} initialProject={exam} onLesson={props.admin?undefined:openLesson} {...props}/>},...(!props.admin?[{key:'lesson',label:'讲评试卷',children:<PaperLesson initial={lesson}/>}]:[]),{key:'analysis',label:'统计分析',children:<AdvancedResults {...props} onOpenExam={openExam}/>} ]}/></>
}

function AdvancedResults({admin,groupId,projectId,projectOnly=false,onOpenExam}:{onOpenExam:(id:string)=>void;admin:boolean;groupId?:string;projectId?:string;projectOnly?:boolean}) {
  const groups=useResource<Row[]>('/groups',[]),projects=useResource<Row[]>('/projects',[]),subjects=useResource<Row[]>('/subjects',[])
  const [selectedGroupId,setGroup]=useState(groupId || ''),group=groupId || selectedGroupId,[selectedProject,setProject]=useState(projectId || ''),project=projectId || selectedProject,[metric,setMetric]=useState('raw'),[includeAbsent,setIncludeAbsent]=useState(false),[pass,setPass]=useState(60),[excellent,setExcellent]=useState(85),[cutoffs,setCutoffs]=useState({pass:60,excellent:85}),[view,setView]=useState('classes'),{message}=App.useApp()
  const [filters,setFilters]=useState(emptyResultFilters),[projectFilters,setProjectFilters]=useState(emptyResultFilters),[rankingClass,setRankingClass]=useState(''),[summaryClass,setSummaryClass]=useState(''),[projectTab,setProjectTab]=useState('cross')
  const filterOptions=useResultFilterOptions('card',group),projectOptions=useResultFilterOptions('project',project)
  useEffect(()=>{setFilters(emptyResultFilters());setRankingClass('')},[group])
  useEffect(()=>{setProjectFilters(emptyResultFilters());setSummaryClass('')},[project])
  useEffect(()=>{if(filters.classIds.length&&!filters.classIds.includes(rankingClass))setRankingClass('')},[filters.classIds,rankingClass])
  useEffect(()=>{if(projectFilters.classIds.length&&!projectFilters.classIds.includes(summaryClass))setSummaryClass('')},[projectFilters.classIds,summaryClass])
  const [room,setRoom]=useState<{id:string;label?:string}>()
  const roomTag=room?.id
  const [detail,setDetail]=useState<{group:string;q:Row}|null>(null)
  const query=withResultFilters(new URLSearchParams({group_id:group,metric,include_absent:String(includeAbsent),pass_ratio:String(cutoffs.pass/100),excellent_ratio:String(cutoffs.excellent/100),...roomTag?{room_tag_id:roomTag}:{}}),filters)
  const projectQuery=withResultFilters(new URLSearchParams({project_id:project}),projectFilters)
  const rankingQuery=new URLSearchParams(query);if(rankingClass)rankingQuery.set('class_ids',rankingClass)
  const summaryQuery=new URLSearchParams(projectQuery);if(summaryClass)summaryQuery.set('class_ids',summaryClass)
  const exportQuery=view==='students'&&rankingClass?rankingQuery:query
  const projectExportQuery=projectTab==='class-summary'&&summaryClass?summaryQuery:projectQuery
  const resource=useResource<any>(group?`/analysis/group?${query}`:null,null),crossResource=useResource<any>(project&&!groupId?`/analysis/project?${projectQuery}`:null,null)
  const ranking=useResource<any>(group&&rankingClass&&view==='students'?`/analysis/group?${rankingQuery}`:null,null)
  const data=resource.data?.group_id===group&&(resource.data.room_tag_id||undefined)===roomTag&&resource.data.metric===metric&&resource.data.include_absent===includeAbsent&&resource.data.pass_ratio===cutoffs.pass/100&&resource.data.excellent_ratio===cutoffs.excellent/100?resource.data:null,cross=crossResource.data?.project_id===project?crossResource.data:null
  const selectedGroup=groups.data.find(g=>g.id===group)
  const subject=subjects.data.find(s=>s.id===selectedGroup?.subject_id)
  const cardScope=[projects.data.find(p=>p.id===subject?.project_id)?.name,subject?.name,selectedGroup?.grade_name,selectedGroup?cardName(selectedGroup,subject):data?.group_name].filter(Boolean) as string[]
  const groupView=<Space direction="vertical" size={16} style={{width:'100%'}}>
    <ResultSettings summary={group?[cardScope.join(' / '),metric==='raw'?'原始分':'赋分',room?.label||'全部考场',rangeSummary(view==='students'&&rankingClass?{...filters,classIds:[rankingClass]}:filters,filterOptions.data),includeAbsent?'缺考计入统计':'缺考单列',`及格 ${cutoffs.pass}% / 优秀 ${cutoffs.excellent}%`].filter(Boolean).join(' · '):'尚未选择题卡，展开设置选择成绩范围'} actions={<>
      <Button disabled={!group} onClick={resource.reload}>刷新</Button>
      <ResultExport key={group} scope={{kind:'card',id:group,query:exportQuery,roomId:roomTag,studentCount:data?.summary.records??0}} initialReport={view==='students'?'ranking':'items'}
        parts={cardScope} room={room?.label} disabled={!data || resource.loading || !!resource.error}/>
    </>}>
      <Space wrap>
        {!groupId && <HierarchyPicker value={group} onChange={id=>{setGroup(id);setRoom(undefined);setMetric('raw')}}/>}
        <Select aria-label="统计口径" value={metric} onChange={setMetric} options={[{label:'原始分统计',value:'raw'},{label:'赋分统计',value:'converted',disabled:!selectedGroup?.conversion_id}]}/>
        <RoomTagPicker groupId={group} value={roomTag} onChange={(id,label)=>setRoom(id?{id,label}:undefined)}/>
      </Space>
      {group&&<div style={{marginTop:12}}><ResultFilters value={filters} onChange={setFilters} options={filterOptions.data} loading={filterOptions.loading} matched={resource.loading?undefined:data?.summary.records}/></div>}
      <Space wrap style={{marginTop:16}}><Typography.Text>缺考计入统计</Typography.Text><Switch checked={includeAbsent} onChange={setIncludeAbsent}/><Typography.Text>及格线（满分%）</Typography.Text><InputNumber min={0} max={100} value={pass} onChange={v=>setPass(v??60)}/><Typography.Text>优秀线（满分%）</Typography.Text><InputNumber min={0} max={100} value={excellent} onChange={v=>setExcellent(v??85)}/><Button onClick={()=>{if(pass>excellent){message.warning('优秀线应不低于及格线');return}setCutoffs({pass,excellent})}}>应用分数线</Button></Space>
    </ResultSettings>
    {admin&&!groupId&&group&&<CardWorkflow key={group} groupId={group} onSaved={resource.reload}/>}
    {(resource.error||filterOptions.error)&&<Alert type="error" message={resource.error||filterOptions.error}/>}
    {data?<>{admin&&!data.roster_configured&&<Alert type="warning" message="本题卡尚未配置应考名单。配置后可查看未扫描学生。" action={subject&&selectedGroup&&<Button href={examPath({projectId:subject.project_id,subjectId:subject.id,gradeId:selectedGroup.grade_id||unassignedGrade,groupId:group,section:'roster'})}>配置应考名单</Button>}/>}<div className="stat-grid"><Card><Statistic title="考生记录" value={data.summary.records}/></Card><Card><Statistic title="平均分" value={data.summary.average??'—'} precision={2}/></Card><Card><Statistic title="统计人数" value={data.summary.analyzed}/></Card><Card><Statistic title="未扫描 / 缺考 / 待结分" value={`${data.summary.unscanned} / ${data.summary.absent} / ${data.summary.pending}`}/></Card></div>
      <Alert type="info" message={`${metric==='raw'?'原始分':'赋分'}满分 ${data.full_score} · ${includeAbsent?'缺考按0分计入':'缺考单列'} · 未扫描及未结总分不计入总分均值和排名 · ${data.rank_scope==='group'?'题卡内排名':'仅在任教班级范围内排名'}`} description="单题分析按该题已评作答统计，可能包含尚未完成整卷的考生。相同分数并列，后续名次跳号。"/>
      <Card loading={resource.loading}><Tabs activeKey={view} onChange={setView} items={[
        {key:'classes',label:'班级统计',children:<Table query="" rowKey="id" scroll={{x:'max-content'}} dataSource={data.classes} columns={[{title:'班级',dataIndex:'name'},{title:'记录人数',dataIndex:'records'},{title:'缺考',dataIndex:'absent'},{title:'待结分',dataIndex:'pending'},{title:'未扫描',dataIndex:'unscanned'},...measures]}/>},
        {key:'questions',label:'单题分析',children:<Table query="" rowKey="id" scroll={{x:'max-content'}} dataSource={data.questions} columns={[{title:'题号',dataIndex:'number',render:(n,r)=><Button type="link" title="查看答题详情" onClick={()=>setDetail({group,q:r})}>第 {n} 题</Button>},{title:'题型',dataIndex:'type',render:value=>value==='subjective'?'主观题':'客观题'},{title:'满分',dataIndex:'points'},...measures]}/>},
        {key:'distribution',label:'分数分布',children:<Space direction="vertical" style={{width:'100%'}}>{data.distribution.map((bin:any,i:number)=><div key={i}><Typography.Text>{bin.lower} ≤ 分数 {bin.upper_inclusive?'≤':'<'} {bin.upper} · {bin.count} 人</Typography.Text><Progress percent={100*bin.count/Math.max(1,...data.distribution.map((b:any)=>b.count))} showInfo={false}/></div>)}</Space>},
        {key:'students',label:'考生成绩与排名',children:<Space direction="vertical" style={{width:'100%'}}><RecordSelect title="班级" records={filterOptions.data.classes.filter(row=>!filters.classIds.length||filters.classIds.includes(row.id))} value={rankingClass} onChange={setRankingClass} label={classLabel} columns={[{title:'年级',render:(_,row)=>row.grade_name||row.grade||'—'},{title:'班级',dataIndex:'name'}]}/>{rankingClass?<><Typography.Text type="secondary">班级排名和可见范围排名以完整可见范围计算，姓名、学生及状态筛选保持原有名次。</Typography.Text>{ranking.error&&<Alert type="error" message={ranking.error}/>}<Table query="" loading={ranking.loading} rowKey="student_id" scroll={{x:'max-content'}} dataSource={ranking.loading?[]:ranking.data?.students||[]} columns={[{title:'考号',dataIndex:'candidate_number'},{title:'姓名',dataIndex:'name'},{title:'考场',render:(_:unknown,row:Row)=><RoomTagBadges tags={row.room_tags}/>},{title:'年级',dataIndex:'grade'},{title:'班级',dataIndex:'class_name'},{title:'原始分',dataIndex:'total',render:number,sorter:(a,b)=>numeric(a,b,'total')},{title:'赋分',dataIndex:'converted_score',render:number},{title:'可见范围排名',dataIndex:'scope_rank',render:number},{title:'班级排名',dataIndex:'class_rank',render:number,defaultSortOrder:'ascend',sorter:(a,b)=>(a.class_rank??Infinity)-(b.class_rank??Infinity)},{title:'状态',dataIndex:'status',render:value=><Tag>{statusName[value]||value}</Tag>}]}/></>:<Empty description="选择班级后查看考生成绩与排名"/>}</Space>},
      ]}/></Card></>:<Card loading={resource.loading}><Empty description="选择题卡查看成绩分析"/></Card>}
  </Space>
  const projectView=<Space direction="vertical" size={16} style={{width:'100%'}}>
    <ResultSettings summary={project?[projects.data.find(row=>row.id===project)?.name||cross?.project_name,rangeSummary(projectTab==='class-summary'&&summaryClass?{...projectFilters,classIds:[summaryClass]}:projectFilters,projectOptions.data)].filter(Boolean).join(' · '):'尚未选择考试，展开设置选择成绩范围'} actions={<>
      <Button disabled={!project} onClick={crossResource.reload}>刷新</Button>
      <ResultExport key={project} scope={{kind:'project',id:project,query:projectExportQuery,cardCount:cross?.columns.length??0,studentCount:cross?.students.length??0}} initialReport={projectTab==='class-summary'?'class-summary':'items'}
        parts={[cross?.project_name||'']} disabled={!cross || crossResource.loading || !!crossResource.error}/>
    </>}>
      {!projectId && <Select aria-label="考试项目" style={{width:300,maxWidth:'100%'}} placeholder="选择考试项目" value={project||undefined} onChange={setProject} options={projects.data.map(p=>({label:p.name,value:p.id}))}/>}
      {project&&<div style={{marginTop:12}}><ResultFilters allowGroups value={projectFilters} onChange={setProjectFilters} options={projectOptions.data} loading={projectOptions.loading} matched={crossResource.loading?undefined:cross?.students.length}/></div>}
    </ResultSettings>
    {projectOptions.error&&<Alert type="error" message={projectOptions.error}/>}
    <Tabs activeKey={projectTab} onChange={setProjectTab} items={[{key:'cross',label:'跨科汇总',children:<Space direction="vertical" size={12} style={{width:'100%'}}>
    {crossResource.error&&<Alert type="error" message={crossResource.error}/>}
    <Alert type="info" message="合计只汇总已有总分记录；无记录保持空白，缺考显示0分。采用分优先使用赋分，其余使用原始分。" description="不同题卡可能对应不同学校、年级或满分，本页用于跨科核对，不生成跨题卡考试排名。教师仅可见已发布且属于任教班级的成绩。"/>
    {cross?<Card loading={crossResource.loading}><Table query="" rowKey="student_id" scroll={{x:'max-content'}} dataSource={cross.students} columns={[{title:'考号',dataIndex:'candidate_number',fixed:'left'},{title:'姓名',dataIndex:'name',fixed:'left'},{title:'年级',dataIndex:'grade'},{title:'班级',dataIndex:'class_name'},{title:'已完成记录',dataIndex:'completed_records'},{title:'缺考记录',dataIndex:'absent_records'},{title:'待结分记录',dataIndex:'pending_records'},{title:'未扫描记录',dataIndex:'unscanned_records'},...cross.columns.map((col:any)=>{
      const raw={key:col.id+'-raw',title:'原始分',render:(_:unknown,row:any)=>{
        const score=row.scores[col.id]
        return score?score.status==='absent'?'缺考 0':score.raw??statusName[score.status]??'无记录':'—'
      }}
      const title=<span title={[col.subject,col.grade,col.group].filter(Boolean).join(' / ')}>{col.subject}</span>
      if(!col.conversion_enabled)return {...raw,title}
      return {key:col.id,title,children:[raw,{key:col.id+'-converted',title:'赋分',render:(_:unknown,row:any)=>number(row.scores[col.id]?.converted)}]}
    }),{title:'已记录原始分合计',dataIndex:'recorded_raw_sum',render:number},{title:'已记录采用分合计',dataIndex:'recorded_effective_sum',render:number}]}/></Card>:<Card loading={crossResource.loading}><Empty description="选择考试查看跨科汇总"/></Card>}
  </Space>},{key:'class-summary',label:'班级总表',children:<ClassResultSummary key={summaryQuery.toString()} project={project} query={summaryQuery} options={projectOptions.data} classIds={projectFilters.classIds} classId={summaryClass} onClass={setSummaryClass}/>} ]}/>
  </Space>
  return <>{detail?.group===group&&detail&&<AnswerDetails key={[group,detail.q.id,roomTag,includeAbsent,query.toString()].join(':')} group={group} q={detail.q} room={roomTag} absent={includeAbsent} query={query} onClose={()=>setDetail(null)}/>}<Space direction="vertical" style={{width:'100%'}}>{(groups.error||projects.error||subjects.error)&&<Alert type="error" message={groups.error||projects.error||subjects.error}/>}{groupId ? <Tabs items={[{key:'details',label:'题卡成绩',children:groupView},{key:'overview',label:'概览与对比',children:<ResultOverview onOpenExam={onOpenExam} groupId={groupId}/>}]}/> : projectOnly ? <Tabs items={[{key:'overview',label:'概览与对比',children:<ResultOverview onOpenExam={onOpenExam} projectId={projectId}/>},{key:'project',label:'跨科汇总',children:projectView}]}/> : <Tabs items={[{key:'overview',label:'概览与对比',children:<ResultOverview onOpenExam={onOpenExam}/>},{key:'group',label:'科目与班级分析',children:groupView},{key:'project',label:'跨科汇总',children:projectView}]}/>}</Space></>
}
