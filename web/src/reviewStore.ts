import type {ReviewSheet} from './reviewImages'
import {scoreInputError} from './reviewInteraction'
import type { Question, Row, User } from './api'

export type ReviewRecord = {
  key:string; owner:string; task:Row; template:{id:string;name:string;group_id:string;revision:number}; question:Question
  image:Blob; sheet?:ReviewSheet; draft:number|null; draftText?:string; status:'draft'|'queued'|'failed'|'conflict'|'confirmed'; updatedAt:number
  failures?:number; retryAt?:number
  operation?:{id:string;score:number;revision:number;protocol:1}; error?:string
}
export const REVIEW_DB='omp-review'
export const REVIEW_RETRY_DELAYS=[1000,3000,9000] as const
let connection:Promise<IDBDatabase>|undefined
let updateLocked=false
const writeErrors=new Map<string,unknown>()
const writes=new Set<Promise<unknown>>(),events=new EventTarget()
let channel:BroadcastChannel|undefined
function changed(){events.dispatchEvent(new Event('change'));channel?.postMessage('change')}
export function watchReviewChanges(callback:()=>void){
  if(!channel&&typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel('omp-review');channel.onmessage=()=>events.dispatchEvent(new Event('change'))}
  events.addEventListener('change',callback);return()=>events.removeEventListener('change',callback)
}
export const isReviewUpdateLocked=()=>updateLocked
export function lockReviewUpdate(value:boolean){updateLocked=value;events.dispatchEvent(new Event('change'))}
export async function settleReviewWrites(){
  while(writes.size)await Promise.allSettled([...writes])
  if(writeErrors.size)throw writeErrors.values().next().value
}
function tracked<T>(work:Promise<T>,key:string){
  writes.add(work)
  void work.then(()=>{writeErrors.delete(key);changed()},error=>{writeErrors.set(key,error);changed()}).finally(()=>writes.delete(work))
  return work
}
function open():Promise<IDBDatabase>{
  if(!connection)connection=new Promise((resolve,reject)=>{
    const request=indexedDB.open(REVIEW_DB,1)
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('work'))db.createObjectStore('work',{keyPath:'key'});if(!db.objectStoreNames.contains('accounts'))db.createObjectStore('accounts',{keyPath:'id'})}
    request.onerror=()=>{connection=undefined;reject(request.error||new Error('本地阅卷存储不可用'))}
    request.onblocked=()=>{connection=undefined;reject(new Error('请关闭其他阅卷窗口后重试本地存储升级'))}
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=undefined};resolve(db)}
  })
  return connection
}
const recordKey=(owner:string,task:string)=>owner+':'+task
async function read<T>(store:string,key:IDBValidKey):Promise<T|undefined>{
  const db=await open()
  return new Promise((resolve,reject)=>{const tx=db.transaction(store),request=tx.objectStore(store).get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
}
async function mutate<T>(key:string,update:(value:ReviewRecord|undefined)=>{value?:ReviewRecord;result:T}):Promise<T>{
  const db=await open()
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('work','readwrite'),store=tx.objectStore('work'),request=store.get(key);let result:T,error:unknown
    request.onsuccess=()=>{try{const next=update(request.result);result=next.result;if(next.value)store.put(next.value);else store.delete(key)}catch(e){error=e;tx.abort()}}
    tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(error||tx.error||new Error('本地保存失败'))
  })
}
export async function rememberReviewUser(user:User){
  const db=await open()
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('accounts','readwrite');tx.objectStore('accounts').put({id:user.id,name:user.name,username:user.username,role:user.role});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})
  sessionStorage.setItem('omp-review-user',user.id)
}
export const cachedReviewUser=(id:string)=>read<User>('accounts',id)
export const getReview=(owner:string,task:string)=>read<ReviewRecord>('work',recordKey(owner,task))
export async function listReviews(owner:string):Promise<ReviewRecord[]>{
  const db=await open()
  const prefix=recordKey(owner,'')
  return new Promise((resolve,reject)=>{const request=db.transaction('work').objectStore('work').getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));request.onsuccess=()=>resolve((request.result as ReviewRecord[]).sort((a,b)=>b.updatedAt-a.updatedAt));request.onerror=()=>reject(request.error)})
}
export function cacheReview(owner:string,task:Row,template:ReviewRecord['template'],question:Question,image:Blob,sheet?:ReviewSheet){
  if(updateLocked)return Promise.reject(new Error('页面正在准备更新'))
  return tracked(mutate(recordKey(owner,task.id),old=>{
    if(old&&(old.status!=='confirmed'||task.status==='claimed'&&old.task.status==='completed'))return {value:old,result:old}
    const value:ReviewRecord={key:recordKey(owner,task.id),owner,task,template,question,image,sheet,draft:task.regrading||task.status==='completed'?task.score:null,status:'draft',updatedAt:Date.now()}
    return {value,result:value}
  }),recordKey(owner,task.id))
}
export function saveReviewDraft(owner:string,task:string,score:number|null,text?:string){
  if(updateLocked)return Promise.reject(new Error('页面正在准备更新'))
  return tracked(mutate(recordKey(owner,task),old=>{
    if(!old)throw new Error('请先缓存当前作答')
    if(old.status!=='draft')throw new Error('这份评分已进入待传或核对状态')
    const value={...old,draft:score,draftText:text,updatedAt:Date.now()};return {value,result:value}
  }),recordKey(owner,task))
}
export function enqueueReview(owner:string,task:string,score:number){
  if(updateLocked)return Promise.reject(new Error('页面正在准备更新'))
  return tracked(mutate(recordKey(owner,task),old=>{
    if(!old)throw new Error('请先缓存当前作答')
    if(old.operation){if(old.operation.score!==score)throw new Error('请先处理这份待传评分');return {value:old,result:old}}
    if(old.status!=='draft')throw new Error('请重新领取或打开历史评分')
    const issue=scoreInputError(String(score),old.question.points,old.question.step)
    if(issue)throw new Error(issue)
    const value:ReviewRecord={...old,draft:score,draftText:undefined,status:'queued',operation:{id:crypto.randomUUID(),score,revision:old.task.score_revision??0,protocol:1},error:undefined,updatedAt:Date.now()}
    return {value,result:value}
  }),recordKey(owner,task))
}
export function confirmReview(owner:string,task:string,operationId:string,result:Row){
  return tracked(mutate(recordKey(owner,task),old=>{
    if(!old||old.operation?.id!==operationId)return {value:old,result:old}
    const value:ReviewRecord={...old,task:result,draft:result.score,status:'confirmed',operation:undefined,error:undefined,failures:undefined,retryAt:undefined,updatedAt:Date.now()}
    return {value,result:value}
  }),recordKey(owner,task))
}
export function blockReview(owner:string,task:string,operationId:string,error:string){
  return tracked(mutate(recordKey(owner,task),old=>{
    if(!old||old.operation?.id!==operationId)return {value:old,result:old}
    const value:ReviewRecord={...old,status:'conflict',retryAt:undefined,error};return {value,result:value}
  }),recordKey(owner,task))
}
export function recordUploadFailure(record:ReviewRecord,reason:string,now:number){
  return tracked(mutate(record.key,old=>{
    if(!old||old.status!=='queued'||old.operation?.id!==record.operation?.id||
      (old.failures??0)!==(record.failures??0))return {value:old,result:undefined}
    const failures=(old.failures??0)+1,delay=REVIEW_RETRY_DELAYS[failures-1]
    const value:ReviewRecord={...old,failures,status:delay===undefined?'failed':'queued',
      retryAt:delay===undefined?undefined:now+delay,error:delay===undefined?reason:undefined}
    return {value,result:undefined}
  }),record.key)
}
export function retryFailedReview(record:ReviewRecord){
  return tracked(mutate(record.key,old=>{
    if(!old||old.status!=='failed'||old.operation?.id!==record.operation?.id)return {value:old,result:undefined}
    return {value:{...old,status:'queued',failures:0,retryAt:undefined,error:undefined},result:undefined}
  }),record.key)
}
export function hasUnsentReview(record:ReviewRecord){
  return !!record.operation || (record.status==='draft' && (record.draftText!==undefined
    ? record.draftText!==String(record.task.score??'') : record.draft!==null && record.draft!==record.task.score))
}
export function forgetReview(owner:string,task:string){return tracked(mutate(recordKey(owner,task),()=>({result:undefined})),recordKey(owner,task))}
export async function pruneConfirmedReviews(owner:string){
  const records=await listReviews(owner)
  for(const record of records.filter(r=>r.status==='confirmed').slice(1)){
    await tracked(mutate(record.key,old=>({value:old?.status==='confirmed'&&old.updatedAt===record.updatedAt?undefined:old,result:undefined})),record.key)
  }
}
