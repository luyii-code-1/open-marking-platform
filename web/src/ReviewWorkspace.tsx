import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Modal, Popconfirm, Space, Table, Tag } from 'antd'
import { currentToken, type User } from './api'
import { forgetReview, isReviewUpdateLocked, listReviews, watchReviewChanges, type ReviewRecord } from './reviewStore'
import { reviewTransport, syncReviewRecords, type SyncReport } from './reviewSync'

type Workspace={user:User;offline:boolean;records:ReviewRecord[];ready:boolean;storageError:string;updateLocked:boolean;sync:()=>Promise<SyncReport>}
const Context=createContext<Workspace|null>(null)
export function useReviewWorkspace(){const value=useContext(Context);if(!value)throw new Error('阅卷工作区尚未初始化');return value}

export function ReviewWorkspace({user,offline,onVerified,onLoginRequired,children}:{user:User;offline:boolean;onVerified:(user:User)=>void;onLoginRequired:()=>void;children:ReactNode}){
  const [records,setRecords]=useState<ReviewRecord[]>([]),[storageError,setStorageError]=useState(''),[locked,setLocked]=useState(isReviewUpdateLocked()),[status,setStatus]=useState<SyncReport>({state:offline?'offline':'ready',sent:0})
  const [ready,setReady]=useState(false)
  const current=useRef({user,offline,onVerified,onLoginRequired});current.current={user,offline,onVerified,onLoginRequired}
  const flight=useRef<Promise<SyncReport>|null>(null),mounted=useRef(true),loadVersion=useRef(0)
  const reload=useCallback(async()=>{const version=++loadVersion.current;try{const rows=await listReviews(user.id);if(mounted.current&&version===loadVersion.current){setRecords(rows);setStorageError('');setReady(true)}}catch(e){if(mounted.current){setStorageError((e as Error).message);setReady(true)}}},[user.id])
  const sync=useCallback(()=>{
    if(flight.current)return flight.current
    const token=currentToken(),owner=current.current.user.id
    const alive=()=>mounted.current&&currentToken()===token&&current.current.user.id===owner
    if(!token)return Promise.resolve({state:'login',sent:0} as SyncReport)
    const work=(async()=>{
      const result=await syncReviewRecords(owner,reviewTransport(token,alive))
      if(alive()){
        setStatus(result)
        if(result.profile)current.current.onVerified(result.profile)
        if(result.state==='login')current.current.onLoginRequired()
        await reload()
      }
      return result
    })()
    flight.current=work;void work.finally(()=>{flight.current=null});return work
  },[reload])
  useEffect(()=>{
    mounted.current=true
    const change=()=>{setLocked(isReviewUpdateLocked());void reload()}
    const retry=()=>{if(document.visibilityState!=='hidden')void sync()}
    const unwatch=watchReviewChanges(change)
    void reload();void sync()
    const timer=setInterval(retry,15000)
    window.addEventListener('online',retry);document.addEventListener('visibilitychange',retry)
    return()=>{mounted.current=false;clearInterval(timer);unwatch();window.removeEventListener('online',retry);document.removeEventListener('visibilitychange',retry)}
  },[reload,sync])
  useEffect(()=>{if(records.some(r=>r.status==='queued'))void sync()},[records.map(r=>r.operation?.id+':'+r.status).join(','),sync])
  return <Context.Provider value={{user,offline:offline||status.state==='offline',records,ready,storageError,updateLocked:locked,sync}}>{children}<ReviewQueueStatus records={records} status={status} error={storageError} sync={sync}/></Context.Provider>
}

function ReviewQueueStatus({records,status,error,sync}:{records:ReviewRecord[];status:SyncReport;error:string;sync:()=>Promise<SyncReport>}){
  const [open,setOpen]=useState(false)
  const pending=records.filter(r=>r.status==='queued'||r.status==='conflict'),conflicts=pending.filter(r=>r.status==='conflict')
  function exportRecords(){const blob=new Blob([JSON.stringify(pending.map(r=>({task_id:r.task.id,template:r.template.name,question:r.question.number,score:r.operation?.score,operation_id:r.operation?.id,status:r.status,reason:r.error})),null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='阅卷待传记录.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  return <>
    {(pending.length>0||error||status.state==='upgrade')&&<div className="review-queue-status" role="status"><Space wrap>{error?<Alert type="error" message={'本地保存不可用：'+error}/>:<Tag color={conflicts.length?'orange':'blue'}>待上传 {pending.length-conflicts.length} · 待核对 {conflicts.length}</Tag>}{status.message&&<span>{status.message}</span>}<Button size="small" onClick={()=>void sync()}>重试上传</Button>{pending.length>0&&<Button size="small" onClick={()=>setOpen(true)}>查看本地记录</Button>}</Space></div>}
    <Modal title="本地待传评分" width={760} open={open} onCancel={()=>setOpen(false)} footer={<Space><Button onClick={exportRecords}>导出记录</Button><Button onClick={()=>setOpen(false)}>关闭</Button></Space>}>
      <Table rowKey="key" dataSource={pending} pagination={{pageSize:8}} columns={[{title:'题卡',render:(_,r)=>r.template.name},{title:'题号',render:(_,r)=>r.question.number},{title:'分数',render:(_,r)=>r.operation?.score},{title:'状态',render:(_,r)=>r.error||'等待服务器确认'},{title:'操作',render:(_,r)=>r.status==='conflict'?<Popconfirm title="确认已核对或导出这份记录？" description="仅移除本地记录，服务器评分保持当前结果。" onConfirm={()=>forgetReview(r.owner,r.task.id)}><Button size="small">移除本地记录</Button></Popconfirm>:null}]}/>
    </Modal>
  </>
}
