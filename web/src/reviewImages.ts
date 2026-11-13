import {request,requestBlob} from './api'
export type ReviewSheet={pages:{blob:Blob;width:number;height:number;key:string}[];regions:{page:number;rect:number[]|null}[]}
type Source={key:string;sha256?:string;direct_url?:string;proxy_url:string;width?:number;height?:number}
export type ImageManifest={pages:Source[];regions:ReviewSheet['regions']}
export async function validatePage(blob:Blob,source:Source){
  if(source.sha256){const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());const actual=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(actual!==source.sha256)throw new Error('题卡图片版本不一致')}
  const bitmap=await createImageBitmap(blob)
  try{if(source.width&&source.height&&(bitmap.width!==source.width||bitmap.height!==source.height))throw new Error('题卡图片尺寸不一致');return {blob,width:bitmap.width,height:bitmap.height,key:source.key}}
  finally{bitmap.close()}
}
export async function loadReviewSheet(taskId:string):Promise<ReviewSheet>{
  const manifest=await request<ImageManifest>(`/tasks/${taskId}/image-manifest`,{signal:AbortSignal.timeout(15000)})
  return downloadReviewSheet(manifest)
}
export async function downloadReviewSheet(manifest:ImageManifest):Promise<ReviewSheet>{
  const pages=[]
  for(const source of manifest.pages){
    let page:ReviewSheet['pages'][number]|undefined
    if(source.direct_url){try{const response=await fetch(source.direct_url,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('直连图片不可用');page=await validatePage(await response.blob(),source)}catch{/* A fresh authenticated proxy request handles CORS, expiry and provider failures. */}}
    if(!page)page=await validatePage(await requestBlob(source.proxy_url,{signal:AbortSignal.timeout(30000)}),source)
    pages.push(page)
  }
  for(const region of manifest.regions){const page=pages[region.page];if(!page)throw new Error('题目图片缺页');if(region.rect&&(region.rect.length!==4||region.rect.some(v=>!Number.isFinite(v))||region.rect[0]<0||region.rect[1]<0||region.rect[2]<=0||region.rect[3]<=0||region.rect[0]+region.rect[2]>page.width||region.rect[1]+region.rect[3]>page.height))throw new Error('题目区域超出题卡')}
  return {pages,regions:manifest.regions}
}
