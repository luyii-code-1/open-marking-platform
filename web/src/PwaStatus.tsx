import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { App, Modal, Typography } from 'antd'
import { Button } from './Button'
import { canPreparePwaUpdate, reportPwaReady } from './pwaCoordinator'
import { automaticPwaUpdates } from './updatePolicy'

interface InstallPrompt extends Event {
  prompt():Promise<void>
  userChoice:Promise<{outcome:'accepted'|'dismissed'}>
}
const Installation=createContext<{prompt:InstallPrompt|null;installed:boolean;clear:()=>void}>({prompt:null,installed:false,clear:()=>{}})

export function PwaRuntime({children}:{children:ReactNode}){
  const [prompt,setPrompt]=useState<InstallPrompt|null>(null)
  const [installed,setInstalled]=useState(()=>matchMedia('(display-mode: standalone)').matches||Boolean((navigator as Navigator&{standalone?:boolean}).standalone))
  useEffect(()=>{
    const capture=(event:Event)=>{event.preventDefault();setPrompt(event as InstallPrompt)}
    const didInstall=()=>{setInstalled(true);setPrompt(null)}
    window.addEventListener('beforeinstallprompt',capture);window.addEventListener('appinstalled',didInstall)
    const updates=import.meta.env.PROD&&'serviceWorker' in navigator&&window.isSecureContext?automaticPwaUpdates({
      register:()=>navigator.serviceWorker.register('/worker.js',{updateViaCache:'none'}),
      ready:canPreparePwaUpdate,onReady:reportPwaReady,visible:()=>document.visibilityState==='visible',online:()=>navigator.onLine,
    }):undefined
    const resume=()=>updates?.tick()
    window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume)
    return()=>{updates?.stop();window.removeEventListener('beforeinstallprompt',capture);window.removeEventListener('appinstalled',didInstall);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume)}
  },[])
  return <Installation.Provider value={{prompt,installed,clear:()=>setPrompt(null)}}>{children}</Installation.Provider>
}

export function InstallApplication(){
  const {prompt,installed,clear}=useContext(Installation),{message}=App.useApp()
  async function install(){
    if(!prompt){Modal.info({title:'安装阅卷平台',content:'在浏览器菜单中选择“安装应用”或“添加到主屏幕”。请使用 HTTPS 访问。'});return}
    try{await prompt.prompt();await prompt.userChoice;clear()}catch{message.error('未能打开安装入口，可使用浏览器菜单安装')}
  }
  return installed?<Typography.Text type="secondary">已安装到此设备</Typography.Text>:<Button onClick={install}>安装应用</Button>
}
