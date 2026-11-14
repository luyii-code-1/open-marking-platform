import {useState} from 'react'
import {App, Card, Form, Modal, Select, Space, Switch, Upload, Popconfirm} from 'antd'
import { Table } from './DataTable'
import {Button} from './Button'
import {download,request,send,useResource,type Row} from './api'

export function Teaching({classes,users,grades,reload}:{classes:Row[];users:Row[];grades:Row[];reload:()=>Promise<any>}) {
  const {message}=App.useApp(), [form]=Form.useForm(), [open,setOpen]=useState(false),[editing,setEditing]=useState(false)
  const [busy,setBusy]=useState(false)
  const subjects=useResource<Row[]>('/subjects',[])
  const label=(c:Row)=>[grades.find(g=>g.id===c.grade_id)?.name||c.grade,c.name].filter(Boolean).join(' · ')
  const rows=classes.flatMap(c=>(c.teacher_ids||[]).map((id:string)=>({id:c.id+id,class_id:c.id,teacher_id:id,teacher:users.find(u=>u.id===id)?.name,className:label(c),...c.teaching?.[id]})))
  function edit(row?:any){form.resetFields();form.setFieldsValue({subjects:[],...row,homeroom:row?.homeroom===true});setEditing(!!row);setOpen(true)}
  return <Card title="任教关系" extra={<Space wrap><Button onClick={()=>download('/teaching/template','教师任教关系.xlsx').catch(e=>message.error(e.message))}>下载模板</Button>
    <TeacherImport classes={classes} users={users} grades={grades} reload={reload}/>
    <Button type="primary" onClick={()=>edit()}>设置任教关系</Button></Space>}>
    <Table dataSource={rows} rowKey="id" columns={[{title:'教师',dataIndex:'teacher'},{title:'行政班',dataIndex:'className'},{title:'学科',render:(_,r)=>r.subjects?.join('、')||'—'},
      {title:'班主任',render:(_,r)=>r.homeroom==null?'待设置':r.homeroom?'是':'否'},{title:'操作',render:(_,r)=><Space><Button onClick={()=>edit(r)}>编辑</Button>
        <Popconfirm title="移除这条任教关系？" onConfirm={async()=>{try{await send('/teaching/relation',{...r,subjects:[],homeroom:false},'DELETE');await reload()}catch(e){message.error((e as Error).message)}}}><Button danger>移除</Button></Popconfirm></Space>}]}/>
    <Modal open={open} title="设置任教关系" confirmLoading={busy} onCancel={()=>setOpen(false)} onOk={()=>form.submit()}>
      <Form form={form} layout="vertical" onFinish={async v=>{setBusy(true);try{await send('/teaching/relation',v,'PUT');await reload();setOpen(false)}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}}>
        <Form.Item name="teacher_id" label="教师" rules={[{required:true}]}><Select disabled={editing} showSearch optionFilterProp="label" options={users.filter(u=>u.role==='teacher').map(u=>({value:u.id,label:u.name+' · '+u.username}))}/></Form.Item>
        <Form.Item name="class_id" label="行政班" rules={[{required:true}]}><Select disabled={editing} showSearch optionFilterProp="label" options={classes.map(c=>({value:c.id,label:label(c)}))}/></Form.Item>
        <Form.Item name="subjects" label="任教学科"><Select mode="tags" options={[...new Set(subjects.data.map(s=>s.name))].map(value=>({value}))}/></Form.Item>
        <Form.Item name="homeroom" label="担任该班班主任" valuePropName="checked"><Switch/></Form.Item>
      </Form></Modal>
</Card>
}

export function TeacherImport({classes,users,grades,reload}:{classes:Row[];users:Row[];grades:Row[];reload:()=>Promise<any>}) {
  const {message}=App.useApp()
  const [file,setFile]=useState<File>(),[report,setReport]=useState<any>(),[busy,setBusy]=useState(false)
  const [choices,setChoices]=useState<Record<string,string>>({}),[credentials,setCredentials]=useState<any[]>([])
  const label=(c:Row)=>[grades.find(g=>g.id===c.grade_id)?.name||c.grade,c.name].filter(Boolean).join(' · ')
  async function apply(next:File,commit:boolean){
    setBusy(true)
    try{const data=new FormData();data.append('file',next);data.append('decisions',JSON.stringify(commit?choices:{}));const res=await request('/teaching/import?commit='+commit,{method:'POST',body:data})
      if(res.saved){setCredentials(res.created||[]);setReport(undefined);await reload();message.success('任教关系已导入')}else{if(!commit)setChoices({});setFile(next);setReport(res)}
    }catch(e){message.error((e as Error).message)}finally{setBusy(false)}
  }
  return <><Upload showUploadList={false} accept=".csv,.xlsx" beforeUpload={f=>{void apply(f,false);return false}}><Button loading={busy}>导入任课表</Button></Upload>
    <Modal open={!!report} title="任教关系导入预览" onCancel={()=>setReport(undefined)} okText="创建账号并导入已匹配关系" confirmLoading={busy} okButtonProps={{disabled:!!report?.errors.length||!(report?.count||report?.planned?.length||Object.values(choices).some(Boolean))}} onOk={()=>file&&apply(file,true)}>
      {!!report?.planned?.length&&<p>预计新建 {report.planned.length} 个普通教师账号，初始密码在导入完成后下载。</p>}
      {!!report?.pending?.length&&<Table<Row> rowKey="cell" size="small" dataSource={report.pending} columns={[{title:'重名教师',dataIndex:'name'},{title:'原表安排',dataIndex:'description'},{title:'确认身份',render:(_,r)=><Select style={{minWidth:180}} value={choices[r.cell]||''} onChange={v=>setChoices({...choices,[r.cell]:v})} options={[{value:'',label:'暂缓导入'},...r.accounts.map((a:any)=>({value:a.id,label:a.username})),{value:'new',label:'同名行共建一个账号'},{value:'separate',label:'为此行单独建号'}]}/>}]} />}
      <p>共匹配 {report?.count} 条教师与行政班关系。导入后更新这些关系的任教学科。</p>
      <Table rowKey={r=>r.teacher_id+r.class_id} size="small" dataSource={report?.relations||[]} pagination={{pageSize:5}} columns={[{title:'教师',render:(_,r)=>users.find(u=>u.id===r.teacher_id)?.name||report.planned?.find((u:any)=>u.id===r.teacher_id)?.name},{title:'行政班',render:(_,r)=>{const c=classes.find(v=>v.id===r.class_id);return c?label(c):''}},{title:'学科',render:(_,r)=>r.subjects.join('、')},{title:'班主任',render:(_,r)=>r.homeroom==null?'待设置':r.homeroom?'是':'否'}]}/>
      {!!report?.skipped?.length&&<p>跳过 {report.skipped.length} 项</p>}
      <div style={{maxHeight:300,overflow:'auto'}}>{[...(report?.errors||[]),...(report?.skipped||[])].map((s,i)=><div key={i}>{s}</div>)}</div>
    </Modal>
    <Modal open={!!credentials.length} title="教师账号已创建" closable={false} maskClosable={false} footer={<Button onClick={()=>{const text=credentials.map(c=>[c.name,c.username,c.password].map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff姓名,账号,初始密码\r\n'+text],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='新建教师账号.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setCredentials([])}}>下载账号清单</Button>}>
      本次新建 {credentials.length} 个账号。请保存清单后分别交给相应教师。</Modal></>
}

