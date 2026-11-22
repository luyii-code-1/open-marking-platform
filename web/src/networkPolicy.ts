let slow=false
export function setServiceSlow(value:boolean){slow=value}
export const serviceIsSlow=()=>slow
const pause=(ms:number,signal?:AbortSignal|null)=>new Promise<void>((resolve,reject)=>{
  const stop=()=>{clearTimeout(timer);reject(signal?.reason||new DOMException('请求已取消','AbortError'))}
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve()},ms)
  if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true})
})
export async function resilientFetch(url:string,init:RequestInit={}){
  const read=['GET','HEAD'].includes((init.method||'GET').toUpperCase())
  if(!read)return fetch(url,init)
  for(let attempt=0;;attempt++){
    let response:Response
    try{response=await fetch(url,{...init,signal:init.signal||AbortSignal.timeout(slow?60000:30000)})}
    catch(error){if(attempt>=2||init.signal?.aborted)throw error;await pause(1000*2**attempt+Math.random()*500,init.signal);continue}
    if(attempt>=2||![429,502,503,504].includes(response.status))return response
    const retry=response.headers.get('Retry-After'),seconds=Number(retry)
    const delay=retry?(Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now()):1000*2**attempt
    if(delay>30000)return response
    await response.body?.cancel()
    await pause(Math.max(500,delay)+Math.random()*500,init.signal)
  }
}
