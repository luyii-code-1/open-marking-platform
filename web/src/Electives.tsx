import {DeleteRecord} from './DeleteRecord'
import {useState} from 'react'
import {App, Card, Select, Space, Upload,Input,Radio,Tag,Checkbox,Tabs} from 'antd'
import { Table } from './DataTable'
import {Button} from './Button'
import {request,send,useResource,type Row} from './api'

export function Electives({grades,students,classes}:{grades:Row[];students:Row[];classes:Row[]}) {
  const lists=useResource<Row[]>('/electives',[]),subjects=useResource<Row[]>('/subject-tags',[])
  const [grade,setGrade]=useState(''),[subject,setSubject]=useState(''),[ids,setIds]=useState<string[]>([]),[busy,setBusy]=useState(false)
  const [kind,setKind]=useState('elective')
  const {message}=App.useApp()
  function choose(g:string,s:string){setGrade(g);setSubject(s);const row=lists.data.find(l=>l.grade_id===g&&l.subject===s);setIds(row?.student_ids||[]);setKind(row?.kind_of_subject||'elective')}
  const classNames=new Map(classes.filter(c=>c.grade_id===grade).map(c=>[c.id,c.name]))
  const roster=students.filter(s=>classNames.has(s.class_id))
  return <Space direction="vertical" style={{width:'100%'}}><Card title="选科名单"><Tabs items={grades.filter(g=>!g.archived).map(g=>({key:g.id,label:g.name,children:<Table<Row> rowKey="id" dataSource={lists.data.filter(row=>row.grade_id===g.id)} loading={lists.loading} columns={[{title:'科目',dataIndex:'subject'},{title:'应考范围',render:(_,r)=>r.kind_of_subject==='required'?'年级全体':`选考 · ${r.student_ids.length} 人`},{title:'操作',render:(_,r)=><Space><Button onClick={()=>choose(r.grade_id,r.subject)}>编辑</Button><DeleteRecord kind="electives" row={{...r,name:r.subject}} reload={async()=>{await lists.reload();if(grade===r.grade_id&&subject===r.subject)choose('','')}}/></Space>}]}/>}))}/></Card><Card title="设置应考范围"><Space wrap style={{marginBottom:16}}>
    <Select disabled={busy} placeholder="选择年级" style={{width:160}} value={grade||undefined} onChange={g=>choose(g,subject)} options={grades.map(g=>({value:g.id,label:g.name}))}/>
    <Select disabled={busy} showSearch optionFilterProp="label" placeholder="选择科目" style={{width:220}} value={subject||undefined} onChange={s=>choose(grade,s)} options={subjects.data.map(s=>({value:s.name,label:s.name}))}/>
    <Radio.Group disabled={busy} value={kind} onChange={e=>setKind(e.target.value)} options={[{value:'required',label:'必考'},{value:'elective',label:'选考'}]}/>
    {kind==='elective'&&<Upload accept=".csv,.xlsx" showUploadList={false} disabled={!grade||!subject||busy} beforeUpload={async f=>{setBusy(true);try{const data=new FormData();data.append('file',f);setIds(await request('/electives/match?grade_id='+grade,{method:'POST',body:data}));message.success('已匹配名单，请核对后保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}return false}}><Button disabled={!grade||!subject||busy}>导入学生名单</Button></Upload>}
    <Button type="primary" disabled={!grade||!subject||busy} onClick={async()=>{setBusy(true);try{await send('/electives',{grade_id:grade,subject,student_ids:kind==='required'?[]:ids,kind},'PUT');await lists.reload();message.success('应考范围已保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}}>保存名单</Button></Space>
    {kind==='elective'?<Table rowKey="id" dataSource={roster} rowSelection={{selectedRowKeys:ids,onChange:keys=>setIds(keys.map(String))}} columns={[{title:'准考证号',dataIndex:'candidate_number'},{title:'姓名',dataIndex:'name'},{title:'行政班',render:(_,s)=>classNames.get(s.class_id)}]}/>:<Tag>使用该年级全体学生</Tag>}</Card></Space>
}


export function SubjectCatalog(){
  const grades=useResource<Row[]>('/grades',[]),students=useResource<Row[]>('/students',[]),classes=useResource<Row[]>('/classes',[])
  const tags=useResource<Row[]>('/subject-tags',[]),[name,setName]=useState(''),[busy,setBusy]=useState(false),{message}=App.useApp()
  async function add(){
    setBusy(true)
    try{await send('/subject-tags',{name:name.trim()});await tags.reload();setName('')}
    catch(e){message.error((e as Error).message)}finally{setBusy(false)}
  }
  return <Tabs items={[{key:'tags',label:'全校科目',children:<Card title="科目表"><Space wrap style={{marginBottom:16}}>
    <Input placeholder="科目名称" value={name} onChange={e=>setName(e.target.value)}/>
    <Button type="primary" disabled={!name.trim()||busy} onClick={add}>添加科目</Button>
    <Upload accept=".csv,.xlsx" showUploadList={false} disabled={busy} beforeUpload={async file=>{
      const body=new FormData();body.append('file',file);setBusy(true)
      try{const result=await request<{created:number}>('/subject-tags/import',{method:'POST',body});await tags.reload();message.success(`新增 ${result.created} 个科目`)}
      catch(e){message.error((e as Error).message)}finally{setBusy(false)}return false
    }}><Button title="Excel 或 CSV，表头为“科目”">导入科目表</Button></Upload>
    </Space><Table rowKey="id" dataSource={tags.data} loading={tags.loading} columns={[{title:'科目',dataIndex:'name'},{title:'操作',render:(_,row)=><DeleteRecord kind="subject-tags" row={row} reload={tags.reload}/>}]}/></Card>},
    {key:'electives',label:'选科名单',children:<Electives key={tags.data.map(t=>t.id).join(',')} grades={grades.data} students={students.data} classes={classes.data}/>}]} />
}

export function CatalogPicker({value=[],onChange}:{value?:string[];onChange?:(ids:string[])=>void}){
  const tags=useResource<Row[]>('/subject-tags',[])
  const options=tags.data.map(t=>({label:t.name,value:t.id}))
  return <Space direction="vertical">{options.length>0?<><Checkbox checked={options.every(t=>value.includes(t.value))} indeterminate={value.length>0&&value.length<options.length} onChange={e=>onChange?.(e.target.checked?options.map(t=>t.value):[])}>全选科目</Checkbox>
    <Checkbox.Group options={options} value={value} onChange={v=>onChange?.(v.map(String))}/></>:!tags.loading&&'请先在科目管理中添加科目。'}</Space>
}
