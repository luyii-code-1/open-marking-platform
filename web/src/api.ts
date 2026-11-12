import { useCallback, useEffect, useRef, useState } from 'react'

export type Row = Record<string, any> & { id: string }
export type User = { id: string; username: string; name: string; role: string }
export type Region = { page: number; x: number; y: number; width: number; height: number }
export type Question = { id: string; number: number; type: 'single' | 'multiple' | 'subjective'; options: number; answer: string[]; points: number; step?:number; regions: Region[]; rule: Record<string, unknown>; review_mode: 'single' | 'double'; threshold: number; choice_style?: 'bracket'; style?:string; lines?:number; cell_size?:number; content_html?:string; image_asset_id?:string; image_height?:number }
export type Template = { id: string; group_id: string; name: string; subtitle?:string; background_assets?:Record<string,string>; paper: 'A3' | 'A4'; sides: number; candidate_length: number; revision: number; status?: string; questions: Question[] }
let token = sessionStorage.getItem('omp-token') ?? ''
export function setToken(value: string) { token = value; value ? sessionStorage.setItem('omp-token', value) : sessionStorage.removeItem('omp-token') }
export const currentToken=()=>token
const resourceEvents=new EventTarget()
export function announceChanges(roots?:string[]){resourceEvents.dispatchEvent(new CustomEvent('change',{detail:roots}))}
export function watchChanges(callback:(roots?:string[])=>void){const handler=(event:Event)=>callback((event as CustomEvent<string[]|undefined>).detail);resourceEvents.addEventListener('change',handler);return()=>resourceEvents.removeEventListener('change',handler)}
export class ApiError extends Error { constructor(message: string, public status: number) { super(message) } }
export async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (token&&!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(`/api/v1${path}`, { ...init, headers })
  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: `请求失败（${response.status}）` }))
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
    throw new ApiError(detail || `请求失败（${response.status}）`, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}
export const send = <T = any>(path: string, value?: unknown, method = 'POST') => request<T>(path, { method, body: value === undefined ? undefined : JSON.stringify(value) })
export async function requestBlob(path:string,init:RequestInit={}):Promise<Blob> {
  const headers=new Headers(init.headers)
  if(token)headers.set('Authorization',`Bearer ${token}`)
  if(init.body&&!(init.body instanceof FormData))headers.set('Content-Type','application/json')
  const response=await fetch(`/api/v1${path}`,{...init,headers,cache:'no-store'})
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new ApiError(typeof data.detail==='string'?data.detail:`请求失败（${response.status}）`,response.status)}
  return response.blob()
}
export async function download(path: string, filename: string) {
  const response = await fetch(`/api/v1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
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
  const reload = useCallback(async () => {
    if (!path) return
    const sequence=++version.current
    setLoading(true); setError('')
    try { const next=await request<T>(path);if(sequence===version.current&&path===currentPath.current)setData(next) } catch (e) { if(sequence===version.current&&path===currentPath.current){setError(e instanceof Error ? e.message : '请求失败');if(e instanceof ApiError&&[401,403,404].includes(e.status))setData(initialData.current)} } finally { if(sequence===version.current&&path===currentPath.current){setLoading(false);setLoaded(true)} }
  }, [path])
  useEffect(() => { setLoaded(false);if(!path){setData(initialData.current);setLoading(false);setError('')}else void reload();return()=>{version.current++} }, [path,reload])
  useEffect(()=>watchChanges(roots=>{if(options.live!==false&&path&&(!roots||roots.includes(path.split('/')[1].split('?')[0])))void reload()}),[path,reload,options.live])
  return { data, loading, loaded, error, reload, setData }
}
export function newQuestion(number: number): Question { return { id: crypto.randomUUID(), number, type: 'subjective', options: 4, answer: [], points: 10, regions: [], rule: { mode: 'exact' }, review_mode: 'single', threshold: 2 } }
export const describeStatus = (status?: string) => ({ draft: '草稿', published: '已发布', active: '进行中', pending: '待处理', processed: '已处理', completed: '已完成', confirmed: '已确认', uploading: '上传中', paired: '已配对', frozen: '已冻结', error: '异常', open: '待处理', resolved: '已解决', scored: '已评分', claimed: '评阅中', ready: '待评阅', archived: '已归档' }[status || ''] || status || '—')
