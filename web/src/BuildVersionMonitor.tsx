import {useEffect} from 'react'
import {serverBuild,workerBuild} from './buildVersion'
import {canPreparePwaUpdate} from './pwaCoordinator'
import {settleReviewWrites} from './reviewStore'

export function BuildVersionMonitor(){
  useEffect(()=>{
    if(!import.meta.env.PROD)return
    let stopped=false,checking=false
    async function check(){
      if(checking||!navigator.onLine||document.visibilityState!=='visible')return
      checking=true
      try{
        const remote=await serverBuild(),current=document.querySelector('meta[name="omp-build"]')?.getAttribute('content')
        const controller=navigator.serviceWorker?.controller
        const controlled=controller?await workerBuild(controller).catch(()=>undefined):undefined
        if(stopped)return
        const matches=remote.shell_version===current&&(!controller||controlled===current)
        if(!matches){
          const registration=await navigator.serviceWorker?.getRegistration()
          await registration?.update()
          if(controlled===remote.shell_version&&current!==controlled&&canPreparePwaUpdate()){
            await settleReviewWrites()
            if(!stopped&&canPreparePwaUpdate())window.location.reload()
          }
        }
      }catch{/* Retry the version check after connectivity recovers. */}
      finally{checking=false}
    }
    void check()
    const timer=setInterval(check,60000)
    window.addEventListener('online',check);document.addEventListener('visibilitychange',check)
    return()=>{stopped=true;clearInterval(timer);window.removeEventListener('online',check);document.removeEventListener('visibilitychange',check)}
  },[])
  return null
}
