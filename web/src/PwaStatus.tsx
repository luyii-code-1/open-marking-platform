import { Button } from './Button'
import { useEffect, useRef, useState } from 'react'
import { App, Modal, Space, Tag } from 'antd'
import { settleReviewWrites } from './reviewStore'
import { hasUnsavedChanges } from './useNavigation'
import { reportPwaReady } from './pwaCoordinator'

interface InstallPrompt extends Event {
  prompt():Promise<void>
  userChoice:Promise<{outcome:'accepted'|'dismissed'}>
}

export function PwaStatus() {
  const [prompt,setPrompt]=useState<InstallPrompt|null>(null),[waiting,setWaiting]=useState<ServiceWorker|null>(null),[offline,setOffline]=useState(!navigator.onLine),[installed,setInstalled]=useState(matchMedia('(display-mode: standalone)').matches||Boolean((navigator as Navigator&{standalone?:boolean}).standalone)),[error,setError]=useState(false)
  const registration=useRef<ServiceWorkerRegistration|null>(null),{message}=App.useApp()
  function observe(value:ServiceWorkerRegistration){
    registration.current=value;setError(false);setWaiting(value.waiting)
    value.onupdatefound=()=>{const worker=value.installing;if(worker)worker.onstatechange=()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)setWaiting(value.waiting||worker)}}
  }
  useEffect(()=>{
    const capture=(event:Event)=>{event.preventDefault();setPrompt(event as InstallPrompt)}
    const didInstall=()=>{setInstalled(true);setPrompt(null)}
    const online=()=>{setOffline(false);void registration.current?.update().catch(()=>setError(true))},offline=()=>setOffline(true)
    const aborted=()=>message.warning('其他窗口尚有未保存操作，或本地保存未完成；请处理后重试更新')
    window.addEventListener('omp-update-aborted',aborted)
    window.addEventListener('beforeinstallprompt',capture);window.addEventListener('appinstalled',didInstall);window.addEventListener('online',online);window.addEventListener('offline',offline)
    let active=true
    if(import.meta.env.PROD&&'serviceWorker' in navigator&&window.isSecureContext){
      void navigator.serviceWorker.register('/worker.js',{updateViaCache:'none'}).then(value=>{
        if(!active)return
        observe(value)
        reportPwaReady()
      }).catch(()=>{if(active)setError(true)})
    }
    const timer=setInterval(()=>{if(navigator.onLine)void registration.current?.update().catch(()=>setError(true))},600000)
    return()=>{active=false;clearInterval(timer);if(registration.current){registration.current.onupdatefound=null;if(registration.current.installing)registration.current.installing.onstatechange=null}window.removeEventListener('beforeinstallprompt',capture);window.removeEventListener('appinstalled',didInstall);window.removeEventListener('online',online);window.removeEventListener('offline',offline);window.removeEventListener('omp-update-aborted',aborted)}
  },[])
  async function install(){
    if(!prompt){Modal.info({title:'安装阅卷平台',content:'在浏览器菜单中选择“安装应用”或“添加到主屏幕”。请使用HTTPS访问，或在本机打开。'});return}
    try{await prompt.prompt();if((await prompt.userChoice).outcome==='accepted')setInstalled(true);setPrompt(null)}catch{message.error('未能打开安装入口，可使用浏览器菜单安装')}
  }
  function update(){Modal.confirm({title:'更新阅卷平台',content:'当前阅卷草稿及待传评分会保存在本机。各窗口准备完成后，统一重新载入新版本。',onOk:async()=>{if(hasUnsavedChanges()){message.warning('请先保存当前页面的修改');throw new Error('存在未保存修改')}await settleReviewWrites();waiting?.postMessage({type:'PREPARE_UPDATE'})}})}
  async function retry(){try{if(registration.current)await registration.current.update();else observe(await navigator.serviceWorker.register('/worker.js',{updateViaCache:'none'}));setError(false)}catch{message.error('暂时无法检查更新，请联网后重试')}}
  return <Space wrap className="pwa-actions">{!installed&&<Button size="small" onClick={install}>安装应用</Button>}{waiting&&<Button size="small" type="primary" onClick={update}>更新可用</Button>}{error&&<Button size="small" onClick={retry}>重试应用更新</Button>}{offline&&<Tag color="orange">离线 · 阅卷结果保存在本机</Tag>}</Space>
}
