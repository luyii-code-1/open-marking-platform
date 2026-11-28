import {questionLabel} from './mergeQuestions'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Alert, App, Button, Modal, Popconfirm, Space } from 'antd'
import { Table } from './DataTable'
import { currentToken, setSessionNotice, type User } from './api'
import { sessionEndedMessage } from './sharedSession'
import { forgetReview, hasUnsentReview, isReviewUpdateLocked, listReviews, retryFailedReview, watchReviewChanges, type ReviewRecord } from './reviewStore'
import {useUnsavedChanges} from './useNavigation'
import { reviewTransport, syncReviewRecords, type SyncReport } from './reviewSync'

type Workspace={user:User;offline:boolean;records:ReviewRecord[];ready:boolean;storageError:string;updateLocked:boolean;pendingCount:number;sync:()=>Promise<SyncReport>;setQueueTarget:(target:HTMLDivElement|null)=>void;openQueueModal:()=>void}
const Context=createContext<Workspace|null>(null)
export function useReviewWorkspace(){const value=useContext(Context);if(!value)throw new Error('阅卷工作区尚未初始化');return value}

export function ReviewWorkspace({user,offline,onVerified,onLoginRequired,children}:{user:User;offline:boolean;onVerified:(user:User)=>void;onLoginRequired:()=>void;children:ReactNode}){
  useEffect(() => {
    if (!import.meta.env.PROD || user.role === 'admin' || !('serviceWorker' in navigator)) return
    let mounted = true
    function warmReview() {
      if (!navigator.onLine) return
      void navigator.serviceWorker.ready.then(registration => {
        if (!mounted) return
        const message = { type: 'PREPARE_REVIEW_SHELL' }
        registration.active?.postMessage(message)
        registration.waiting?.postMessage(message)
      }).catch(() => {})
    }
    warmReview()
    window.addEventListener('online', warmReview)
    navigator.serviceWorker.addEventListener('controllerchange', warmReview)
    return () => {
      mounted = false
      window.removeEventListener('online', warmReview)
      navigator.serviceWorker.removeEventListener('controllerchange', warmReview)
    }
  }, [user.role])
  const [records,setRecords]=useState<ReviewRecord[]>([]),[storageError,setStorageError]=useState(''),[locked,setLocked]=useState(isReviewUpdateLocked()),[status,setStatus]=useState<SyncReport>({state:offline?'offline':'ready',sent:0})
  const [ready,setReady]=useState(false)
  const retryNeeded=useRef(false)
  retryNeeded.current=offline||status.state==='offline'||records.some(record=>record.status==='queued')
  const {message}=App.useApp()
  useUnsavedChanges(records.some(hasUnsentReview),true)
  const [queueTarget,setQueueTarget]=useState<HTMLDivElement|null>(null)
  const [queueOpen,setQueueOpen]=useState(false)
  const openQueueModal=useCallback(()=>setQueueOpen(true),[])
  const current=useRef({user,offline,onVerified,onLoginRequired});current.current={user,offline,onVerified,onLoginRequired}
  const flight=useRef<Promise<SyncReport>|null>(null),rerun=useRef(false),mounted=useRef(true),loadVersion=useRef(0)
  const reload=useCallback(async()=>{const version=++loadVersion.current;try{const rows=await listReviews(user.id);if(mounted.current&&version===loadVersion.current){setRecords(rows);setStorageError('');setReady(true)}}catch(e){if(mounted.current){setStorageError((e as Error).message);setReady(true)}}},[user.id])
  const sync=useCallback(():Promise<SyncReport>=>{
    if(flight.current){rerun.current=true;return flight.current}
    rerun.current=false
    const token=currentToken(),owner=current.current.user.id
    const alive=()=>mounted.current&&currentToken()===token&&current.current.user.id===owner
    if(!token)return Promise.resolve({state:'login',sent:0} as SyncReport)
    const work=(async():Promise<SyncReport>=>{
      let result:SyncReport
      try{
        const upload=()=>alive()?syncReviewRecords(owner,reviewTransport(token,alive,(reason,detail)=>setSessionNotice(sessionEndedMessage(reason,detail)))):Promise.resolve({state:'login',sent:0} as SyncReport)
        result=navigator.locks?await navigator.locks.request('omp-score-upload:'+owner,upload):await upload()
      }catch(e){
        if(alive())setStorageError('无法读写本地评分：'+(e as Error).message)
        return {state:'ready',sent:0}
      }
      if(alive()){
        setStatus(result)
        if(result.profile)current.current.onVerified(result.profile)
        if(result.state==='login'){
          if((await listReviews(owner)).some(hasUnsentReview))message.warning('评分已保存在本机，请使用原账号重新登录')
          if(alive())current.current.onLoginRequired()
        }
        await reload()
      }
      return result
    })().catch((e):SyncReport=>{
      if(alive())setStorageError((e as Error).message)
      return {state:'ready',sent:0}
    })
    flight.current=work
    void work.then(result=>{
      flight.current=null
      if(rerun.current&&alive()&&(result.state==='ready'||result.state==='offline'))void sync()
    })
    return work
  },[reload,message])
  useEffect(()=>{
    mounted.current=true
    const change=()=>{setLocked(isReviewUpdateLocked());void reload()}
    const retry=()=>{if(document.visibilityState!=='hidden')void sync()}
    const unwatch=watchReviewChanges(change)
    void reload();void sync()
    const timer=setInterval(()=>{if(retryNeeded.current)retry()},15000)
    window.addEventListener('online',retry);document.addEventListener('visibilitychange',retry)
    return()=>{mounted.current=false;clearInterval(timer);unwatch();window.removeEventListener('online',retry);document.removeEventListener('visibilitychange',retry)}
  },[reload,sync])
  const queued=records.filter(r=>r.status==='queued'&&r.operation)
  const nextAttempt=queued.length?Math.min(...queued.map(r=>r.retryAt??0)):null
  const queueKey=queued.map(r=>r.operation!.id+':'+(r.failures??0)).join(',')
  useEffect(()=>{
    if(nextAttempt===null||status.state==='upgrade')return
    const timer=setTimeout(()=>void sync(),Math.max(0,nextAttempt-Date.now()))
    return()=>clearTimeout(timer)
  },[nextAttempt,queueKey,status.state,sync])
  const pendingCount=records.filter(r=>r.operation).length
  return <Context.Provider value={{user,offline:offline||status.state==='offline',records,ready,storageError,updateLocked:locked,pendingCount,sync,setQueueTarget,openQueueModal}}>{children}<ReviewQueueStatus records={records} status={status} error={storageError} sync={sync} target={queueTarget} open={queueOpen} setOpen={setQueueOpen}/></Context.Provider>
}

function ReviewQueueStatus({records,status,error,sync,target,open,setOpen}:{records:ReviewRecord[];status:SyncReport;error:string;sync:()=>Promise<SyncReport>;target:HTMLDivElement|null;open:boolean;setOpen:(open:boolean)=>void}){
  const pending=records.filter(r=>r.operation),queued=pending.filter(r=>r.status==='queued'),failed=pending.filter(r=>r.status==='failed'),conflicts=pending.filter(r=>r.status==='conflict')
  const {message}=App.useApp()
  async function retry(){
    try{await Promise.all(failed.map(retryFailedReview));await sync()}catch(e){message.error((e as Error).message)}
  }
  function exportRecords(){const blob=new Blob([JSON.stringify(pending.map(r=>({task_id:r.task.id,template:r.template.name,question:questionLabel(r.question),score:r.operation?.score,operation_id:r.operation?.id,status:r.status,reason:r.error})),null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='阅卷待传记录.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  const notice=(pending.length>0||error||status.state==='upgrade')&&<div className="review-queue-status" role="alert"><Space wrap>
    {error&&<Alert type="error" message={'本地保存不可用：'+error}/>}
    {queued.length>0&&failed.length===0&&conflicts.length===0&&<span>{queued.length} 份评分正在等待服务器确认</span>}
    {failed.length>0&&<><span>{failed.length} 份评分重试 3 次后仍未上传，分数已保存在本机。</span><Button size="small" onClick={retry}>重试上传</Button></>}
    {conflicts.length>0&&<span>{conflicts.length} 份评分需要核对</span>}
    {status.message&&<span>{status.message}</span>}
    {pending.length>0&&<Button size="small" onClick={()=>setOpen(true)}>查看本地记录</Button>}</Space></div>
  return <>
    {target?createPortal(notice,target):notice}
    <Modal title="本地待传评分" width={760} open={open} onCancel={()=>setOpen(false)} footer={<Space><Button onClick={exportRecords}>导出记录</Button><Button onClick={()=>setOpen(false)}>关闭</Button></Space>}>
      <Table rowKey="key" dataSource={pending} pagination={{defaultPageSize:50}} columns={[{title:'题卡',render:(_,r)=>r.template.name},{title:'题号',render:(_,r)=>questionLabel(r.question)},{title:'分数',render:(_,r)=>r.operation?.score},{title:'状态',render:(_,r)=>r.error||'等待服务器确认'},{title:'操作',render:(_,r)=>r.status==='conflict'?<Popconfirm title="确认已核对或导出这份记录？" description="仅移除本地记录，服务器评分保持当前结果。" onConfirm={()=>forgetReview(r.owner,r.task.id)}><Button size="small">移除本地记录</Button></Popconfirm>:null}]}/>
    </Modal>
  </>
}
