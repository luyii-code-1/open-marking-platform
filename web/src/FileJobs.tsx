import { useEffect, useState } from 'react'
import { App, Button, Card, Progress, Space, Table, Tag, Typography } from 'antd'
import { downloadArchive,send,useResource,type Row } from './api'

const labels:Record<string,string>={'archive-project':'生成归档','preview-release':'核对释放清单','release-project':'释放扫描文件','restore-archive':'恢复扫描文件'}

export function useFileJobs(project:string) {
  const resource=useResource<Row[]>(project?`/jobs?project_id=${project}`:null,[])
  const [watch,setWatch]=useState(''),[finished,setFinished]=useState<Row|null>(null)
  const rows=resource.data.filter(j=>j.project_id===project&&labels[j.kind]).sort((a,b)=>b.created_at-a.created_at)
  const active=rows.some(j=>j.status==='pending'||j.status==='running')
  useEffect(()=>{setWatch('');setFinished(null)},[project])
  useEffect(()=>{if(!watch&&!active)return;const timer=setInterval(resource.reload,2000);return()=>clearInterval(timer)},[watch,active,resource.reload])
  useEffect(()=>{const job=rows.find(j=>j.id===watch);if(job&&job.status!=='pending'&&job.status!=='running'){setWatch('');setFinished({...job})}},[resource.data,watch])
  async function submit(path:string,body?:unknown){setFinished(null);const job=await send<Row>(path,body);setWatch(job.id);await resource.reload();return job}
  async function retry(id:string){setFinished(null);await send(`/jobs/${id}/retry`);setWatch(id);await resource.reload()}
  return {rows,active,finished,error:resource.error,reload:resource.reload,submit,retry,inspect:(job:Row)=>setFinished({...job})}
}

export function FileJobTable({jobs}:{jobs:ReturnType<typeof useFileJobs>}) {
  const {message}=App.useApp()
  async function download(id:string){try{await downloadArchive(id,'考试归档.zip')}catch(e){message.error((e as Error).message)}}
  async function retry(id:string){try{await jobs.retry(id)}catch(e){message.error((e as Error).message)}}
  return <Card title="后台文件任务" extra={<Button onClick={jobs.reload}>刷新</Button>}><Table rowKey="id" dataSource={jobs.rows} columns={[
    {title:'操作',dataIndex:'kind',render:value=>labels[value]},
    {title:'状态',dataIndex:'status',render:value=><Tag color={value==='failed'?'red':value==='completed'?'green':'blue'}>{({pending:'等待执行或重试',running:'执行中',completed:'已完成',failed:'执行失败'} as Record<string,string>)[value]||value}</Tag>},
    {title:'阶段进度',render:(_,job)=><div style={{minWidth:180}}><Typography.Text>{job.phase||'等待执行'} {job.progress_total?`${job.progress_current||0}/${job.progress_total}`:''}</Typography.Text><Progress percent={job.status==='completed'?100:job.progress_total?Math.round(100*(job.progress_current||0)/job.progress_total):0} status={job.status==='failed'?'exception':job.status==='running'?'active':undefined}/></div>},
    {title:'核查信息',dataIndex:'error_detail'},
    {title:'操作',render:(_,job)=><Space wrap>{job.status==='failed'&&<Button disabled={jobs.active} onClick={()=>retry(job.id)}>重试</Button>}{job.status==='completed'&&job.kind==='archive-project'&&<Button onClick={()=>download(job.result.id)}>下载归档</Button>}{job.status==='completed'&&['preview-release','release-project'].includes(job.kind)&&<Button onClick={()=>jobs.inspect(job)}>查看结果</Button>}</Space>},
  ]}/></Card>
}
