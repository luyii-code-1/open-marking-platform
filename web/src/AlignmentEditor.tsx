import { useEffect,useRef,useState } from 'react'
import { Alert, App, Checkbox, Input, Select, Space, Tag, Typography } from 'antd'
import { Button } from './Button'
import { send,useResource,type Row } from './api'

type Point={x:number;y:number}
export function AlignmentEditor({pageId,initialReason,onSaved}:{pageId:string;initialReason:string;onSaved:(page:Row)=>Promise<void>}) {
  const [rotation,setRotation]=useState(0),[points,setPoints]=useState<Point[]>([]),[url,setUrl]=useState(''),[error,setError]=useState(''),[reason,setReason]=useState(initialReason),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[zoom,setZoom]=useState(1),operation=useRef(crypto.randomUUID()),{message}=App.useApp()
  const resource=useResource<any>(`/pages/${pageId}/alignment?rotation=${rotation}`,null)
  const info=resource.data?.id===pageId&&resource.data.rotation===rotation?resource.data:null
  useEffect(()=>{setPoints([]);setConfirmed(false);operation.current=crypto.randomUUID()},[rotation,pageId])
  useEffect(()=>{
    let cancelled=false,objectUrl='';const abort=new AbortController();setUrl('');setError('');if(!info)return
    void fetch(info.image_url,{headers:{Authorization:`Bearer ${sessionStorage.getItem('omp-token')||''}`},signal:abort.signal}).then(async response=>{if(!response.ok)throw new Error('原始扫描图无法加载');return response.blob()}).then(blob=>{if(!cancelled){objectUrl=URL.createObjectURL(blob);setUrl(objectUrl)}}).catch(e=>{if(!cancelled)setError(e.message)})
    return()=>{cancelled=true;abort.abort();if(objectUrl)URL.revokeObjectURL(objectUrl)}
  },[info?.image_url])
  function change(value:Point[]){setPoints(value);operation.current=crypto.randomUUID()}
  async function save(){
    if(!reason.trim()){message.warning('请填写人工定位原因');return}
    setBusy(true)
    try{const page=await send<Row>(`/pages/${pageId}/align`,{request_id:operation.current,corners:points,rotation,reason,confirm_template:confirmed});await onSaved(page);await resource.reload();message.success('已保存定位与重新识读结果，请核对考号、选项及缺考标记')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}
  }
  return <Space direction="vertical" style={{width:'100%'}}><Alert type="info" message="依次点击四个黑色定位方块的中心：左上 → 右上 → 右下 → 左下。" description="原始扫描件保留。已配对页面请使用补扫替换。"/>
    {(resource.error||error)&&<Alert type="error" message={resource.error||error}/>}
    {info?.qr_conflict&&<Alert type="error" message="二维码属于其他考卷或面，请排除混卷，不能用人工定位改写归属。"/>}
    <Space wrap><Select disabled={busy} value={rotation} onChange={setRotation} options={[0,1,2,3].map(value=>({label:`顺时针 ${value*90}°`,value}))}/><Button onClick={()=>setZoom(z=>Math.max(.5,z-.25))}>缩小</Button><Button onClick={()=>setZoom(z=>Math.min(3,z+.25))}>放大</Button><Button disabled={busy||!points.length} onClick={()=>change(points.slice(0,-1))}>撤销一点</Button><Button disabled={busy||!points.length} onClick={()=>change([])}>重新选择</Button><Tag>{points.length}/4</Tag></Space>
    <div style={{maxHeight:520,width:'100%',overflow:'auto',background:'#e8ede9'}}>{info&&url&&<svg viewBox={`0 0 ${info.width} ${info.height}`} style={{display:'block',width:`${zoom*100}%`,minWidth:350,cursor:'crosshair'}} onClick={event=>{if(busy||points.length===4)return;const box=event.currentTarget.getBoundingClientRect();change([...points,{x:Math.max(0,Math.min(info.width-1,(event.clientX-box.left)/box.width*info.width)),y:Math.max(0,Math.min(info.height-1,(event.clientY-box.top)/box.height*info.height))}])}}><image href={url} width={info.width} height={info.height}/><polyline points={(points.length===4?[...points,points[0]]:points).map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke="#d32020" strokeWidth={info.width/350}/>{points.map((p,index)=><g key={index}><circle cx={p.x} cy={p.y} r={info.width/100} fill="#d32020"/><text x={p.x+info.width/80} y={p.y} fontSize={info.width/40} fill="#d32020">{index+1}</text></g>)}</svg>}</div>
    {info&&!info.qr_matches&&!info.qr_conflict&&<Checkbox disabled={busy} checked={confirmed} onChange={e=>{setConfirmed(e.target.checked);operation.current=crypto.randomUUID()}}>已人工核对确为当前考卷与正反面</Checkbox>}
    <Input.TextArea disabled={busy} rows={2} value={reason} onChange={e=>{setReason(e.target.value);operation.current=crypto.randomUUID()}} placeholder="说明人工定位原因"/>
    <Button type="primary" loading={busy} disabled={points.length!==4||!info||info.qr_conflict||(!info.qr_matches&&!confirmed)} onClick={save}>保存四点定位并重新识读</Button><Typography.Text type="secondary">二维码损坏的批次在核对完成后，仍需由管理员手动恢复扫描。</Typography.Text>
  </Space>
}
