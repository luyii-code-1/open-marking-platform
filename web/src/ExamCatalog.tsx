import {useState} from 'react'
import {Card,Segmented,Space,Tag} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {ErrorNotice} from './EntityTable'
import {useResource,type Row} from './api'
import {cardName,examPath,unassignedGrade} from './examNavigation'
import type {FilterField} from './recordFilters'
import type {ProjectFilter} from './reviewProjects'

export function ExamCatalog(){
  const catalog=useResource<Row[]>('/exam-catalog',[]),classes=useResource<Row[]>('/classes',[]),grades=useResource<Row[]>('/grades',[])
  const [statusFilter,setStatusFilter]=useState<ProjectFilter>('in_progress')
  const visible=catalog.data.filter(r=>statusFilter==='all'||(r.project_exam_status||'in_progress')===statusFilter)
  const choices=(key:string,label:string)=>[...new Map(visible.map(r=>[String(r[key]||unassignedGrade),{value:String(r[key]||unassignedGrade),label:r[label]}])).values()]
  const fields:FilterField<Row>[]=[
    {key:'project',label:'考试',options:choices('project_id','project_name'),values:r=>[r.project_id]},
    {key:'subject',label:'科目',options:choices('subject_key','subject_name'),values:r=>[r.subject_key]},
    {key:'grade',label:'年级',options:choices('grade_id','grade_name'),values:r=>[r.grade_id||unassignedGrade]},
    {key:'class',label:'班级',options:classes.data.map(c=>({value:c.id,label:[grades.data.find(g=>g.id===c.grade_id)?.name||c.grade,c.name].filter(Boolean).join(' · ')})),values:r=>r.class_ids||[]},
  ]
  const path=(r:Row)=>examPath({projectId:r.project_id,subjectId:r.subject_id,gradeId:r.grade_id||unassignedGrade,groupId:r.id})
  const emptyText=catalog.data.length&&!visible.length?<Space><span>此状态下暂无题卡。</span><Button type="link" onClick={()=>setStatusFilter('all')}>查看全部考试题卡</Button></Space>:'暂无题卡'
  return <Card title="题卡索引" extra={<Button onClick={catalog.reload} loading={catalog.loading}>刷新</Button>}><ErrorNotice error={catalog.error||classes.error||grades.error} retry={catalog.reload}/>
    <Segmented<ProjectFilter> aria-label="考试状态" value={statusFilter} onChange={setStatusFilter} style={{marginBottom:12}} options={[
      {value:'in_progress',label:'进行中'},{value:'completed',label:'已完成'},{value:'all',label:'全部'},
    ]}/>
    <Table<Row> rowKey="id" dataSource={visible} loading={catalog.loading} filterFields={fields} locale={{emptyText}} scroll={{x:'max-content'}} columns={[
      {title:'考试',dataIndex:'project_name'},
      {title:'考试状态',render:(_,r)=><Tag color={r.project_exam_status==='completed'?'default':'processing'}>{r.project_exam_status==='completed'?'已完成':'进行中'}</Tag>},
      {title:'科目',dataIndex:'subject_name'},
      {title:'年级',dataIndex:'grade_name'},
      {title:'题卡',render:(_,r)=><a href={path(r)}>{cardName(r,{id:r.subject_id,name:r.subject_name})}</a>},
      {title:'班级',render:(_,r)=>(r.class_names||[]).join('、')||'—'},
      {title:'应考人数',dataIndex:'roster_count',render:value=>value??'待设置'},
      {title:'成绩',render:(_,r)=><Tag color={r.frozen?'green':undefined}>{r.frozen?'已发布':'未发布'}</Tag>},
    ]}/>
  </Card>
}
