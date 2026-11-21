import {useEffect,useMemo,useState} from 'react'
import {Alert,App,Card,Checkbox,Drawer,Empty,Select,Space,Typography} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {download,useResource,type Row} from './api'
import {rowNavigation} from './rowNavigation'
import {resultState} from './resultFilterParams'
import './result-overview.css'

const kinds=[{value:'subject',label:'科目'},{value:'grade',label:'年级'},{value:'class',label:'班级'},{value:'card',label:'题卡'}]
const label=(row:Row)=>[row.project,row.subject,row.grade,row.label!==row.subject&&row.label!==row.grade?row.label:''].filter(Boolean).join(' · ')
const value=(number:unknown)=>number===undefined||number===null?'—':String(number)

function ScopeDetail({scope,groupId,onClose}:{scope:Row;groupId?:string;onClose:()=>void}){
  const params=new URLSearchParams({scope_id:scope.id,project_id:scope.project_id})
  if(groupId)params.set('group_id',groupId)
  const data=useResource<Row|null>('/analysis/overview/detail?'+params,null)
  return <Drawer open onClose={onClose} title={label(scope)+' · 成绩明细'} width="min(940px, 96vw)">
    {data.error&&<Alert type="error" message={data.error}/>}
    <Table<Row> bordered rowKey={r=>r.group_id+':'+r.student_id} loading={data.loading} dataSource={data.data?.students||[]} scroll={{x:'max-content'}} columns={[
      {title:'姓名',dataIndex:'name'},{title:'准考证号',dataIndex:'candidate_number'},{title:'班级',dataIndex:'class_name'},
      {title:'题卡',dataIndex:'card'},{title:'成绩',dataIndex:'total',render:(v,r)=>r.status==='completed'?value(v):'—'},
      {title:'满分',dataIndex:'full_score'},{title:'状态',dataIndex:'status',render:s=>resultState[s]||s},
    ]}/>
  </Drawer>
}
export function ResultOverview({projectId,groupId,onOpenExam}:{projectId?:string;groupId?:string;onOpenExam:(id:string)=>void}){
  const [detail,setDetail]=useState<Row|null>(null)
  const scopeParams=new URLSearchParams()
  if(groupId)scopeParams.set('group_id',groupId)
  const resource=useResource<{scopes:Row[]}>('/analysis/overview?'+scopeParams, {scopes:[]})
  const [kind,setKind]=useState(groupId?'card':'subject'),[project,setProject]=useState(projectId||''),[subject,setSubject]=useState(''),[grade,setGrade]=useState(''),[selected,setSelected]=useState<string[]>([]),[crossSubject,setCrossSubject]=useState(false),[exporting,setExporting]=useState('')
  const {message}=App.useApp(),scopes=resource.data.scopes
  const anchor=scopes.find(r=>r.kind==='card'&&r.group_ids.includes(groupId))
  useEffect(()=>{if(anchor){setProject(anchor.project_id);setSubject(anchor.subject);setKind('card')}},[groupId,anchor?.id])
  useEffect(()=>{if(projectId)setProject(projectId)},[projectId])
  const options=(key:string)=>[...new Set(scopes.map(r=>r[key]).filter(Boolean))].map(v=>({value:v,label:key==='project_id'?scopes.find(r=>r.project_id===v)?.project:v}))
  const visible=useMemo(()=>scopes.filter(r=>r.kind===kind&&(!project||r.project_id===project)&&(!subject||r.subject===subject)&&(!grade||r.grade===grade)),[scopes,kind,project,subject,grade])
  const compared=scopes.filter(r=>selected.includes(r.id)),comparisonSubject=subject||compared[0]?.subject
  const comparable=scopes.filter(r=>r.kind===kind&&(crossSubject||!comparisonSubject||r.subject===comparisonSubject))
  async function exportRows(format:string,ids:string[]){
    if(!ids.length)return
    setExporting(format)
    try{await download('/analysis/overview/export?'+new URLSearchParams({...Object.fromEntries(scopeParams),scope_ids:ids.join(','),format}),'成绩概览与对比.'+format)}catch(error){message.error((error as Error).message)}finally{setExporting('')}
  }
  const columns=[{title:'考试',dataIndex:'project',render:(name:string,row:Row)=><Button type="link" onClick={()=>onOpenExam(row.project_id)}>{name}</Button>},{title:'科目',dataIndex:'subject'},{title:'年级',dataIndex:'grade',render:value},{title:'统计范围',dataIndex:'label',render:(name:string,row:Row)=><Button type="link" onClick={()=>setDetail(row)}>{name}</Button>},{title:'应考份次',dataIndex:'records'},{title:'已结分',dataIndex:'completed'},{title:'待结分',dataIndex:'pending'},{title:'缺考',dataIndex:'absent'},{title:'未扫描',dataIndex:'unscanned'},{title:'统计份数',dataIndex:'analyzed'},{title:'平均分',dataIndex:'average',render:value},{title:'满分',dataIndex:'full_score',render:value},{title:'平均得分率%',dataIndex:'score_rate',render:value}]
  return <Space direction="vertical" size={12} style={{width:'100%'}}>
    {detail&&<ScopeDetail key={detail.id} scope={detail} groupId={groupId} onClose={()=>setDetail(null)}/>}
    <Card title="成绩概览与对比" extra={<Button onClick={resource.reload} loading={resource.loading}>刷新</Button>}>
      <Space wrap>
        <Select aria-label="概览维度" value={kind} options={groupId?kinds.filter(k=>['class','card'].includes(k.value)):kinds} onChange={next=>{setKind(next);setSelected([]);if(next==='subject')setGrade('')}}/>
        {!projectId&&!groupId&&<Select aria-label="概览考试" allowClear showSearch optionFilterProp="label" placeholder="全部考试" style={{minWidth:180}} value={project||undefined} options={options('project_id')} onChange={next=>setProject(next||'')}/>}
        {!groupId&&<Select aria-label="概览科目" allowClear showSearch placeholder="全部科目" style={{minWidth:140}} value={subject||undefined} options={options('subject')} onChange={next=>{setSubject(next||'');setSelected([])}}/>}
        {!groupId&&<Select aria-label="概览年级" disabled={kind==='subject'} allowClear showSearch placeholder="全部年级" style={{minWidth:140}} value={grade||undefined} options={options('grade')} onChange={next=>setGrade(next||'')}/>}
        <Button disabled={!visible.length} onClick={()=>setSelected(visible.filter(r=>crossSubject||r.subject===(comparisonSubject||visible[0]?.subject)).map(r=>r.id))}>对比当前范围</Button>
        <Button disabled={!visible.length||!!exporting} loading={exporting==='csv'} onClick={()=>exportRows('csv',visible.map(r=>r.id))}>导出 CSV</Button>
        <Button disabled={!visible.length||!!exporting} loading={exporting==='xlsx'} onClick={()=>exportRows('xlsx',visible.map(r=>r.id))}>导出 Excel</Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{marginTop:12,marginBottom:0}}>平均分按已完成评分的实考答卷计算，缺考、未扫描和待结分单列。同一考生参加多份题卡时按答卷份次统计；不同满分的范围可用得分率对比。</Typography.Paragraph>
    </Card>
    {resource.error&&<Alert type="error" message={resource.error}/>}
    <Card loading={resource.loading}><Table<Row> onRow={r=>rowNavigation(()=>setDetail(r),label(r))} rowKey="id" dataSource={visible} columns={columns} scroll={{x:'max-content'}} rowSelection={{selectedRowKeys:selected,onChange:keys=>{
      const rows=scopes.filter(r=>keys.includes(r.id)),first=rows[0]?.subject
      setSelected(rows.filter(r=>crossSubject||r.subject===first).map(r=>r.id))
    },getCheckboxProps:r=>({disabled:!crossSubject&&!!comparisonSubject&&r.subject!==comparisonSubject})}}/></Card>
    <Card title="范围对比" extra={<Space><Button disabled={!compared.length||!!exporting} onClick={()=>exportRows('xlsx',selected)}>导出对比表</Button><Button disabled={!selected.length} onClick={()=>setSelected([])}>清空对比</Button></Space>}>
      <Space wrap style={{width:'100%',marginBottom:12}}>
        {!groupId&&<Checkbox checked={crossSubject} onChange={event=>{setCrossSubject(event.target.checked);if(!event.target.checked){const first=compared[0]?.subject;setSelected(compared.filter(r=>r.subject===first).map(r=>r.id))}}}>允许跨科目对比</Checkbox>}
        <Select<string> aria-label="添加对比范围" showSearch optionFilterProp="label" placeholder="选择对比范围" style={{minWidth:280,maxWidth:'100%'}} value={undefined} options={comparable.filter(r=>!selected.includes(r.id)).map(r=>({value:r.id,label:label(r)}))} onChange={id=>setSelected([...selected,id])}/>
      </Space>
      {!compared.length?<Empty description="请选择要对比的统计范围"/>:<>
        <div className="result-comparison-chart" aria-label="平均得分率对比">
          {compared.map(row=><div className="result-comparison-row" key={row.id}>
            <button type="button" className="result-comparison-label" onClick={()=>setDetail(row)}>{label(row)}</button>
            <div className="result-comparison-track"><div className="result-comparison-bar" style={{width:`${Math.max(0,Math.min(100,row.score_rate||0))}%`}}/></div>
            <span>{value(row.score_rate)}% · 平均 {value(row.average)} 分 · {row.analyzed} 份</span>
          </div>)}
        </div>
        <Table<Row> onRow={r=>rowNavigation(()=>setDetail(r),label(r))} rowKey="id" dataSource={compared} columns={columns} scroll={{x:'max-content'}}/>
      </>}
    </Card>
  </Space>
}
