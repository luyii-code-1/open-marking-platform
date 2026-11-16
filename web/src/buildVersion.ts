export type BuildMetadata={commit:string;built_at:string;build_number:string;shell_version:string}

export async function serverBuild():Promise<BuildMetadata>{
  const response=await fetch('/api/v1/system/build',{cache:'no-store',signal:AbortSignal.timeout(8000)})
  if(!response.ok)throw new Error('版本信息暂不可用')
  const value:BuildMetadata=await response.json()
  if(!/^[a-f0-9]{16}$/.test(value.shell_version))throw new Error('版本信息暂不可用')
  return value
}

export function workerBuild(worker:ServiceWorker):Promise<string>{
  return new Promise((resolve,reject)=>{
    const channel=new MessageChannel()
    const timer=setTimeout(()=>{channel.port1.close();reject(new Error('正在核对缓存版本'))},2500)
    channel.port1.onmessage=event=>{
      clearTimeout(timer);channel.port1.close()
      if(event.data?.type==='BUILD_VERSION'&&/^[a-f0-9]{16}$/.test(event.data.version))resolve(event.data.version)
      else reject(new Error('缓存版本暂不可用'))
    }
    try{worker.postMessage({type:'GET_BUILD_VERSION'},[channel.port2])}
    catch(error){clearTimeout(timer);channel.port1.close();reject(error)}
  })
}

export async function verifyWaitingBuild(worker:ServiceWorker){
  try{
    const [remote,version]=await Promise.all([serverBuild(),workerBuild(worker)])
    return remote.shell_version===version
  }catch{return false}
}
