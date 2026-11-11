import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Descriptions, Modal, Popconfirm, Select, Space, Table, Typography } from 'antd'
import { downloadArchive,request,send,useResource,type Row } from './api'

import { FileJobTable,useFileJobs } from './FileJobs'

const bytes=(value:number)=>value>=1024**3?`${(value/1024**3).toFixed(2)} GB`:`${(value/1024**2).toFixed(2)} MB`

export function ArchiveManager() {
  const projects=useResource<Row[]>('/projects',[]),archives=useResource<Row[]>('/archives',[])
  const [project,setProject]=useState(''),[mode,setMode]=useState('all'),[plan,setPlan]=useState<Row|null>(null),[outcome,setOutcome]=useState<any>(null),[busy,setBusy]=useState(false),{message}=App.useApp()
  const jobs=useFileJobs(project)
  useEffect(()=>{
    const job=jobs.finished;if(!job)return
    void archives.reload();void projects.reload()
    if(job.status==='failed'){message.error(job.error_detail||'任务失败，可核查后重试');return}
    if(job.kind==='preview-release'){setPlan(job.result);setOutcome(null)}
    else if(job.kind==='release-project'){void request<Row>(`/release-plans/${job.payload.plan_id}`).then(value=>{setPlan(value);setOutcome(job.result)}).catch(e=>message.error(e.message))}
    else message.success(job.kind==='archive-project'?'归档已生成并校验，可下载':`已恢复 ${job.result?.restored_files||0} 个文件`)
  },[jobs.finished])
  const scoped=archives.data.filter(a=>a.project_id===project).sort((a,b)=>b.created_at-a.created_at)
  async function enqueue(path:string,body?:unknown){setBusy(true);try{await jobs.submit(path,body);message.success('后台任务已提交，进度会自动更新')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  async function create(){await enqueue(`/projects/${project}/archive-jobs`)}
  async function preview(id:string){setOutcome(null);await enqueue(`/projects/${project}/release-preview-jobs`,{archive_id:id,mode})}
  async function release(){if(!plan||busy)return;const id=plan.id;setPlan(null);await enqueue(`/projects/${project}/release-jobs`,{plan_id:id,confirm:true})}
  async function restore(id:string){await enqueue(`/archives/${id}/restore-jobs`)}
  return <Space direction="vertical" size="large" style={{width:'100%'}}><Card title="归档与扫描文件管理" extra={<Button disabled={busy} onClick={()=>{void projects.reload();void archives.reload()}}>刷新</Button>}>
    {(projects.error||archives.error||jobs.error)&&<Alert type="error" message={projects.error||archives.error||jobs.error}/>}
    <Space wrap><Select style={{width:300}} placeholder="选择考试项目" disabled={busy} value={project||undefined} onChange={setProject} options={projects.data.map(p=>({label:p.name,value:p.id}))}/><Button type="primary" loading={busy} disabled={!project||jobs.active} onClick={create}>生成归档</Button><Select style={{width:260}} disabled={busy} value={mode} onChange={setMode} options={[{label:'释放本地及远端扫描文件',value:'all'},{label:'仅释放本地活动扫描文件',value:'local'}]}/></Space>
    <Typography.Paragraph type="secondary" style={{marginTop:16}}>归档、清单核对、释放和恢复在后台执行，关闭页面后任务继续处理。任务完成后可下载归档；释放前需先发布项目各题卡组，再核对清单并确认。</Typography.Paragraph>
    <Alert type="info" message="释放的是活动扫描文件副本，归档ZIP仍保留并占用空间。查看原卷时会从归档取回所需文件；恢复入口可一次恢复扫描文件和题卡资产，保留当前数据库中的最新成绩。"/>
    <Table rowKey="id" loading={archives.loading} dataSource={scoped} scroll={{x:'max-content'}} columns={[{title:'创建时间',dataIndex:'created_at',render:value=>new Date(value*1000).toLocaleString()},{title:'归档大小',dataIndex:'size',render:value=>value===undefined?'—':bytes(value)},{title:'扫描及题卡文件',dataIndex:'asset_count'},{title:'SHA-256',dataIndex:'sha256',ellipsis:true},{title:'操作',render:(_,row)=><Space wrap><Button disabled={busy} onClick={async()=>{try{await downloadArchive(row.id,'考试归档.zip')}catch(e){message.error((e as Error).message)}}}>下载</Button><Button disabled={busy||jobs.active} onClick={()=>preview(row.id)}>预览释放</Button><Popconfirm title="从此归档恢复扫描文件？" description="逐项校验；现有文件与归档不一致时不会覆盖，当前评分记录保留。" onConfirm={()=>restore(row.id)}><Button disabled={busy||jobs.active}>恢复扫描文件</Button></Popconfirm></Space>}]} />
  </Card>
    {project&&<FileJobTable jobs={jobs}/>}
    <Modal width={900} title="核对释放清单并再次确认" open={!!plan} onCancel={()=>!busy&&setPlan(null)} maskClosable={!busy} closable={!busy} confirmLoading={busy} onOk={outcome?.status==='completed'?()=>setPlan(null):release} okText={outcome?.status==='completed'?'完成':outcome?.status==='partial'?'重试未完成文件':'确认释放清单中的扫描文件'} okButtonProps={{danger:outcome?.status!=='completed',disabled:outcome?.status!=='completed'&&(!plan?.can_confirm||jobs.active||(plan?.status==='preview'&&plan.expires_at<Date.now()/1000))}} cancelButtonProps={{disabled:busy}}>
      {plan&&<><Descriptions column={2} items={[{label:'范围',children:plan.mode==='all'?'本地及远端':'仅本地'},{label:'扫描文件数',children:plan.file_count},{label:'本地活动文件大小',children:bytes(plan.local_bytes)},{label:'远端文件数',children:plan.remote_files}]}/><Typography.Paragraph>归档、打印稿、题卡资产、成绩和审计保留。以下共 {plan.file_count} 项，最多显示前100项。清单生成后10分钟内可确认。</Typography.Paragraph>{plan.status==='preview'&&plan.expires_at<Date.now()/1000&&<Alert type="warning" message="清单已过期，请重新预览。"/>}<Table rowKey="relative" size="small" dataSource={plan.files} pagination={{pageSize:8}} columns={[{title:'考号',dataIndex:'candidate_number',render:value=>value||'未识读'},{title:'面',dataIndex:'side',render:value=>value==='front'?'正面':value==='back'?'背面':'—'},{title:'序号',dataIndex:'sequence'},{title:'文件类型',dataIndex:'relative',render:value=>value.endsWith('.image')?'原始图':'校正图'},{title:'大小',dataIndex:'size',render:bytes}]}/></>}
      {outcome&&<Alert type={outcome.status==='completed'?'success':'warning'} message={outcome.status==='completed'?`已处理 ${outcome.released_files} 项`:`${outcome.failed.length} 项未完成，可重试`} description={outcome.status==='partial'?outcome.failed.slice(0,10).map((f:any)=>`${f.relative}：${f.error}`).join('；'):undefined}/>}
    </Modal>
  </Space>
}
