export { Results } from './Results'
export { Exceptions } from './Exceptions'
export { ErrorNotice } from './EntityTable'
import { Tabs } from 'antd'
import { ScanCapture } from './ScanCapture'
import { Corrections } from './Corrections'
import { Personnel } from './Personnel'
import { ScannerDevices } from './ScannerDevices'
import { AuditLog } from './AuditLog'
import { Conversions } from './Conversions'
import { StorageConnections } from './StorageConnections'
export function DataManagement({systemAdmin=false}:{systemAdmin?:boolean}) {return <Personnel systemAdmin={systemAdmin}/>}
export function Scans({groupId}:{groupId?:string}) {return <Tabs items={[{key:'capture',label:'扫描批次',children:<ScanCapture groupId={groupId}/>},{key:'correct',label:'纠正与补扫',children:<Corrections groupId={groupId}/>}]}/>}
export function Settings() {return <Tabs items={[{key:'devices',label:'扫描设备',children:<ScannerDevices/>},{key:'storage',label:'存储连接',children:<StorageConnections/>},{key:'conversions',label:'赋分方案',children:<Conversions/>},{key:'audit',label:'操作记录',children:<AuditLog/>}]}/>}
