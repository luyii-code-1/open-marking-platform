import { useEffect, useRef } from 'react'
import { ApiError,announceChanges,currentToken,request,updateSession,watchChanges,type AuthSession,type User } from './api'

export function RealtimeStatus({user,onExpired,onProfile}:{user:User;onExpired:()=>void;onProfile:(user:User)=>void}) {
  const callbacks=useRef({onExpired,onProfile});callbacks.current={onExpired,onProfile}
  useEffect(()=>{
    let active=true;const token=currentToken()
    const unwatch=watchChanges(roots=>{if(!roots||roots.includes('auth'))void request<User>('/auth/me').then(value=>{if(active&&currentToken()===token)callbacks.current.onProfile(value)}).catch(()=>{})})
    return()=>{active=false;unwatch()}
  },[])
  useEffect(()=>{
    let stopped=false,socket:WebSocket|null=null,retryTimer:ReturnType<typeof setTimeout>|undefined,flushTimer:ReturnType<typeof setTimeout>|undefined,attempt=0,all=false
    const pending=new Set<string>()
    function flush(){flushTimer=undefined;if(stopped)return;announceChanges(all?undefined:[...pending]);pending.clear();all=false}
    function changed(roots?:string[]){if(!roots)all=true;else roots.forEach(root=>pending.add(root));if(!flushTimer)flushTimer=setTimeout(flush,250)}
    function connect(){
      if(stopped||!currentToken())return
      if(!navigator.onLine){return}
      const target=new URL('/api/v1/events',location.href);target.protocol=location.protocol==='https:'?'wss:':'ws:'
      const signedToken=currentToken(),active=new WebSocket(target.href);socket=active
      active.onopen=()=>{if(!stopped)active.send(JSON.stringify({type:'auth',token:signedToken}))}
      active.onmessage=event=>{
        if(stopped||socket!==active)return
        let value:{type:string;roots?:string[]};try{value=JSON.parse(event.data)}catch{return}
        if(value.type==='ready'){attempt=0;changed()}
        else if(value.type==='invalidate')changed(value.roots)
        else if(value.type==='sync')changed()
        else if(value.type==='ping')active.send('{"type":"pong"}')
      }
      active.onclose=event=>{
        if(stopped||socket!==active)return
        socket=null
        if(event.code===4401){
          if(currentToken()!==signedToken)return
          void request<AuthSession>('/auth/session').then(value=>{
            if(!stopped&&currentToken()===signedToken){updateSession(signedToken,value);callbacks.current.onProfile(value.user);retryTimer=setTimeout(connect,1000)}
          }).catch(error=>{if(stopped||currentToken()&&currentToken()!==signedToken)return;if(error instanceof ApiError&&error.status===401){stopped=true;callbacks.current.onExpired()}else retryTimer=setTimeout(connect,5000)})
          return
        }
        const delay=Math.min(30000,1000*2**Math.min(attempt++,5))+Math.random()*500
        retryTimer=setTimeout(connect,delay)
      }
      active.onerror=()=>active.close()
    }
    function online(){if(retryTimer)clearTimeout(retryTimer);if(!socket||socket.readyState===WebSocket.CLOSED)connect()}
    function visibility(){if(document.visibilityState==='visible'){changed();online()}}
    window.addEventListener('online',online);document.addEventListener('visibilitychange',visibility);connect()
    return()=>{stopped=true;if(retryTimer)clearTimeout(retryTimer);if(flushTimer)clearTimeout(flushTimer);window.removeEventListener('online',online);document.removeEventListener('visibilitychange',visibility);socket?.close()}
  },[user.id])
  return null
}
