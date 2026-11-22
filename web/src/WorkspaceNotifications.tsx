import {setServiceSlow,serviceIsSlow} from './networkPolicy'
import {useEffect,useState} from 'react'
import {Alert,App,Badge,Drawer,List,Space,Tag} from 'antd'
import {Button} from './Button'
import {request,type Row} from './api'

export function useWorkspaceNotifications(management:boolean){
  const [open,setOpen]=useState(false),[slow,setSlow]=useState(false),[jobs,setJobs]=useState<Row[]>([]),{notification}=App.useApp()
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>,lastNotice=0
    async function tick(){
      if(document.visibilityState==='visible'&&navigator.onLine){
        try{
          const status=await request<{state:string}>('/system/service-status')
          if(stopped)return
          setSlow(status.state==='slow');setServiceSlow(status.state==='slow')
          if(status.state==='slow'&&Date.now()-lastNotice>300000){lastNotice=Date.now();notification.warning({key:'service-slow',message:'服务器响应较慢',description:'请求会自动降低频率并重试，请保留当前页面。',duration:8})}
          if(management){const value=await request<{jobs:Row[]}>('/workspace/activity');if(!stopped)setJobs(value.jobs)}
        }catch{/* Connectivity state is handled by the review workspace. */}
      }
      if(!stopped)timer=setTimeout(tick,document.visibilityState==='visible'?(serviceIsSlow()?60000:30000):90000)
    }
    void tick()
    return()=>{stopped=true;clearTimeout(timer);notification.destroy('service-slow')}
  },[management,notification])
  return <><Badge count={jobs.length+(slow?1:0)} size="small"><Button onClick={()=>setOpen(true)}>通知</Button></Badge>
    <Drawer title="重要通知" open={open} onClose={()=>setOpen(false)} width={480}>
      {slow&&<Alert type="warning" showIcon message="服务器响应较慢" description="正在自动降低状态查询频率，请稍候。"/>}
      <List dataSource={jobs} locale={{emptyText:'暂无待处理通知'}} renderItem={job=><List.Item><Space direction="vertical"><Space><Tag color={job.status==='failed'?'error':'processing'}>{job.status==='failed'?'失败':job.status==='running'?'进行中':'等待中'}</Tag><a href={job.project_id?`#/exams/${job.project_id}`:'#/dashboard'}>{job.stage||job.kind}</a></Space>{job.error_detail&&<span>{job.error_detail}</span>}</Space></List.Item>}/>
    </Drawer></>
}
