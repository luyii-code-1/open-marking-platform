import { useEffect } from 'react'
import { ApiError,clearSession,currentSession,currentToken,request,updateSession,watchSession,type AuthSession } from './api'
import { UserActivity } from './sharedSession'

export function SessionActivity({token}:{token:string}){
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,checking=false
    const activity=new UserActivity(async idle_ms=>{
      if(stopped||currentToken()!==token||!navigator.onLine)return
      const lease=await request<AuthSession>('/auth/activity',{method:'POST',body:JSON.stringify({idle_ms}),keepalive:true})
      if(!stopped)updateSession(token,lease)
    })
    async function verifyExpiry(){
      if(stopped||checking||currentToken()!==token)return
      checking=true
      try{
        const lease=await request<AuthSession>('/auth/session',{signal:AbortSignal.timeout(8000)})
        if(!stopped)updateSession(token,lease)
      }catch(error){
        if(!stopped&&currentToken()===token&&(error instanceof ApiError&&error.status===401||!navigator.onLine))clearSession(token)
        else if(!stopped)timer=setTimeout(verifyExpiry,5000)
      }finally{checking=false}
    }
    function schedule(){
      if(timer)clearTimeout(timer)
      if(stopped||currentToken()!==token)return
      const deadline=currentSession()?.deadline
      if(deadline!==undefined)timer=setTimeout(verifyExpiry,Math.max(0,deadline-Date.now()))
    }
    function interact(event:Event){if(currentToken()===token)activity.interact(event.isTrusted)}
    function visible(){if(document.visibilityState==='visible')schedule()}
    function leaving(){activity.flushPending()}
    const events=['pointerdown','pointerup','keydown','input','change','click','wheel','touchend']
    for(const name of events)document.addEventListener(name,interact,{capture:true,passive:true})
    document.addEventListener('visibilitychange',visible)
    window.addEventListener('pagehide',leaving)
    const unwatch=watchSession(schedule);schedule()
    return()=>{stopped=true;activity.stop();if(timer)clearTimeout(timer);unwatch();window.removeEventListener('pagehide',leaving);document.removeEventListener('visibilitychange',visible);for(const name of events)document.removeEventListener(name,interact,true)}
  },[token])
  return null
}
