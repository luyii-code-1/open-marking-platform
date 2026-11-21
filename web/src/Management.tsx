export { Results } from './Results'
export { Exceptions } from './Exceptions'
export { ErrorNotice } from './EntityTable'
import { lazy, Suspense, useState } from 'react'
import { Spin, Tabs } from 'antd'
import { ScanCapture } from './ScanCapture'
import { Corrections } from './Corrections'
import { Personnel } from './Personnel'
import { ScannerDevices } from './ScannerDevices'
import { AuditLog } from './AuditLog'
import { StorageConnections } from './StorageConnections'
import { LoginPageSettings } from './LoginPageSettings'
import { DatabaseBackups } from './DatabaseBackups'
import { readExamContext, rememberExamContext } from './examNavigation'
const HttpGuard = lazy(() => import('./HttpGuard'))
export function DataManagement(props:{systemAdmin?:boolean;tab?:string;onTab?:(key:string)=>void}) {return <Personnel {...props}/>}
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
    {key:'capture',label:'扫描批次',children:<ScanCapture groupId={groupId} selectedGroup={group} onGroupChange={changeGroup} selectedBatch={selectedBatch} onBatchChange={setSelectedBatch} onOpenCorrection={batchId=>{if(batchId)setSelectedBatch(batchId);changeTab('correct')}}/>},
    {key:'correct',label:'纠正与补扫',children:<Corrections groupId={groupId} selectedGroup={group} onGroupChange={changeGroup} selectedBatch={selectedBatch} onBatchChange={setSelectedBatch} onOpenCapture={batchId=>{if(batchId)setSelectedBatch(batchId);changeTab('capture')}}/>},
  ]}/>
}
export function Settings({tab,onTab}:{tab?:string;onTab?:(key:string)=>void}={}) {return <Tabs activeKey={tab} onChange={onTab} items={[{key:'login',label:'登录页面',children:<LoginPageSettings/>},{key:'devices',label:'扫描设备',children:<ScannerDevices/>},{key:'storage',label:'存储连接',children:<StorageConnections/>},{key:'backups',label:'数据库备份',children:<DatabaseBackups/>},{key:'http-guard',label:'HTTP 防护',destroyOnHidden:true,children:<Suspense fallback={<Spin aria-label="正在加载 HTTP 防护"/>}><HttpGuard/></Suspense>},{key:'audit',label:'操作记录',children:<AuditLog/>}]}/>}
