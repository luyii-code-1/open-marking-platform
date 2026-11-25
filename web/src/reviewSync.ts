import { blockReview, confirmReview, listReviews, pruneConfirmedReviews, recordUploadFailure } from './reviewStore'
import type { Row, User } from './api'

export type SyncResponse={status:number;body:any}
export type ReviewTransport=(path:string,body?:unknown)=>Promise<SyncResponse>
export type SyncReport={state:'ready'|'offline'|'login'|'upgrade';sent:number;message?:string;profile?:User}

export async function syncReviewRecords(owner:string,transport:ReviewTransport,now=Date.now):Promise<SyncReport>{
  let sent=0
  const due=(await listReviews(owner)).filter(r=>r.status==='queued'&&r.operation&&(r.retryAt??0)<=now())
    .sort((a,b)=>a.updatedAt-b.updatedAt)
  const request=async(path:string,body?:unknown):Promise<SyncResponse>=>{
    try{return await transport(path,body)}catch{return {status:0,body:{}}}
  }
  const transient=(status:number)=>status===0||status>=500||[408,425,429].includes(status)
  async function unavailable(reason:string):Promise<SyncReport>{
    for(const row of due)await recordUploadFailure(row,reason,now())
    return {state:'offline',sent}
  }
  const me=await request('/auth/me')
  if(me.status===401||me.status===403)return {state:'login',sent}
  if(me.status!==200)return unavailable('无法连接服务器验证账号')
  if(me.body.id!==owner)return {state:'login',sent,message:'请使用保存这些评分的账号登录'}
  const capabilities=await request('/review/offline-capabilities')
  if(capabilities.status===401||capabilities.status===403)return {state:'login',sent}
  if(transient(capabilities.status))return unavailable('无法连接评分服务')
  if(capabilities.status!==200||!capabilities.body.protocols?.includes(1))return {state:'upgrade',sent,profile:me.body,message:'服务器尚不支持当前离线评分协议，记录已保留'}
  for(const record of due){
    const operation=record.operation!
    const result=await request(`/tasks/${record.task.id}/score`,{score:operation.score,idempotency_key:operation.id,base_score_revision:operation.revision,offline_protocol:operation.protocol})
    if(result.status===401)return {state:'login',sent}
    if(transient(result.status)){
      await recordUploadFailure(record,result.status?`服务器暂不可用（${result.status}）`:'无法连接服务器',now())
      continue
    }
    if(result.status===200){
      if(result.body.accepted_operation?.id!==operation.id||result.body.accepted_operation.score!==operation.score){
        await blockReview(owner,record.task.id,operation.id,'评分回执与本地记录不一致，请核对')
        continue
      }
      await confirmReview(owner,record.task.id,operation.id,result.body as Row);sent++
    }else await blockReview(owner,record.task.id,operation.id,typeof result.body.detail==='string'?result.body.detail:`服务器拒绝评分（${result.status}），请核对任务`)
  }
  if(sent)await pruneConfirmedReviews(owner)
  return {state:'ready',sent,profile:me.body}
}

export function reviewTransport(token:string,alive:()=>boolean,onSessionEnded?:(reason:string,detail?:string)=>void):ReviewTransport{
  return async(path,body)=>{
    if(!alive())return {status:401,body:{}}
    const response=await fetch('/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(8000)})
    const data=await response.json().catch(()=>({}))
    if(response.status===401&&alive()){
      const reason=response.headers?.get?.('X-OMP-Session-Ended')
      if(reason)onSessionEnded?.(reason,typeof data?.detail==='string'?data.detail:undefined)
    }
    return alive()?{status:response.status,body:data}:{status:401,body:{}}
  }
}
