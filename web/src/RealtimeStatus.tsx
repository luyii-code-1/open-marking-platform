import { useEffect, useRef, useState } from 'react'
import { Tag } from 'antd'
import { announceChanges,currentToken,request,watchChanges,type User } from './api'

export function RealtimeStatus({user,onExpired,onProfile}:{user:User;onExpired:()=>void;onProfile:(user:User)=>void}) {
  const [state,setState]=useState<'connecting'|'connected'|'offline'|'retrying'>('connecting')
  const callbacks=useRef({onExpired,onProfile});callbacks.current={onExpired,onProfile}
  useEffect(()=>{
    let active=true
    const unwatch=watchChanges(roots=>{if(!roots||roots.includes('auth'))void request<User>('/auth/me').then(value=>{if(active&&currentToken())callbacks.current.onProfile(value)}).catch(()=>{})})
    return()=>{active=false;unwatch()}
  },[])
  useEffect(()=>{
    let stopped=false,socket:WebSocket|null=null,retryTimer:ReturnType<typeof setTimeout>|undefined,flushTimer:ReturnType<typeof setTimeout>|undefined,attempt=0,all=false
    const pending=new Set<string>()
    function flush(){flushTimer=undefined;if(stopped)return;announceChanges(all?undefined:[...pending]);pending.clear();all=false}
    function changed(roots?:string[]){if(!roots)all=true;else roots.forEach(root=>pending.add(root));if(!flushTimer)flushTimer=setTimeout(flush,250)}
    function connect(){
      if(stopped||!currentToken())return
      if(!navigator.onLine){setState('offline');return}
      setState(attempt?'retrying':'connecting')
      const target=new URL('/api/v1/events',location.href);target.protocol=location.protocol==='https:'?'wss:':'ws:'
      const active=new WebSocket(target.href);socket=active
      active.onopen=()=>{if(!stopped)active.send(JSON.stringify({type:'auth',token:currentToken()}))}
      active.onmessage=event=>{
        if(stopped||socket!==active)return
        let value:{type:string;roots?:string[]};try{value=JSON.parse(event.data)}catch{return}
        if(value.type==='ready'){attempt=0;setState('connected');changed()}
        else if(value.type==='invalidate')changed(value.roots)
        else if(value.type==='sync')changed()
        else if(value.type==='ping')active.send('{"type":"pong"}')
      }
      active.onclose=event=>{
        if(stopped||socket!==active)return
        socket=null
        if(event.code===4401){stopped=true;callbacks.current.onExpired();return}
        setState(navigator.onLine?'retrying':'offline')
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
  return <Tag role="status" color={state==='connected'?'green':state==='offline'?'orange':'default'}>{({connecting:'实时连接中',connected:'实时更新已连接',offline:'离线',retrying:'实时连接重试中'})[state]}</Tag>
}
