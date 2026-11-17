import {useId,useState} from 'react'
import {Alert,App,Form,Modal,Radio,Select,Space,Typography} from 'antd'
import {DownOutlined,DownloadOutlined} from '@ant-design/icons'
import {Button} from './Button'
import {download,useResource} from './api'
import {RoomTagPicker} from './RoomTags'
import {ResultFilters,useResultFilterOptions} from './ResultFilters'
import {readResultFilters,resultExportRequest,withResultFilters,type ResultFilterValue,type ResultReport} from './resultFilterParams'

type ExportScope=
  |{kind:'card';id:string;query:URLSearchParams;roomId?:string;studentCount:number}
  |{kind:'project';id:string;query?:URLSearchParams;cardCount:number;studentCount?:number}
const reports:Record<ResultReport,string>={items:'小题分明细',students:'考生成绩与排名',classes:'班级统计',questions:'单题分析',distribution:'分数分布',summary:'跨科成绩汇总',ranking:'单科班级成绩与排名','class-summary':'班级总表'}
const cardReports:ResultReport[]=['items','ranking','students','classes','questions','distribution']
const projectReports:ResultReport[]=['items','summary','class-summary']

export function ResultExport({scope,parts,room,disabled,initialReport='items'}:{scope:ExportScope;parts:string[];room?:string;disabled:boolean;initialReport?:ResultReport}){
  const [open,setOpen]=useState(false),[report,setReport]=useState<ResultReport>('items'),[format,setFormat]=useState<'xlsx'|'csv'>('xlsx'),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [filters,setFilters]=useState<ResultFilterValue>(()=>readResultFilters(scope.query)),[selectedRoom,setRoom]=useState(scope.kind==='card'?scope.roomId:scope.query?.get('room_tag_id')||undefined)
  const [selectedRoomLabel,setRoomLabel]=useState(room)
  const {message}=App.useApp(),reportId=useId(),options=useResultFilterOptions(scope.kind,scope.id,open)
  const projectBook=scope.kind==='project'&&report==='items',fileFormat=projectBook?'xlsx':format,noCards=scope.kind==='project'&&scope.cardCount===0
  const choices=scope.kind==='project'?projectReports:cardReports
  function queryFor(value:ResultFilterValue,roomId?:string){
    const params=withResultFilters(scope.query||new URLSearchParams(),value)
    params.set(scope.kind==='card'?'group_id':'project_id',scope.id)
    params.delete('room_tag_id');if(roomId)params.set('room_tag_id',roomId)
    return params
  }
  const previewQuery=queryFor(filters,selectedRoom)
  const previewPath=scope.kind==='card'?'/analysis/group':report==='class-summary'?'/analysis/project/class-summary':'/analysis/project'
  const preview=useResource<any>(open&&scope.id?`${previewPath}?${previewQuery}`:null,null)
  const matched=preview.loading?undefined:scope.kind==='card'?preview.data?.summary?.records:preview.data?.students?.length
  const needsClasses=report==='ranking'||report==='class-summary'
  async function exportFile(selected:ResultReport,extension:'xlsx'|'csv'){
    if(busy||disabled||(selected==='items'&&noCards))return
    const value=open?filters:readResultFilters(scope.query),roomId=open?selectedRoom:scope.kind==='card'?scope.roomId:scope.query?.get('room_tag_id')||undefined
    if((selected==='ranking'||selected==='class-summary')&&!value.classIds.length){setError('请先选择要导出的班级');return}
    setBusy(true);setError('')
    try{
      const {path,params}=resultExportRequest(scope.kind,scope.id,queryFor(value,roomId),selected,extension)
      const name=[...parts,open?selectedRoomLabel:room,reports[selected]].filter(Boolean).join('-').replace(/[\\/:*?"<>|]/g,'－')
      await download(`${path}?${params}`,`${name}.${extension}`);setOpen(false)
    }catch(error){const description=(error as Error).message;if(open)setError(description);else message.error(description)}finally{setBusy(false)}
  }
  return <>
    <Space.Compact>
      <Button type="primary" icon={<DownloadOutlined/>} loading={busy&&!open} disabled={disabled||noCards} onClick={()=>exportFile('items','xlsx')}>导出小题分</Button>
      <Button type="primary" icon={<DownOutlined/>} aria-label="导出选项" aria-haspopup="dialog" title="导出选项" disabled={disabled||busy} onClick={()=>{
        setRoomLabel(room);setReport(noCards?'summary':initialReport);setFormat('xlsx');setFilters(readResultFilters(scope.query));setRoom(scope.kind==='card'?scope.roomId:scope.query?.get('room_tag_id')||undefined);setError('');setOpen(true)
      }}/>
    </Space.Compact>
    <Modal title="导出选项" open={open} width={940} style={{maxWidth:'94vw'}} okText="下载文件" cancelText="取消" onOk={()=>exportFile(report,fileFormat)} confirmLoading={busy}
      okButtonProps={{disabled:disabled||(projectBook&&noCards)||(needsClasses&&!filters.classIds.length)||preview.loading||!!preview.error||!!options.error}} cancelButtonProps={{disabled:busy}} maskClosable={!busy} keyboard={!busy} closable={!busy} onCancel={()=>{if(!busy)setOpen(false)}}>
      <Form layout="vertical" component="div" className="result-export-form">
        <div className="result-export-scope"><Typography.Text strong>{parts.filter(Boolean).join(' / ')}</Typography.Text><Typography.Text type="secondary">{scope.kind==='card'?room||'全部考场':`${scope.cardCount} 张题卡`}</Typography.Text></div>
        <Space wrap align="start" style={{width:'100%'}}>
          <Form.Item label="导出内容" htmlFor={reportId}><Select id={reportId} style={{minWidth:220}} value={report} disabled={busy} onChange={value=>{setReport(value);setError('')}} options={choices.map(value=>({value,label:reports[value],disabled:value==='items'&&noCards}))}/></Form.Item>
          <Form.Item label="文件格式">{projectBook?<Typography.Text>Excel 工作簿（每张题卡一张工作表）</Typography.Text>:<Radio.Group aria-label="文件格式" value={fileFormat} disabled={busy} onChange={event=>setFormat(event.target.value)} options={[{label:'Excel（.xlsx）',value:'xlsx'},{label:'CSV',value:'csv'}]}/>}</Form.Item>
          <Form.Item label="考场"><RoomTagPicker groupId={scope.kind==='card'?scope.id:undefined} projectId={scope.kind==='project'?scope.id:undefined} value={selectedRoom} onChange={(id,label)=>{setRoom(id||undefined);setRoomLabel(label)}}/></Form.Item>
        </Space>
        <Form.Item label="导出过滤器"><ResultFilters allowGroups={scope.kind==='project'} value={filters} onChange={setFilters} options={options.data} disabled={busy} loading={options.loading} matched={matched}/></Form.Item>
        {preview.loading&&<Typography.Paragraph type="secondary">正在计算匹配人数…</Typography.Paragraph>}
        {needsClasses&&!filters.classIds.length&&<Alert type="info" showIcon message="选择一个或多个班级后导出；Excel 按班级分工作表。"/>}
        {(error||preview.error||options.error)&&<Alert type="error" showIcon message={error||preview.error||options.error}/>}
      </Form>
    </Modal>
  </>
}
