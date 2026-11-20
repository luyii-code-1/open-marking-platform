import {useState} from 'react'
import {Alert,Drawer,Input,InputNumber,Space,Tabs,Typography} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {useResource,type Row} from './api'
import {ResultExport} from './ResultExport'

export function reportColumns(columns:Row[]):any[]{
  return columns.map(column=>column.children?{title:column.title,children:reportColumns(column.children)}:{title:column.title,dataIndex:column.key,key:column.key,width:Math.max(88,column.width*8),render:(value:unknown)=>value===null||value===undefined?'—':String(value)})
}

export function ResultReports({groupId,classId,open,onClose}:{groupId:string;classId:string;open:boolean;onClose:()=>void}){
  const [step,setStep]=useState<number>(10),[limits,setLimits]=useState('10,30,50,100,200'),[applied,setApplied]=useState({step:10,limits:'10,30,50,100,200'})
  const query=new URLSearchParams({group_id:groupId,class_ids:classId,score_step:String(applied.step),ranks:applied.limits})
  const resource=useResource<any>(open?`/analysis/reports?${query}`:null,null)
  return <Drawer title="成绩分析报表" width="min(1200px, 96vw)" open={open} onClose={onClose} extra={<ResultExport scope={{kind:'card',id:groupId,query,studentCount:resource.data?.summary?.records||0}} parts={[resource.data?.title||'成绩分析']} disabled={resource.loading||!!resource.error}/> }>
    <Space wrap style={{marginBottom:16}}><Typography.Text>分数段间隔</Typography.Text><InputNumber aria-label="分数段间隔" min={0.01} max={1000} value={step} onChange={value=>setStep(value??10)}/><Typography.Text>累计名次</Typography.Text><Input aria-label="累计名次" value={limits} style={{width:230}} onChange={event=>setLimits(event.target.value)}/><Button onClick={()=>setApplied({step,limits})}>应用</Button></Space>
    <Typography.Paragraph type="secondary">仅统计当前班级；名次基准为当前账号可见的题卡成绩范围。缺考、未扫描和待结分单列，分数段及名次段按已结分实考成绩统计。</Typography.Paragraph>
    {resource.error&&<Alert type="error" message={resource.error}/>}
    <Tabs items={Object.entries(resource.data?.reports||{}).filter(([key])=>key!=='items').map(([key,value])=>{const report=value as Row;return {key,label:report.name,children:<Table query="" columnChooser={false} rowKey={(_,index)=>String(index)} loading={resource.loading} dataSource={resource.loading||resource.error?[]:report.rows} columns={reportColumns(report.columns)} scroll={{x:'max-content',y:'calc(100dvh - 330px)'}}/>}})}/>
  </Drawer>
}
