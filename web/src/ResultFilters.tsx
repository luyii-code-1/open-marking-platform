import {Input,Select,Space,Typography} from 'antd'
import {Button} from './Button'
import {MultipleRecordSelect} from './RecordSelect'
import {useResource,type Row} from './api'
import {emptyResultFilters,type ResultFilterValue} from './resultFilterParams'

export type ResultFilterOptions={classes:Row[];students:Row[];statuses:Row[];groups:Row[]}
const initial:ResultFilterOptions={classes:[],students:[],statuses:[],groups:[]}
export function useResultFilterOptions(kind:'card'|'project',id:string,enabled=true){
  return useResource<ResultFilterOptions>(id&&enabled?'/analysis/filter-options?'+new URLSearchParams({[kind==='card'?'group_id':'project_id']:id}):null,initial)
}
export function classLabel(row:Row){return [row.grade_name||row.grade,row.name].filter(Boolean).join(' · ')}

export function ResultFilters({value,onChange,options,disabled=false,loading=false,matched,allowGroups=false}:{value:ResultFilterValue;onChange:(value:ResultFilterValue)=>void;options:ResultFilterOptions;disabled?:boolean;loading?:boolean;matched?:number;allowGroups?:boolean}){
  const classes=new Map(options.classes.map(row=>[row.id,row]))
  const students=options.students.filter(row=>!value.classIds.length||value.classIds.includes(row.class_id)||value.studentIds.includes(row.id))
  const grades=[...new Map(options.classes.filter(row=>row.grade_id||row.grade_name||row.grade).map(row=>[String(row.grade_id||row.grade_name||row.grade),{value:String(row.grade_id||row.grade_name||row.grade),label:String(row.grade_name||row.grade||row.grade_id)}])).values()]
  return <Space direction="vertical" size={10} style={{width:'100%'}}>
    <Space wrap align="start">
      {allowGroups&&<MultipleRecordSelect title="参与汇总的题卡" records={options.groups||[]} value={value.groupIds} onChange={groupIds=>onChange({...value,groupIds})} disabled={disabled||loading}
        label={row=>[row.subject,row.grade,row.group||row.name].filter(Boolean).join(' · ')} columns={[{title:'科目',dataIndex:'subject'},{title:'年级',dataIndex:'grade'},{title:'题卡',render:(_,row)=>row.group||row.name}]}
        fields={[{key:'subject',label:'科目',options:[...new Set((options.groups||[]).map(row=>row.subject))].map(subject=>({value:subject,label:subject})),values:row=>[row.subject]}]}/>}
      <MultipleRecordSelect title="班级" records={options.classes} value={value.classIds} onChange={classIds=>onChange({...value,classIds})} disabled={disabled||loading} label={classLabel}
        columns={[{title:'年级',render:(_,row)=>row.grade_name||row.grade||'—'},{title:'班级',dataIndex:'name'}]}
        fields={[{key:'grade',label:'年级',options:grades,values:row=>[String(row.grade_id||row.grade_name||row.grade||'')]}]}/>
      <MultipleRecordSelect title="学生" records={students} value={value.studentIds} onChange={studentIds=>onChange({...value,studentIds})} disabled={disabled||loading}
        label={row=>`${row.name}（${row.candidate_number}）`}
        columns={[{title:'姓名',dataIndex:'name'},{title:'准考证号',dataIndex:'candidate_number'},{title:'班级',render:(_,row)=>classes.get(row.class_id)?classLabel(classes.get(row.class_id)!):row.class_id}]}
        fields={[{key:'class',label:'班级',options:options.classes.map(row=>({value:row.id,label:classLabel(row)})),values:row=>[row.class_id]},{key:'number',label:'准考证号',options:[],values:row=>[row.candidate_number]},{key:'name',label:'姓名',options:[],values:row=>[row.name]}]}/>
      <Select mode="multiple" allowClear maxTagCount="responsive" aria-label="成绩状态" placeholder="全部成绩状态" style={{minWidth:190,maxWidth:'100%'}} disabled={disabled} value={value.statuses} options={options.statuses.map(row=>({value:row.id,label:row.name}))} onChange={statuses=>onChange({...value,statuses})}/>
      <Input.Search aria-label="搜索姓名或准考证号" placeholder="姓名或准考证号" allowClear style={{width:220,maxWidth:'100%'}} disabled={disabled} value={value.q} onChange={event=>onChange({...value,q:event.target.value})}/>
      <Button disabled={disabled} onClick={()=>onChange(emptyResultFilters())}>重置过滤器</Button>
    </Space>
    <Typography.Text type="secondary">{loading?'正在加载可选范围…':matched===undefined?'设置班级、学生和成绩状态筛选范围':`匹配 ${matched} 名学生`}</Typography.Text>
  </Space>
}
