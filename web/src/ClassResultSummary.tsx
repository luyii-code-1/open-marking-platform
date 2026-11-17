import {Alert,Empty,Space,Typography} from 'antd'
import {Table} from './DataTable'
import {RecordSelect} from './RecordSelect'
import {classLabel,type ResultFilterOptions} from './ResultFilters'
import {useResource,type Row} from './api'

const number=(value:unknown)=>value===null||value===undefined?'—':String(value)
const statuses:Record<string,string>={completed:'已完成',pending:'待结分',unscanned:'未扫描',absent:'缺考',duplicate_subject:'科目题卡重复'}
export function ClassResultSummary({project,query,options,classId,onClass,classIds=[]}:{project:string;query:URLSearchParams;options:ResultFilterOptions;classId:string;onClass:(id:string)=>void;classIds?:string[]}){
  const data=useResource<any>(project&&classId?`/analysis/project/class-summary?${query}`:null,null)
  const classes=options.classes.filter(row=>!classIds.length||classIds.includes(row.id))
  return <Space direction="vertical" size={12} style={{width:'100%'}}>
    <RecordSelect title="班级" records={classes} value={classId} onChange={onClass} disabled={!project} label={classLabel}
      columns={[{title:'年级',render:(_,row)=>row.grade_name||row.grade||'—'},{title:'班级',dataIndex:'name'}]}/>
    {!classId?<Empty description="选择班级后查看班级总表"/>:<>
      {data.error&&<Alert type="error" message={data.error}/>}
      {data.data?.warnings?.length>0&&<Alert type="warning" message={[...new Set(data.data.warnings.map((warning:any)=>typeof warning==='string'?warning:warning.reason))].join('；')} description="可在过滤器中选择参与汇总的题卡，确保同一科目对应一份有效成绩。"/>}
      <Typography.Text type="secondary">总分采用各科有效成绩：已配置赋分的科目使用赋分，其余使用原始分。全部应考科目结分后生成总分和班内排名；缺少成绩单列显示。</Typography.Text>
      <Table<Row> query="" rowKey="student_id" loading={data.loading} dataSource={data.data?.students||[]} scroll={{x:'max-content'}} columns={[
        {title:'姓名',dataIndex:'name',fixed:'left'},{title:'准考证号',dataIndex:'candidate_number'},{title:'班级',dataIndex:'class_name'},
        ...(data.data?.columns||[]).map((col:Row)=>({key:col.id,title:[col.subject,col.group].filter(Boolean).join(' · '),children:[
          {key:col.id+'-raw',title:'原始分',render:(_:unknown,row:Row)=>row.scores[col.id]?.status==='absent'?'缺考':row.scores[col.id]?.raw??statuses[row.scores[col.id]?.status]??'无记录'},
          ...(col.conversion_enabled?[{key:col.id+'-converted',title:'赋分',render:(_:unknown,row:Row)=>number(row.scores[col.id]?.converted)}]:[])
        ]})),
        {title:'原始分合计',dataIndex:'raw_total',render:number},{title:'总分',dataIndex:'total',render:(_:unknown,row:Row)=>row.total??statuses[row.status]??'—'},
        {title:'班内排名',dataIndex:'class_rank',render:number,defaultSortOrder:'ascend',sorter:(a,b)=>(a.class_rank??Infinity)-(b.class_rank??Infinity)},
        {title:'状态',dataIndex:'status',render:value=>statuses[value]||value}
      ]}/>
    </>}
  </Space>
}
