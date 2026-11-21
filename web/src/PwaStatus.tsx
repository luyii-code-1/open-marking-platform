import { useEffect, type ReactNode } from 'react'
import { canPreparePwaUpdate, reportPwaReady } from './pwaCoordinator'
import { automaticPwaUpdates } from './updatePolicy'
import {verifyWaitingBuild} from './buildVersion'
import {BuildVersionMonitor} from './BuildVersionMonitor'

export function PwaRuntime({children}:{children:ReactNode}){
  useEffect(()=>{
    const suppressInstallPrompt=(event:Event)=>event.preventDefault()
    window.addEventListener('beforeinstallprompt',suppressInstallPrompt)
    let updates:ReturnType<typeof automaticPwaUpdates>|undefined
    const start=()=>{updates=automaticPwaUpdates({
      register:()=>navigator.serviceWorker.register('/worker.js',{updateViaCache:'none'}),
      ready:canPreparePwaUpdate,onReady:reportPwaReady,visible:()=>document.visibilityState==='visible',online:()=>navigator.onLine,
      verify:verifyWaitingBuild,
    })}
    let cancelStart=()=>{}
    if(import.meta.env.PROD&&'serviceWorker' in navigator&&window.isSecureContext){
      if(typeof window.requestIdleCallback==='function'){
        const id=window.requestIdleCallback(start,{timeout:1500});cancelStart=()=>window.cancelIdleCallback(id)
      }else{const id=setTimeout(start,0);cancelStart=()=>clearTimeout(id)}
    }
    const resume=()=>updates?.tick()
    window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume)
    return()=>{cancelStart();updates?.stop();window.removeEventListener('beforeinstallprompt',suppressInstallPrompt);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume)}
  },[])
  return <>{children}<BuildVersionMonitor/></>
}
