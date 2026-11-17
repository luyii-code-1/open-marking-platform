import {Card,Tag} from 'antd'
import {Table} from './DataTable'
import {ErrorNotice} from './EntityTable'
import {useResource,type Row} from './api'
import {cardName,examPath,unassignedGrade} from './examNavigation'
import type {FilterField} from './recordFilters'

export function ExamCatalog(){
  const catalog=useResource<Row[]>('/exam-catalog',[]),classes=useResource<Row[]>('/classes',[]),grades=useResource<Row[]>('/grades',[])
  const choices=(key:string,label:string)=>[...new Map(catalog.data.map(r=>[String(r[key]||unassignedGrade),{value:String(r[key]||unassignedGrade),label:r[label]}])).values()]
  const fields:FilterField<Row>[]=[
    {key:'project',label:'考试',options:choices('project_id','project_name'),values:r=>[r.project_id]},
    {key:'subject',label:'科目',options:choices('subject_key','subject_name'),values:r=>[r.subject_key]},
    {key:'grade',label:'年级',options:choices('grade_id','grade_name'),values:r=>[r.grade_id||unassignedGrade]},
    {key:'class',label:'班级',options:classes.data.map(c=>({value:c.id,label:[grades.data.find(g=>g.id===c.grade_id)?.name||c.grade,c.name].filter(Boolean).join(' · ')})),values:r=>r.class_ids||[]},
  ]
  const path=(r:Row)=>examPath({projectId:r.project_id,subjectId:r.subject_id,gradeId:r.grade_id||unassignedGrade,groupId:r.id})
  return <Card title="题卡索引"><ErrorNotice error={catalog.error||classes.error||grades.error} retry={catalog.reload}/>
    <Table<Row> rowKey="id" dataSource={catalog.data} loading={catalog.loading} filterFields={fields} scroll={{x:'max-content'}} columns={[
      {title:'考试',dataIndex:'project_name'},
      {title:'科目',dataIndex:'subject_name'},
      {title:'年级',dataIndex:'grade_name'},
      {title:'题卡',render:(_,r)=><a href={path(r)}>{cardName(r,{id:r.subject_id,name:r.subject_name})}</a>},
      {title:'班级',render:(_,r)=>(r.class_names||[]).join('、')||'—'},
      {title:'应考人数',dataIndex:'roster_count',render:value=>value??'待设置'},
      {title:'成绩',render:(_,r)=><Tag color={r.frozen?'green':undefined}>{r.frozen?'已发布':'未发布'}</Tag>},
    ]}/>
  </Card>
}
