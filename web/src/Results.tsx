import {CardWorkflow} from './CardWorkflow'
import { RoomTagBadges, RoomTagPicker } from './RoomTags'
import { useState } from 'react'
import { Alert, App, Empty, Input, InputNumber, Modal, Popconfirm, Progress, Select, Space, Statistic, Switch, Tabs, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ContentCard as Card } from './components'
import { download, send, useResource, type Row } from './api'
import { HierarchyPicker } from './HierarchyPicker'

const number=(value:unknown)=>value===null||value===undefined?'—':String(value)
const statusName:Record<string,string>={absent:'缺考',pending:'待结分',completed:'已完成',unscanned:'未扫描'}
const numeric=(a:any,b:any,key:string)=>(a[key]??-Infinity)-(b[key]??-Infinity)
const measures=[['analyzed','统计人数'],['average','平均分'],['median','中位数'],['minimum','最低分'],['maximum','最高分'],['standard_deviation','标准差'],['score_rate','得分率%'],['pass_rate','及格率%'],['excellent_rate','优秀率%']].map(([key,title])=>({title,dataIndex:key,render:number,sorter:(a:any,b:any)=>numeric(a,b,key)}))

export function Results({admin,groupId,projectId,projectOnly=false}:{admin:boolean;groupId?:string;projectId?:string;projectOnly?:boolean}) {
  const groups=useResource<Row[]>('/groups',[]),projects=useResource<Row[]>('/projects',[]),subjects=useResource<Row[]>('/subjects',[])
  const [selectedGroupId,setGroup]=useState(groupId || ''),group=groupId || selectedGroupId,[selectedProject,setProject]=useState(projectId || ''),project=projectId || selectedProject,[metric,setMetric]=useState('raw'),[includeAbsent,setIncludeAbsent]=useState(false),[pass,setPass]=useState(60),[excellent,setExcellent]=useState(85),[cutoffs,setCutoffs]=useState({pass:60,excellent:85}),[view,setView]=useState('classes'),{message}=App.useApp()
  const [roomTag,setRoomTag]=useState<string|undefined>()
  const query=new URLSearchParams({group_id:group,metric,include_absent:String(includeAbsent),pass_ratio:String(cutoffs.pass/100),excellent_ratio:String(cutoffs.excellent/100),...roomTag?{room_tag_id:roomTag}:{}})
  const resource=useResource<any>(group?`/analysis/group?${query}`:null,null),crossResource=useResource<any>(project?`/analysis/project?project_id=${project}`:null,null)
  const data=resource.data?.group_id===group&&(resource.data.room_tag_id||undefined)===roomTag&&resource.data.metric===metric&&resource.data.include_absent===includeAbsent&&resource.data.pass_ratio===cutoffs.pass/100&&resource.data.excellent_ratio===cutoffs.excellent/100?resource.data:null,cross=crossResource.data?.project_id===project?crossResource.data:null
  const selectedGroup=groups.data.find(g=>g.id===group)
  function groupLabel(g:Row) {const subject=subjects.data.find(s=>s.id===g.subject_id);return `${projects.data.find(p=>p.id===subject?.project_id)?.name||''} / ${subject?.name||''} / ${g.name}`}
  async function exportFile(path:string,name:string) {try{await download(path,name)}catch(e){message.error((e as Error).message)}}
  const groupView=<Space direction="vertical" size={16} style={{width:'100%'}}>
    <Card><Space wrap>{!groupId && <HierarchyPicker value={group} onChange={id=>{setGroup(id);setMetric('raw')}}/>}<Select value={metric} onChange={setMetric} options={[{label:'原始分统计',value:'raw'},{label:'赋分统计',value:'converted',disabled:!selectedGroup?.conversion_id}]}/><RoomTagPicker groupId={group} value={roomTag} onChange={setRoomTag}/><Button disabled={!group} onClick={resource.reload}>刷新</Button><Button disabled={!data} onClick={()=>exportFile(`/analysis/group/export?${query}&view=${view}`,'成绩统计.csv')}>导出当前统计</Button><Button disabled={!group} onClick={()=>exportFile(`/results/export?group_id=${group}${roomTag?'&room_tag_id='+encodeURIComponent(roomTag):''}`,'各题成绩明细.csv')}>导出各题明细</Button></Space>
      <Space wrap style={{marginTop:16}}><Typography.Text>缺考计入统计</Typography.Text><Switch checked={includeAbsent} onChange={setIncludeAbsent}/><Typography.Text>及格线（满分%）</Typography.Text><InputNumber min={0} max={100} value={pass} onChange={v=>setPass(v??60)}/><Typography.Text>优秀线（满分%）</Typography.Text><InputNumber min={0} max={100} value={excellent} onChange={v=>setExcellent(v??85)}/><Button onClick={()=>{if(pass>excellent){message.warning('优秀线应不低于及格线');return}setCutoffs({pass,excellent})}}>应用分数线</Button></Space>
    </Card>
    {admin&&group&&<CardWorkflow key={group} groupId={group} publication onSaved={async()=>{await resource.reload();await groups.reload()}}/>}
    {resource.error&&<Alert type="error" message={resource.error}/>}
    {data?<>{admin&&!data.roster_configured&&<Alert type="warning" message="本组尚未配置应考名单，当前仅能显示已有答卷。可在考试项目的应考名单中配置，以显示未扫描学生。"/>}<div className="stat-grid"><Card><Statistic title="考生记录" value={data.summary.records}/></Card><Card><Statistic title="平均分" value={data.summary.average??'—'} precision={2}/></Card><Card><Statistic title="统计人数" value={data.summary.analyzed}/></Card><Card><Statistic title="未扫描 / 缺考 / 待结分" value={`${data.summary.unscanned} / ${data.summary.absent} / ${data.summary.pending}`}/></Card></div>
      <Alert type="info" message={`${metric==='raw'?'原始分':'赋分'}满分 ${data.full_score} · ${includeAbsent?'缺考按0分计入':'缺考单列'} · 未扫描及未结总分不计入总分均值和排名 · ${data.rank_scope==='group'?'题卡内排名':'仅在任教班级范围内排名'}`} description="单题分析按该题已评作答统计，可能包含尚未完成整卷的考生。相同分数并列，后续名次跳号。"/>
      <Card loading={resource.loading}><Tabs activeKey={view} onChange={setView} items={[
        {key:'classes',label:'班级统计',children:<Table rowKey="id" scroll={{x:'max-content'}} dataSource={data.classes} columns={[{title:'班级',dataIndex:'name'},{title:'记录人数',dataIndex:'records'},{title:'缺考',dataIndex:'absent'},{title:'待结分',dataIndex:'pending'},{title:'未扫描',dataIndex:'unscanned'},...measures]}/>},
        {key:'questions',label:'单题分析',children:<Table rowKey="id" scroll={{x:'max-content'}} dataSource={data.questions} columns={[{title:'题号',dataIndex:'number'},{title:'题型',dataIndex:'type',render:value=>value==='subjective'?'主观题':'客观题'},{title:'满分',dataIndex:'points'},...measures]}/>},
        {key:'distribution',label:'分数分布',children:<Space direction="vertical" style={{width:'100%'}}>{data.distribution.map((bin:any,i:number)=><div key={i}><Typography.Text>{bin.lower} ≤ 分数 {bin.upper_inclusive?'≤':'<'} {bin.upper} · {bin.count} 人</Typography.Text><Progress percent={100*bin.count/Math.max(1,...data.distribution.map((b:any)=>b.count))} showInfo={false}/></div>)}</Space>},
        {key:'students',label:'考生成绩与排名',children:<Table rowKey="student_id" scroll={{x:'max-content'}} dataSource={data.students} columns={[{title:'考号',dataIndex:'candidate_number'},{title:'姓名',dataIndex:'name'},{title:'考场',render:(_:unknown,row:Row)=><RoomTagBadges tags={row.room_tags}/>},{title:'年级',dataIndex:'grade'},{title:'班级',dataIndex:'class_name'},{title:'原始分',dataIndex:'total',render:number,sorter:(a,b)=>numeric(a,b,'total')},{title:'赋分',dataIndex:'converted_score',render:number},{title:'可见范围排名',dataIndex:'scope_rank',render:number},{title:'班级排名',dataIndex:'class_rank',render:number},{title:'状态',dataIndex:'status',render:value=><Tag>{statusName[value]||value}</Tag>}]}/>},
      ]}/></Card></>:<Card loading={resource.loading}><Empty description="选择题卡查看成绩分析"/></Card>}
  </Space>
  const projectView=<Space direction="vertical" size={16} style={{width:'100%'}}><Card><Space wrap>{!projectId && <Select style={{width:300}} placeholder="选择考试项目" value={project||undefined} onChange={setProject} options={projects.data.map(p=>({label:p.name,value:p.id}))}/>}<Button disabled={!project} onClick={crossResource.reload}>刷新</Button><Button disabled={!cross} onClick={()=>exportFile(`/analysis/project/export?project_id=${project}`,'跨科成绩汇总.csv')}>导出跨科汇总</Button></Space></Card>
    {crossResource.error&&<Alert type="error" message={crossResource.error}/>}
    <Alert type="info" message="合计只汇总已有总分记录；无记录保持空白，缺考显示0分。采用分优先使用赋分，其余使用原始分。" description="不同题卡可能对应不同学校、年级或满分，本页用于跨科核对，不生成跨题卡考试排名。教师仅可见已发布且属于任教班级的成绩。"/>
    {cross?<Card loading={crossResource.loading}><Table rowKey="student_id" scroll={{x:'max-content'}} dataSource={cross.students} columns={[{title:'考号',dataIndex:'candidate_number',fixed:'left'},{title:'姓名',dataIndex:'name',fixed:'left'},{title:'年级',dataIndex:'grade'},{title:'班级',dataIndex:'class_name'},{title:'已完成记录',dataIndex:'completed_records'},{title:'缺考记录',dataIndex:'absent_records'},{title:'待结分记录',dataIndex:'pending_records'},{title:'未扫描记录',dataIndex:'unscanned_records'},...cross.columns.map((col:any)=>({title:`${col.subject} / ${col.grade||'待设置年级'} / ${col.group}`,children:[{title:'原始分',render:(_:unknown,row:any)=>{const score=row.scores[col.id];return score?score.status==='absent'?'缺考 0':score.raw??statusName[score.status]??'无记录':'—'}},{title:'赋分',render:(_:unknown,row:any)=>number(row.scores[col.id]?.converted)}]})),{title:'已记录原始分合计',dataIndex:'recorded_raw_sum',render:number},{title:'已记录采用分合计',dataIndex:'recorded_effective_sum',render:number}]}/></Card>:<Card loading={crossResource.loading}><Empty description="选择考试查看跨科汇总"/></Card>}
  </Space>
  return <><Space direction="vertical" style={{width:'100%'}}>{(groups.error||projects.error||subjects.error)&&<Alert type="error" message={groups.error||projects.error||subjects.error}/>}{groupId ? groupView : projectOnly ? projectView : <Tabs items={[{key:'group',label:'科目与班级分析',children:groupView},{key:'project',label:'跨科汇总',children:projectView}]}/>}</Space></>
}
