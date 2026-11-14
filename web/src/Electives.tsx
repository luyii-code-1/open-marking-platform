import {useState} from 'react'
import {App, Card, Select, Space, Upload} from 'antd'
import { Table } from './DataTable'
import {Button} from './Button'
import {request,send,useResource,type Row} from './api'

export function Electives({grades,students,classes}:{grades:Row[];students:Row[];classes:Row[]}) {
  const lists=useResource<Row[]>('/electives',[]),subjects=useResource<Row[]>('/subjects',[])
  const [grade,setGrade]=useState(''),[subject,setSubject]=useState(''),[ids,setIds]=useState<string[]>([]),[busy,setBusy]=useState(false)
  const {message}=App.useApp()
  function choose(g:string,s:string){setGrade(g);setSubject(s);setIds(lists.data.find(l=>l.grade_id===g&&l.subject===s)?.student_ids||[])}
  const classNames=new Map(classes.filter(c=>c.grade_id===grade).map(c=>[c.id,c.name]))
  const roster=students.filter(s=>classNames.has(s.class_id))
  return <Card title="选科管理"><Space wrap style={{marginBottom:16}}>
    <Select placeholder="选择年级" style={{width:160}} value={grade||undefined} onChange={g=>choose(g,subject)} options={grades.map(g=>({value:g.id,label:g.name}))}/>
    <Select mode="tags" maxCount={1} placeholder="选择或输入科目" style={{width:220}} value={subject?[subject]:[]} onChange={v=>choose(grade,v[v.length-1]||'')} options={[...new Set([...subjects.data.map(s=>s.name),...lists.data.map(l=>l.subject)])].map(value=>({value}))}/>
    <Upload accept=".csv,.xlsx" showUploadList={false} disabled={!grade||!subject||busy} beforeUpload={async f=>{setBusy(true);try{const data=new FormData();data.append('file',f);setIds(await request('/electives/match?grade_id='+grade,{method:'POST',body:data}));message.success('已匹配名单，请核对后保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}return false}}><Button disabled={!grade||!subject||busy}>导入准考证号</Button></Upload>
    <Button type="primary" disabled={!grade||!subject||busy} onClick={async()=>{setBusy(true);try{await send('/electives',{grade_id:grade,subject,student_ids:ids},'PUT');await lists.reload();message.success('选科名单已保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}}>保存名单（{ids.length} 人）</Button></Space>
    <Table rowKey="id" dataSource={roster} rowSelection={{selectedRowKeys:ids,onChange:keys=>setIds(keys.map(String))}} columns={[{title:'准考证号',dataIndex:'candidate_number'},{title:'姓名',dataIndex:'name'},{title:'行政班',render:(_,s)=>classNames.get(s.class_id)}]}/></Card>
}

