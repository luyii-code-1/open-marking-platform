import {useEffect,useState} from 'react'
import {serverBuild,workerBuild} from './buildVersion'
import {canPreparePwaUpdate} from './pwaCoordinator'
import {settleReviewWrites} from './reviewStore'

export function BuildVersionMonitor(){
  const [updating,setUpdating]=useState(false)
  useEffect(()=>{
    if(!import.meta.env.PROD)return
    let stopped=false,checking=false,checkedAt=0,pending=false
    async function check(){
      if(checking||!navigator.onLine||document.visibilityState!=='visible'||Date.now()-checkedAt<(pending?10000:60000))return
      checking=true
      try{
        const remote=await serverBuild(),current=document.querySelector('meta[name="omp-build"]')?.getAttribute('content')
        const controller=navigator.serviceWorker?.controller
        const controlled=controller?await workerBuild(controller).catch(()=>undefined):undefined
        if(stopped)return
        checkedAt=Date.now()
        const matches=remote.shell_version===current&&(!controller||controlled===current)
        pending=!matches
        if(matches||!navigator.onLine)setUpdating(false)
        if(!matches){
          if(canPreparePwaUpdate())setUpdating(true)
          const registration=await navigator.serviceWorker?.getRegistration()
          await registration?.update()
          const reloadKey='omp-refreshed-build:'+remote.shell_version
          if((controlled===remote.shell_version||!controller)&&current!==remote.shell_version&&canPreparePwaUpdate()&&!sessionStorage.getItem(reloadKey)){
            await settleReviewWrites()
            if(!stopped&&canPreparePwaUpdate()){sessionStorage.setItem(reloadKey,'1');window.location.reload()}
          }
        }
      }catch{setUpdating(false) /* Retry after connectivity recovers. */}
      finally{checking=false}
    }
    // Every application launch verifies the server build, including uncontrolled tabs.
    void check()
    const timer=setInterval(check,5000)
    const offline=()=>setUpdating(false)
    window.addEventListener('offline',offline)
    window.addEventListener('online',check);document.addEventListener('visibilitychange',check)
    return()=>{stopped=true;clearInterval(timer);window.removeEventListener('offline',offline);window.removeEventListener('online',check);document.removeEventListener('visibilitychange',check)}
  },[])
  return updating?<div role="status" style={{position:'fixed',inset:0,zIndex:10000,background:'rgba(255,255,255,.96)',display:'grid',placeItems:'center'}}>正在更新客户端，请稍候…</div>:null
}
