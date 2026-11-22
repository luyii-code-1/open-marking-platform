import {useReviewWorkspace} from './ReviewWorkspace'
import {useState} from 'react'
import {Alert,App,Card,Select,Space,Tabs,Tag} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {RecordSelect} from './RecordSelect'
import {Conversions} from './Conversions'
import {send,useResource,announceChanges,type Row} from './api'

function AdminConversionWorkspace({projectId,subjectId,gradeId,groupId}:{projectId:string;subjectId?:string;gradeId?:string;groupId?:string}){
  const data=useResource<{project:Row;subjects:Row[];groups:Row[]}>('/conversion-bindings?project_id='+projectId,{project:{id:projectId},subjects:[],groups:[]})
  const schemes=useResource<Row[]>('/score-conversions',[]),grades=useResource<Row[]>('/grades',[])
  const [kind,setKind]=useState(groupId?'groups':subjectId?'subjects':'projects'),[target,setTarget]=useState(groupId||subjectId||projectId),[grade,setGrade]=useState(gradeId||''),[mode,setMode]=useState('inherit'),[scheme,setScheme]=useState(''),[busy,setBusy]=useState(false),{message}=App.useApp()
  const records=kind==='projects'?[data.data.project]:kind==='subjects'?data.data.subjects.filter(s=>!subjectId||s.id===subjectId):data.data.groups.filter(g=>(!subjectId||g.subject_id===subjectId)&&(!groupId||g.id===groupId)).map(g=>({...g,name:[data.data.subjects.find(s=>s.id===g.subject_id)?.name,grades.data.find(s=>s.id===g.grade_id)?.name,g.name].filter(Boolean).join(' · ')}))
  async function save(){setBusy(true);try{await send('/conversion-bindings',{kind,id:target,grade_id:kind==='subjects'?grade:undefined,mode,conversion_id:scheme},'PUT');announceChanges();await data.reload();message.success('赋分标准已保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  return <Tabs items={[{key:'bindings',label:'赋分标准与分配',children:<Space direction="vertical" style={{width:'100%'}}>
    <Alert type="info" message="默认继承考试项目设置" description="题卡指定优先于科目内年级指定，其次为科目设置和考试项目默认。已发布成绩采用发布时的方案，修改后需复核并重新发布才会生效。"/>
    {(data.error||schemes.error)&&<Alert type="error" message={data.error||schemes.error}/>}
    <Card><Space wrap><Select aria-label="分配层级" value={kind} onChange={v=>{setKind(v);setTarget(v==='projects'?projectId:'');setGrade('')}} options={[...(!subjectId?[{value:'projects',label:'考试项目默认'}]:[]),...(!groupId?[{value:'subjects',label:'科目 / 年级'}]:[]),{value:'groups',label:'题卡'}]}/>
      <RecordSelect title="适用对象" records={records} value={target} onChange={setTarget}/>
      {kind==='subjects'&&<RecordSelect title="年级（留空为科目默认）" records={grades.data} value={grade} onChange={setGrade}/>}
      <Select aria-label="继承方式" value={mode} onChange={setMode} options={[{value:'inherit',label:'继承上级'},{value:'override',label:'指定方案'},{value:'none',label:'不赋分'}]}/>
      {mode==='override'&&<RecordSelect title="赋分方案" records={schemes.data} value={scheme} onChange={setScheme}/>}
      <Button type="primary" loading={busy} disabled={!target||mode==='override'&&!scheme} onClick={save}>保存标准</Button>
    </Space></Card>
    <Card title="当前题卡生效标准"><Table rowKey="id" dataSource={records.length&&kind==='groups'?records:data.data.groups.filter(g=>!subjectId||g.subject_id===subjectId)} columns={[{title:'题卡',dataIndex:'name'},{title:'方案',render:(_,g)=>schemes.data.find(s=>s.id===g.conversion_id)?.name||'未配置赋分'},{title:'来源',dataIndex:'conversion_source',render:v=>v||'发布快照'},{title:'状态',render:(_,g)=><Tag>{g.frozen?'已发布':'未发布'}</Tag>}]}/></Card>
  </Space>},{key:'schemes',label:'方案与模板库',children:<Conversions projectId={projectId}/>} ]}/>
}

export function ConversionWorkspace(props:{projectId:string;subjectId?:string;gradeId?:string;groupId?:string}){
 const {user}=useReviewWorkspace()
 return user.role==='admin'?<AdminConversionWorkspace {...props}/>:<Alert type="info" message="赋分标准由系统管理员维护"/>
}
