import { useState } from 'react'
import { Tabs } from 'antd'
import { readExamContext, rememberExamContext } from './examNavigation'
import { loadPage } from './loadPage'

const ScanCapture = loadPage(() => import('./ScanCapture').then(module => ({ default: module.ScanCapture })))
const Corrections = loadPage(() => import('./Corrections').then(module => ({ default: module.Corrections })))
const ScannerDevices = loadPage(() => import('./ScannerDevices').then(module => ({ default: module.ScannerDevices })))
const AuditLog = loadPage(() => import('./AuditLog').then(module => ({ default: module.AuditLog })))
const StorageConnections = loadPage(() => import('./StorageConnections').then(module => ({ default: module.StorageConnections })))
const SystemStorage = loadPage(() => import('./SystemStorage').then(module => ({ default: module.SystemStorage })))
const LoginPageSettings = loadPage(() => import('./LoginPageSettings').then(module => ({ default: module.LoginPageSettings })))
const DatabaseBackups = loadPage(() => import('./DatabaseBackups').then(module => ({ default: module.DatabaseBackups })))

export function Scans({groupId,tab,onTab}:{groupId?:string;tab?:string;onTab?:(key:string)=>void}) {
  const [activeTab,setActiveTab]=useState(tab||'capture')
  const [selectedGroup,setSelectedGroup]=useState(()=>groupId||readExamContext().groupId)
  const [selectedBatch,setSelectedBatch]=useState('')
  const currentTab=tab??activeTab
  const group=groupId||selectedGroup
  function changeTab(next:string){setActiveTab(next);onTab?.(next)}
  function changeGroup(next:string){
    setSelectedGroup(next)
    setSelectedBatch('')
    if(next)rememberExamContext({groupId:next})
  }
  return <Tabs activeKey={currentTab} onChange={changeTab} items={[
    {key:'capture',label:'扫描记录',children:<ScanCapture groupId={groupId} selectedGroup={group} onGroupChange={changeGroup} selectedBatch={selectedBatch} onBatchChange={setSelectedBatch} onOpenCorrection={batchId=>{if(batchId)setSelectedBatch(batchId);changeTab('correct')}}/>},
    {key:'correct',label:'纠正与补扫',children:<Corrections groupId={groupId} selectedGroup={group} onGroupChange={changeGroup} selectedBatch={selectedBatch} onBatchChange={setSelectedBatch} onOpenCapture={batchId=>{if(batchId)setSelectedBatch(batchId);changeTab('capture')}}/>},
  ]}/>
}
export function Settings({tab,onTab}:{tab?:string;onTab?:(key:string)=>void}={}) {return <Tabs activeKey={tab} onChange={onTab} items={[{key:'login',label:'登录页面',children:<LoginPageSettings/>},{key:'devices',label:'扫描设备',children:<ScannerDevices/>},{key:'storage',label:'存储连接',children:<StorageConnections/>},{key:'space',label:'存储空间与日志',children:<SystemStorage/>},{key:'backups',label:'数据库备份',children:<DatabaseBackups/>},{key:'audit',label:'操作记录',children:<AuditLog/>}]}/>}
