import {useEffect,useState} from 'react'
import {serverBuild,workerBuild} from './buildVersion'
import {canPreparePwaUpdate} from './pwaCoordinator'
import {settleReviewWrites} from './reviewStore'
import './buildFooter.css'

export function BuildFooter({checkUpdates=true}:{checkUpdates?:boolean}){
  const [status,setStatus]=useState('')
  useEffect(()=>{
    if(!import.meta.env.PROD||!checkUpdates)return
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
        setStatus(matches?'已是最新版本':'有更新，空闲时自动刷新')
        if(!matches){
          const registration=await navigator.serviceWorker?.getRegistration()
          await registration?.update()
          if(controlled===remote.shell_version&&current!==controlled&&canPreparePwaUpdate()){
            await settleReviewWrites()
            if(!stopped&&canPreparePwaUpdate())window.location.reload()
          }
        }
      }catch{if(!stopped)setStatus(navigator.onLine?'版本核对暂不可用':'离线')}
      finally{checking=false}
    }
    void check()
    const timer=setInterval(check,60000)
    window.addEventListener('online',check);document.addEventListener('visibilitychange',check)
    return()=>{stopped=true;clearInterval(timer);window.removeEventListener('online',check);document.removeEventListener('visibilitychange',check)}
  },[checkUpdates])
  return <footer className="build-footer" aria-label="应用版本"><img src="/branding/omp-mark.svg" alt="OMP" width={30} height={14}/><span>{__OMP_BUILD__.commit}</span><span>{__OMP_BUILD__.build_number} 版</span>{status&&<span role="status">{status}</span>}</footer>
}
