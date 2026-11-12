import { blockReview, confirmReview, listReviews, pruneConfirmedReviews } from './reviewStore'
import type { Row, User } from './api'

export type SyncResponse={status:number;body:any}
export type ReviewTransport=(path:string,body?:unknown)=>Promise<SyncResponse>
export type SyncReport={state:'ready'|'offline'|'login'|'upgrade';sent:number;message?:string;profile?:User}

export async function syncReviewRecords(owner:string,transport:ReviewTransport):Promise<SyncReport>{
  let sent=0
  try{
    const me=await transport('/auth/me')
    if(me.status===401||me.status===403)return {state:'login',sent}
    if(me.status!==200)return {state:'offline',sent}
    if(me.body.id!==owner)return {state:'login',sent,message:'请使用保存这些评分的账号登录'}
    const capabilities=await transport('/review/offline-capabilities')
    if(capabilities.status===401||capabilities.status===403)return {state:'login',sent}
    if(capabilities.status>=500)return {state:'offline',sent}
    if(capabilities.status!==200||!capabilities.body.protocols?.includes(1))return {state:'upgrade',sent,profile:me.body,message:'服务器尚不支持当前离线评分协议，记录已保留'}
    for(const record of (await listReviews(owner)).filter(r=>r.status==='queued'&&r.operation)){
      const operation=record.operation!
      const result=await transport(`/tasks/${record.task.id}/score`,{score:operation.score,idempotency_key:operation.id,base_score_revision:operation.revision,offline_protocol:operation.protocol})
      if(result.status===401)return {state:'login',sent}
      if(result.status>=500||[408,425,429].includes(result.status))return {state:'offline',sent}
      if(result.status===200){
        if(result.body.accepted_operation?.id!==operation.id||result.body.accepted_operation.score!==operation.score)return {state:'upgrade',sent,message:'服务器未返回对应评分回执，记录已保留'}
        await confirmReview(owner,record.task.id,operation.id,result.body as Row);sent++
      }else await blockReview(owner,record.task.id,operation.id,typeof result.body.detail==='string'?result.body.detail:`服务器拒绝评分（${result.status}），请核对任务`)
    }
    await pruneConfirmedReviews(owner)
    return {state:'ready',sent,profile:me.body}
  }catch{return {state:'offline',sent}}
}

export function reviewTransport(token:string,alive:()=>boolean):ReviewTransport{
  return async(path,body)=>{
    if(!alive())throw new Error('评分会话已切换')
    const response=await fetch('/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(8000)})
    return {status:response.status,body:await response.json().catch(()=>({}))}
  }
}
