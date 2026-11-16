import {useEffect,useState} from 'react'
import {Alert,Card,Empty,Input,Modal,Space,Tabs,Tag} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {MultipleRecordSelect} from './RecordSelect'
import {useResource,type Row} from './api'
import {AssetImage} from './components'
import {ErrorNotice} from './EntityTable'
import {rowNavigation} from './rowNavigation'

type Filters={grades:string[];classes:string[];subjects:string[];groups:string[]}
type LookupResult={items:Row[];total:number;page:number;options:Record<keyof Filters,Row[]>;scope?:{project_id:string;group_id:string|null;scans_purged:boolean}}
const emptyFilters:Filters={grades:[],classes:[],subjects:[],groups:[]}
const emptyResult:LookupResult={items:[],total:0,page:1,options:{grades:[],classes:[],subjects:[],groups:[]}}
const sortFields=['name','candidate_number','grade','class_name','subject','card','image_status'] as const
type SortField=typeof sortFields[number]
export function SheetLookup({projectId,groupId,initialQuery=''}:{projectId:string;groupId?:string;initialQuery?:string}){
  const [term,setTerm]=useState(initialQuery),[input,setInput]=useState(initialQuery),[page,setPage]=useState(1),[sheet,setSheet]=useState<Row|null>(null),[filters,setFilters]=useState<Filters>(emptyFilters)
  const [sort,setSort]=useState<{field:SortField;order:'ascend'|'descend'|null}>({field:'candidate_number',order:null})
  useEffect(()=>{setTerm(initialQuery);setInput(initialQuery);setPage(1);setFilters(emptyFilters);setSheet(null);setSort({field:'candidate_number',order:null})},[projectId,groupId,initialQuery])
  const params=new URLSearchParams({q:term,page:String(page),sort_by:sort.field,sort_order:sort.order==='descend'?'desc':'asc'})
  if(groupId)params.set('group_id',groupId)
  for(const [key,name] of [['grades','grade_ids'],['classes','class_ids'],['subjects','subject_ids'],['groups','group_ids']] as const)for(const id of filters[key])params.append(name,id)
  const result=useResource<LookupResult>(`/projects/${projectId}/scanned-sheets?${params}`,emptyResult)
  const data=result.data.scope?.project_id===projectId&&(result.data.scope?.group_id||'')===(groupId||'')?result.data:emptyResult
  function filter(key:keyof Filters,ids:string[]){setFilters(current=>({...current,[key]:ids}));setPage(1);setSheet(null)}
  const grades=data.options.grades.map(row=>({value:row.id,label:row.name}))
  const fixed=groupId?data.options.groups.find(row=>row.id===groupId):undefined
  return <Card title="答题卡查询"><Space direction="vertical" size={12} style={{width:'100%'}}>
    <Space wrap align="start">
      <MultipleRecordSelect title="年级" value={filters.grades} onChange={ids=>filter('grades',ids)} records={data.options.grades}/>
      <MultipleRecordSelect title="班级" value={filters.classes} onChange={ids=>filter('classes',ids)} records={data.options.classes} label={row=>[row.grade,row.name].filter(Boolean).join(' · ')} columns={[{title:'年级',dataIndex:'grade'},{title:'班级',dataIndex:'name'}]} fields={[{key:'grade',label:'年级',options:grades,values:row=>[row.grade_id]}]}/>
      {!groupId&&<><MultipleRecordSelect title="科目" value={filters.subjects} onChange={ids=>filter('subjects',ids)} records={data.options.subjects}/><MultipleRecordSelect title="题卡" value={filters.groups} onChange={ids=>filter('groups',ids)} records={data.options.groups} label={row=>[row.subject,row.grade,row.name].filter(Boolean).join(' · ')} columns={[{title:'科目',dataIndex:'subject'},{title:'年级',dataIndex:'grade'},{title:'题卡',dataIndex:'name'}]} fields={[{key:'grade',label:'年级',options:grades,values:row=>[row.grade_id]},{key:'subject',label:'科目',options:data.options.subjects.map(row=>({value:row.id,label:row.name})),values:row=>[row.subject_id]}]}/></>}
      {Object.values(filters).some(ids=>ids.length>0)&&<Button onClick={()=>{setFilters(emptyFilters);setPage(1);setSheet(null)}}>重置范围</Button>}
    </Space>
    {fixed&&<Space wrap><Tag>{fixed.subject}</Tag><Tag>{fixed.grade}</Tag><Tag>{fixed.name}</Tag></Space>}
    <Input.Search className="list-search" value={input} onChange={event=>setInput(event.target.value)} placeholder="输入姓名或准考证号" aria-label="搜索已入库答卷" maxLength={100} allowClear enterButton="查询" onSearch={value=>{setPage(1);setTerm(value.trim());setSheet(null)}}/>
    <ErrorNotice error={result.error} retry={result.reload}/>
    {data.scope?.scans_purged&&<Alert type="info" showIcon message="该考试的扫描文件已清理，名单、成绩和统计继续保留。"/>}
    <Table<Row> serverSort rowKey="id" query="" loading={result.loading} dataSource={data.items} totalRows={data.total}
      onChange={(_,__,sorting,extra)=>{if(extra.action!=='sort')return;const selected=Array.isArray(sorting)?sorting[0]:sorting,field=String(selected.field||selected.columnKey||'candidate_number');if(!sortFields.includes(field as SortField))return;setSort({field:selected.order?field as SortField:'candidate_number',order:selected.order||null});setPage(1);setSheet(null)}}
      rowSelection={{type:'radio',selectedRowKeys:sheet?[sheet.id]:[],onSelect:row=>setSheet(row)}} onRow={row=>rowNavigation(()=>setSheet(row),`${row.name}的答卷`)}
      pagination={{current:page,pageSize:20,total:data.total,showSizeChanger:false,onChange:next=>{setPage(next);setSheet(null)}}} locale={{emptyText:term||Object.values(filters).some(ids=>ids.length)?'未找到匹配的已入库答卷':'暂无已入库答卷'}}
      columns={[{title:'姓名',dataIndex:'name'},{title:'准考证号',dataIndex:'candidate_number'},{title:'年级',dataIndex:'grade'},{title:'班级',dataIndex:'class_name'},{title:'科目',dataIndex:'subject'},{title:'题卡',dataIndex:'card'},{title:'扫描图像',dataIndex:'image_status',render:(value:string)=><Tag>{value==='purged'?'已清理':value==='available'?'可查看':'暂无图像'}</Tag>},
      {title:'操作',render:(_:unknown,row:Row)=><Button type="link" onClick={()=>setSheet(row)}>查看答卷</Button>}].map(column=>'dataIndex' in column?{...column,sortOrder:column.dataIndex===sort.field?sort.order:null}:column)}/>
  </Space><Modal title={sheet&&`${sheet.name} · ${sheet.candidate_number} · ${sheet.subject}`} width={900} open={!!sheet} onCancel={()=>setSheet(null)} footer={null}>
    {sheet?.image_status==='purged'||data.scope?.scans_purged?<Alert type="info" showIcon message="该考试的扫描文件已清理，无法查看原卷。成绩和统计仍可查询与导出。"/>:sheet?.pages.length?<Tabs key={sheet.id} items={sheet.pages.map((p:Row)=>({key:p.id,label:p.side==='back'?'背面':'正面',children:<AssetImage src={p.image_url}/>}))}/>:<Empty description="暂无扫描图像"/>}
  </Modal></Card>
}
