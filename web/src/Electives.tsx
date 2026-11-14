import {useState} from 'react'
import {App, Card, Select, Space, Upload,Radio,Tag,Checkbox,Tabs} from 'antd'
import { Table } from './DataTable'
import {Button} from './Button'
import {request,send,useResource,type Row} from './api'

export function Electives({grades,students,classes}:{grades:Row[];students:Row[];classes:Row[]}) {
  const lists=useResource<Row[]>('/electives',[]),subjects=useResource<Row[]>('/subjects',[])
  const [grade,setGrade]=useState(''),[subject,setSubject]=useState(''),[ids,setIds]=useState<string[]>([]),[busy,setBusy]=useState(false)
  const [kind,setKind]=useState('elective')
  const {message}=App.useApp()
  function choose(g:string,s:string){setGrade(g);setSubject(s);const row=lists.data.find(l=>l.grade_id===g&&l.subject===s);setIds(row?.student_ids||[]);setKind(row?.kind_of_subject||'elective')}
  const classNames=new Map(classes.filter(c=>c.grade_id===grade).map(c=>[c.id,c.name]))
  const roster=students.filter(s=>classNames.has(s.class_id))
  return <Space direction="vertical" style={{width:'100%'}}><Card title="年级科目" extra={<Upload accept=".csv,.xlsx" disabled={busy} showUploadList={false} beforeUpload={async f=>{setBusy(true);try{const body=new FormData();body.append('file',f);const r=await request<{created:number}>('/electives/import-catalog',{method:'POST',body});await lists.reload();message.success(`已新增 ${r.created} 门年级科目`)}catch(e){message.error((e as Error).message)}finally{setBusy(false)}return false}}><Button disabled={busy} title="表头：年级、科目、类型（必考或选考）">导入科目表</Button></Upload>}><Tabs items={grades.filter(g=>!g.archived).map(g=>({key:g.id,label:g.name,children:<Table<Row> rowKey="id" dataSource={lists.data.filter(row=>row.grade_id===g.id)} loading={lists.loading} columns={[{title:'科目',dataIndex:'subject'},{title:'应考范围',render:(_,r)=>r.kind_of_subject==='required'?'年级全体':`选考 · ${r.student_ids.length} 人`},{title:'操作',render:(_,r)=><Button onClick={()=>choose(r.grade_id,r.subject)}>编辑</Button>}]}/>}))}/></Card><Card title="设置科目"><Space wrap style={{marginBottom:16}}>
    <Select disabled={busy} placeholder="选择年级" style={{width:160}} value={grade||undefined} onChange={g=>choose(g,subject)} options={grades.map(g=>({value:g.id,label:g.name}))}/>
    <Select disabled={busy} mode="tags" maxCount={1} placeholder="选择或输入科目" style={{width:220}} value={subject?[subject]:[]} onChange={v=>choose(grade,v[v.length-1]||'')} options={[...new Set([...subjects.data.map(s=>s.name),...lists.data.map(l=>l.subject)])].map(value=>({value}))}/>
    <Radio.Group disabled={busy} value={kind} onChange={e=>setKind(e.target.value)} options={[{value:'required',label:'必考'},{value:'elective',label:'选考'}]}/>
    {kind==='elective'&&<Upload accept=".csv,.xlsx" showUploadList={false} disabled={!grade||!subject||busy} beforeUpload={async f=>{setBusy(true);try{const data=new FormData();data.append('file',f);setIds(await request('/electives/match?grade_id='+grade,{method:'POST',body:data}));message.success('已匹配名单，请核对后保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}return false}}><Button disabled={!grade||!subject||busy}>导入学生名单</Button></Upload>}
    <Button type="primary" disabled={!grade||!subject||busy} onClick={async()=>{setBusy(true);try{await send('/electives',{grade_id:grade,subject,student_ids:kind==='required'?[]:ids,kind},'PUT');await lists.reload();message.success('科目已保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}}>保存科目</Button></Space>
    {kind==='elective'?<Table rowKey="id" dataSource={roster} rowSelection={{selectedRowKeys:ids,onChange:keys=>setIds(keys.map(String))}} columns={[{title:'准考证号',dataIndex:'candidate_number'},{title:'姓名',dataIndex:'name'},{title:'行政班',render:(_,s)=>classNames.get(s.class_id)}]}/>:<Tag>使用该年级全体学生</Tag>}</Card></Space>
}


export function SubjectCatalog(){
  const grades=useResource<Row[]>('/grades',[]),students=useResource<Row[]>('/students',[]),classes=useResource<Row[]>('/classes',[])
  return <Electives grades={grades.data} students={students.data} classes={classes.data}/>
}

export function CatalogPicker({value=[],onChange}:{value?:string[];onChange?:(ids:string[])=>void}){
  const grades=useResource<Row[]>('/grades',[]),catalog=useResource<Row[]>('/electives',[])
  const groups=grades.data.filter(g=>!g.archived).map(g=>({grade:g,items:catalog.data.filter(c=>c.grade_id===g.id)})).filter(g=>g.items.length)
  const all=groups.flatMap(g=>g.items.map(c=>c.id))
  return <Space direction="vertical">{groups.length>0&&<Checkbox checked={all.every(id=>value.includes(id))} indeterminate={value.length>0&&value.length<all.length} onChange={e=>onChange?.(e.target.checked?all:[])}>全选科目</Checkbox>}
    {groups.map(({grade,items})=><div key={grade.id}><strong>{grade.name}</strong><div><Checkbox.Group options={items.map(i=>({label:i.subject,value:i.id}))} value={value.filter(id=>items.some(i=>i.id===id))} onChange={v=>onChange?.([...value.filter(id=>!items.some(i=>i.id===id)),...v.map(String)])}/></div></div>)}
    {!groups.length&&!catalog.loading&&'可在「科目管理」中添加年级科目。'}</Space>
}
