type Activity = { now:number; lastActivity:number; editing:boolean; mutating:boolean; dirty:boolean }

export function canAutomaticallyUpdate(value:Activity){
  return !value.editing&&!value.mutating&&!value.dirty&&value.now-value.lastActivity>=15000
}

let mutations=0
const mutationEvents=new EventTarget()
export function watchMutations(callback:()=>void){mutationEvents.addEventListener('start',callback);return()=>mutationEvents.removeEventListener('start',callback)}
export const hasPendingMutations=()=>mutations>0
export function beginMutation(method='GET'){
  if(['GET','HEAD','OPTIONS'].includes(method.toUpperCase()))return ()=>{}
  mutations++
  mutationEvents.dispatchEvent(new Event('start'))
  let finished=false
  return ()=>{if(!finished){finished=true;mutations--}}
}

// Register and check again after network failures; activation uses the multi-window handshake.
export function automaticPwaUpdates(options:{
  register:()=>Promise<ServiceWorkerRegistration>; ready:()=>boolean; onReady:()=>void
  visible:()=>boolean; online:()=>boolean; now?:()=>number
}){
  const now=options.now??Date.now
  let stopped=false,registration:ServiceWorkerRegistration|undefined,registering=false,checking=false,lastAttempt=-Infinity,lastCheck=-Infinity
  const observed=new Map<ServiceWorker,()=>void>()
  function watch(worker:ServiceWorker|null){
    if(!worker||observed.has(worker))return
    const changed=()=>{if(worker.state==='installed')tick()}
    observed.set(worker,changed);worker.addEventListener('statechange',changed)
  }
  function found(){watch(registration?.installing??null)}
  async function connect(){
    if(stopped||registering||registration||!options.online())return
    registering=true
    try{
      const value=await options.register()
      if(stopped)return
      registration=value;value.addEventListener('updatefound',found);watch(value.installing)
      options.onReady();tick()
    }catch{/* Network recovery is retried in the background. */}
    finally{registering=false}
  }
  function tick(){
    if(stopped)return
    if(!registration){void connect();return}
    if(!checking&&options.online()&&now()-lastCheck>=300000){
      checking=true;lastCheck=now()
      void registration.update().catch(()=>{lastCheck=now()-270000}).finally(()=>{checking=false})
    }
    if(registration.waiting&&options.visible()&&options.ready()&&now()-lastAttempt>=30000){
      lastAttempt=now();registration.waiting.postMessage({type:'PREPARE_UPDATE'})
    }
  }
  const timer=setInterval(tick,5000)
  void connect()
  return {tick,stop(){stopped=true;clearInterval(timer);registration?.removeEventListener('updatefound',found);for(const [worker,changed] of observed)worker.removeEventListener('statechange',changed)}}
}
