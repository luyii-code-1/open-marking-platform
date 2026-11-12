import { useEffect, type ReactNode } from 'react'
import { canPreparePwaUpdate, reportPwaReady } from './pwaCoordinator'
import { automaticPwaUpdates } from './updatePolicy'

export function PwaRuntime({children}:{children:ReactNode}){
  useEffect(()=>{
    const suppressInstallPrompt=(event:Event)=>event.preventDefault()
    window.addEventListener('beforeinstallprompt',suppressInstallPrompt)
    const updates=import.meta.env.PROD&&'serviceWorker' in navigator&&window.isSecureContext?automaticPwaUpdates({
      register:()=>navigator.serviceWorker.register('/worker.js',{updateViaCache:'none'}),
      ready:canPreparePwaUpdate,onReady:reportPwaReady,visible:()=>document.visibilityState==='visible',online:()=>navigator.onLine,
    }):undefined
    const resume=()=>updates?.tick()
    window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume)
    return()=>{updates?.stop();window.removeEventListener('beforeinstallprompt',suppressInstallPrompt);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume)}
  },[])
  return children
}
