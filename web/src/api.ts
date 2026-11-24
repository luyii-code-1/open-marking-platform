import {resilientFetch} from './networkPolicy'
import { useCallback, useEffect, useRef, useState } from 'react'
import { beginMutation, hasPendingMutations, watchMutations } from './updatePolicy'
import { ResourceReads } from './resourceReads'
import { SharedSession,sessionKey,type SessionLease } from './sharedSession'

export type Row = Record<string, any> & { id: string }
export type User = { id: string; username: string; name: string; role: string }
export type Region = { page: number; x: number; y: number; width: number; height: number; part_number?:number;min_height?:number;anchor_page?:number;anchor_x?:number;anchor_y?:number }
export type ImageBox = { x: number; y: number; width: number; height: number }
export type ExternalMode = 'blank' | 'completed'
export const templateCreationOptions = [
  { value: 'native', label: '系统制卡' },
  { value: 'blank', label: '已有题卡兼容制版' },
  { value: 'completed', label: '已完成答卷兼容扫描' },
]
export type ExternalAnchor = ImageBox & { pattern: string }
export type ExternalPage = { anchors: ExternalAnchor[]; candidate?: ImageBox[][]; absent?: ImageBox }
export type ExternalSheet = { version: 1; mode: ExternalMode; pages: Record<string, ExternalPage> }
export type PrintNote = Region & { id:string; html:string }
export type QuestionPart = Pick<Question,'number'|'points'|'style'|'lines'|'cell_size'|'content_html'|'image_asset_id'|'image_height'|'image_box'|'review_layout'|'review_frames'>
export type Question = { id: string; number: number; parts?:QuestionPart[]; type: 'single' | 'multiple' | 'subjective'; options: number; answer: string[]; points: number; step?:number; regions: Region[]; rule: Record<string, unknown>; review_mode: 'single' | 'double'; review_layout?: 'stack' | 'paper'; review_frames?: Region[]; threshold: number; threshold_inclusive?:boolean; choice_group?:string; choice_style?: 'bracket' | 'compact'; style?:string; lines?:number; cell_size?:number; content_html?:string; image_asset_id?:string; image_height?:number; image_box?:ImageBox; external_options?:ImageBox[] }
export type Template = { id: string; group_id: string; name: string; subtitle?:string; font_size?:number; leading?:number; background_assets?:Record<string,string>; background_boxes?:Record<string,ImageBox>; paper: 'A3' | 'A4'; sheet_columns?:number; layout_version?:number; notice_template?:'standard-v1'|'none'; notice_layout?:number; print_style?:'standard-v2'; column_frame?:boolean; uniform_subjective?:boolean;auto_subjective_layout?:boolean; print_notes?:PrintNote[]; forbidden_regions?:Region[]; sides: number; candidate_length: number; revision: number; draft_version?:number; status?: string; questions: Question[]; external_sheet?:ExternalSheet }
const session=new SharedSession(localStorage,sessionStorage)
window.addEventListener('storage',event=>{if(event.key===sessionKey||event.key===null)session.refresh()})
export function setToken(value:string,lease?:SessionLease){if(value)session.login(value,lease);else session.clear()}
export const currentToken=()=>session.token()
export const currentSession=()=>session.snapshot()
export const watchSession=(listener:Parameters<SharedSession['subscribe']>[0])=>session.subscribe(listener)
export const updateSession=(token:string,lease:SessionLease)=>session.update(token,lease)
export const clearSession=(expected?:string)=>session.clear(expected)
export type AuthSession=SessionLease&{user:User;token?:string}
function expired(response:Response,path:string,authorization:string|null){
  const publicAuth=path==='/auth/login'||path==='/auth/bootstrap'||path==='/auth/recovery-reset'||path.startsWith('/auth/passkeys/login/')
  if(response.status===401&&!publicAuth&&authorization?.startsWith('Bearer '))session.clear(authorization.slice(7))
}
const resourceEvents=new EventTarget()
const resourceReads = new ResourceReads()
watchMutations(() => resourceReads.invalidate())
export function announceChanges(roots?:string[]){resourceReads.invalidate();resourceEvents.dispatchEvent(new CustomEvent('change',{detail:roots}))}
export function watchChanges(callback:(roots?:string[])=>void){const handler=(event:Event)=>callback((event as CustomEvent<string[]|undefined>).detail);resourceEvents.addEventListener('change',handler);return()=>resourceEvents.removeEventListener('change',handler)}
export class ApiError extends Error { constructor(message: string, public status: number) { super(message) } }
export async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const finish=beginMutation(init.method)
  try{
    const headers = new Headers(init.headers)
    const token=currentToken()
    if (token&&!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    const response = await resilientFetch(`/api/v1${path}`, { ...init, headers })
    expired(response,path,headers.get('Authorization'))
    if (!response.ok) {
      const data = await response.json().catch(() => ({ detail: `请求失败（${response.status}）` }))
      const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
      throw new ApiError(detail || `请求失败（${response.status}）`, response.status)
    }
    if (response.status === 204) return undefined as T
    return await response.json()
  }finally{finish()}
}
export const send = <T = any>(path: string, value?: unknown, method = 'POST') => request<T>(path, { method, body: value === undefined ? undefined : JSON.stringify(value) })
export async function requestBlob(path:string,init:RequestInit={}):Promise<Blob> {
  const finish=beginMutation(init.method)
  try{
    const headers=new Headers(init.headers)
    const token=currentToken()
    if(token&&!headers.has('Authorization'))headers.set('Authorization',`Bearer ${token}`)
    if(init.body&&!(init.body instanceof FormData))headers.set('Content-Type','application/json')
    const response=await resilientFetch(`/api/v1${path}`,{...init,headers,cache:'no-store'})
    expired(response,path,headers.get('Authorization'))
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new ApiError(typeof data.detail==='string'?data.detail:`请求失败（${response.status}）`,response.status)}
    return await response.blob()
  }finally{finish()}
}
export async function download(path: string, filename: string) {
  const token=currentToken()
  const response = await resilientFetch(`/api/v1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  expired(response,path,token?'Bearer '+token:null)
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.detail || `下载失败（${response.status}）`) }
  const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export async function downloadArchive(identifier:string,filename:string) {
  const result=await send<{url:string}>(`/archives/${identifier}/download-link`)
  const link=document.createElement('a');link.href=result.url;link.download=filename;link.rel='noreferrer';link.click()
}
export function useResource<T>(path: string | null, initial: T, options:{live?:boolean}={}) {
  const [data, setData] = useState<T>(initial), [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState('')
  const version=useRef(0),currentPath=useRef(path),initialData=useRef(initial);currentPath.current=path
  const load = useCallback(async (refresh: boolean) => {
    if (!path) return
    const sequence=++version.current
    const owner=currentToken()
    const active=()=>sequence===version.current&&path===currentPath.current&&currentToken()===owner
    setLoading(true); setError('')
    try {
      const fetchData=()=>request<T>(path)
      const next=await (hasPendingMutations()?fetchData():resourceReads.read(owner,path,fetchData,refresh))
      if(active())setData(next)
    } catch(e) {
      if(active()){setError(e instanceof Error?e.message:'请求失败');if(e instanceof ApiError&&[401,403,404].includes(e.status))setData(initialData.current)}
    } finally {if(active()){setLoading(false);setLoaded(true)}}
  }, [path])
  const reload=useCallback(()=>load(true),[load])
  useEffect(() => { setLoaded(false);if(!path){setData(initialData.current);setLoading(false);setError('')}else void load(false);return()=>{version.current++} }, [path,load])
  useEffect(()=>watchChanges(roots=>{if(options.live!==false&&path&&(!roots||roots.includes(path.split('/')[1].split('?')[0])))void load(false)}),[path,load,options.live])
  return { data, loading, loaded, error, reload, setData }
}
export function newQuestion(number: number): Question { return { id: crypto.randomUUID(), number, type: 'subjective', options: 4, answer: [], points: 10, regions: [], rule: { mode: 'exact' }, review_mode: 'single', threshold: 2, threshold_inclusive:false } }
export const describeStatus = (status?: string) => ({ draft: '草稿', published: '已发布', active: '进行中', pending: '待处理', processed: '已处理', completed: '已完成', confirmed: '已确认', uploading: '上传中', paired: '已配对', frozen: '已冻结', error: '异常', open: '待处理', resolved: '已解决', scored: '已评分', claimed: '评阅中', ready: '待评阅', archived: '已归档' }[status || ''] || status || '—')
