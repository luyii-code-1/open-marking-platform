import {useId,useState} from 'react'
import {Alert,App,Collapse,Form,Input,InputNumber,Modal,Radio,Select,Space,Typography} from 'antd'
import {DownOutlined,DownloadOutlined} from '@ant-design/icons'
import {Button} from './Button'
import {download,useResource} from './api'
import {RoomTagPicker} from './RoomTags'
import {ResultFilters,useResultFilterOptions} from './ResultFilters'
import {formalReports,readResultFilters,resultExportExtension,resultExportRequest,withResultFilters,type ResultFilterValue,type ResultReport} from './resultFilterParams'

type ExportScope=
  |{kind:'card';id:string;query:URLSearchParams;roomId?:string;studentCount:number}
  |{kind:'project';id:string;query?:URLSearchParams;cardCount:number;studentCount?:number}
const reports:Record<ResultReport,string>={workbook:'完整成绩分析（五张工作表）',items:'小题分',averages:'小题平均分对比',ranks:'名次段分析',bands:'分数段分析',students:'考生成绩与排名',classes:'班级统计',questions:'试题分析',distribution:'分数分布',summary:'跨科成绩汇总',ranking:'单科班级成绩与排名','class-summary':'班级总表'}
const cardReports:ResultReport[]=[...formalReports,'ranking','students','classes','distribution']
const projectReports:ResultReport[]=[...formalReports,'class-summary','summary']

export function ResultExport({scope,parts,room,disabled,initialReport='workbook',quickReport='workbook'}:{quickReport?:ResultReport;scope:ExportScope;parts:string[];room?:string;disabled:boolean;initialReport?:ResultReport}){
  const [open,setOpen]=useState(false),[report,setReport]=useState<ResultReport>('items'),[format,setFormat]=useState<'xlsx'|'csv'>('xlsx'),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [filters,setFilters]=useState<ResultFilterValue>(()=>readResultFilters(scope.query)),[selectedRoom,setRoom]=useState(scope.kind==='card'?scope.roomId:scope.query?.get('room_tag_id')||undefined)
  const [selectedRoomLabel,setRoomLabel]=useState(room)
  const [step,setStep]=useState(10),[ranks,setRanks]=useState('10,30,50,100,200')
  const {message}=App.useApp(),reportId=useId(),options=useResultFilterOptions(scope.kind,scope.id,open)
  const formal=formalReports.includes(report),projectBook=scope.kind==='project'&&formal,fileFormat=formal?'xlsx':format,noCards=scope.kind==='project'&&scope.cardCount===0
  const choices=scope.kind==='project'?projectReports:cardReports
  function queryFor(value:ResultFilterValue,roomId?:string){
    const params=withResultFilters(scope.query||new URLSearchParams(),value)
    params.set(scope.kind==='card'?'group_id':'project_id',scope.id)
    params.delete('room_tag_id');if(roomId)params.set('room_tag_id',roomId)
    params.set('score_step',open?String(step):scope.query?.get('score_step')||'10')
    params.set('ranks',open?ranks:scope.query?.get('ranks')||'10,30,50,100,200')
    return params
  }
  const previewQuery=queryFor(filters,selectedRoom)
  const previewPath=scope.kind==='card'?'/analysis/group':report==='class-summary'?'/analysis/project/class-summary':'/analysis/project'
  const preview=useResource<any>(open&&scope.id?`${previewPath}?${previewQuery}`:null,null)
  const matched=preview.loading?undefined:scope.kind==='card'?preview.data?.summary?.records:preview.data?.students?.length
  const needsClasses=report==='ranking'||report==='class-summary'
  async function exportFile(selected:ResultReport,extension:'xlsx'|'csv'){
    if(busy||disabled||(formalReports.includes(selected)&&noCards))return
    const value=open?filters:readResultFilters(scope.query),roomId=open?selectedRoom:scope.kind==='card'?scope.roomId:scope.query?.get('room_tag_id')||undefined
    if((selected==='ranking'||selected==='class-summary')&&!value.classIds.length){setError('请先选择要导出的班级');return}
    setBusy(true);setError('')
    try{
      const {path,params}=resultExportRequest(scope.kind,scope.id,queryFor(value,roomId),selected,extension)
      const name=[...parts,open?selectedRoomLabel:room,reports[selected]].filter(Boolean).join('-').replace(/[\\/:*?"<>|]/g,'－')
      await download(`${path}?${params}`,`${name}.${resultExportExtension(scope.kind,selected,extension)}`);setOpen(false)
    }catch(error){const description=(error as Error).message;if(open)setError(description);else message.error(description)}finally{setBusy(false)}
  }
  return <>
    <Space.Compact>
      <Button type="primary" icon={<DownloadOutlined/>} loading={busy&&!open} disabled={disabled||noCards} onClick={()=>exportFile(quickReport,'xlsx')}>{quickReport==='workbook'?'导出成绩报表':'导出当前表'}</Button>
      <Button type="primary" icon={<DownOutlined/>} aria-label="导出选项" aria-haspopup="dialog" title="导出选项" disabled={disabled||busy} onClick={()=>{
        setRoomLabel(room);setReport(noCards?'summary':initialReport);setFormat('xlsx');setFilters(readResultFilters(scope.query));setRoom(scope.kind==='card'?scope.roomId:scope.query?.get('room_tag_id')||undefined);setStep(Number(scope.query?.get('score_step'))||10);setRanks(scope.query?.get('ranks')||'10,30,50,100,200');setError('');setOpen(true)
      }}/>
    </Space.Compact>
    <Modal title="导出成绩报表" open={open} width={720} style={{maxWidth:'94vw'}} okText="下载文件" cancelText="取消" onOk={()=>exportFile(report,fileFormat)} confirmLoading={busy}
      okButtonProps={{disabled:disabled||(projectBook&&noCards)||(needsClasses&&!filters.classIds.length)||preview.loading||!!preview.error||!!options.error}} cancelButtonProps={{disabled:busy}} maskClosable={!busy} keyboard={!busy} closable={!busy} onCancel={()=>{if(!busy)setOpen(false)}}>
      <Form layout="vertical" component="div" className="result-export-form">
        <div className="result-export-scope"><Typography.Text strong>{parts.filter(Boolean).join(' / ')}</Typography.Text><Typography.Text type="secondary">{scope.kind==='card'?room||'全部考场':`${scope.cardCount} 张题卡`}</Typography.Text></div>
        <Space wrap align="start" style={{width:'100%'}}>
          <Form.Item label="导出内容" htmlFor={reportId}><Select id={reportId} style={{minWidth:220}} value={report} disabled={busy} onChange={value=>{setReport(value);setError('')}} options={choices.map(value=>({value,label:reports[value],disabled:formalReports.includes(value)&&noCards}))}/></Form.Item>
          <Form.Item label="文件格式">{formal?<Typography.Text>{projectBook?'ZIP 压缩包（每张题卡一个 Excel 文件）':'Excel 工作簿（.xlsx）'}</Typography.Text>:<Radio.Group aria-label="文件格式" value={fileFormat} disabled={busy} onChange={event=>setFormat(event.target.value)} options={[{label:'Excel（.xlsx）',value:'xlsx'},{label:'CSV',value:'csv'}]}/>}</Form.Item>
        </Space>
        {report==='workbook'&&<Typography.Paragraph type="secondary">包含小题分、小题均分对比、试题分析、名次段及分数段分析。名次以当前可见范围计算，同分并列。</Typography.Paragraph>}
        <Collapse defaultActiveKey={needsClasses?['range']:[]} items={[{key:'range',label:'调整导出范围',children:<><Form.Item label="考场"><RoomTagPicker groupId={scope.kind==='card'?scope.id:undefined} projectId={scope.kind==='project'?scope.id:undefined} value={selectedRoom} onChange={(id,label)=>{setRoom(id||undefined);setRoomLabel(label)}}/></Form.Item><ResultFilters allowGroups={scope.kind==='project'} value={filters} onChange={setFilters} options={options.data} disabled={busy} loading={options.loading} matched={matched}/></>},...formal?[{key:'statistics',label:'统计设置',children:<Space wrap align="start"><Form.Item label="分数段间隔"><InputNumber aria-label="导出分数段间隔" min={0.01} max={1000} value={step} onChange={value=>setStep(value??10)}/></Form.Item><Form.Item label="累计名次（逗号分隔）"><Input aria-label="导出累计名次" value={ranks} onChange={event=>setRanks(event.target.value)}/></Form.Item></Space>}]:[] ]}/>
        {preview.loading&&<Typography.Paragraph type="secondary">正在计算匹配人数…</Typography.Paragraph>}
        {needsClasses&&!filters.classIds.length&&<Alert type="info" showIcon message="选择一个或多个班级后导出；Excel 按班级分工作表。"/>}
        {(error||preview.error||options.error)&&<Alert type="error" showIcon message={error||preview.error||options.error}/>}
      </Form>
    </Modal>
  </>
}
