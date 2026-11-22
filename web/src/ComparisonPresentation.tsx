import {useState} from 'react'
import {Alert,App,Modal,Select,Space} from 'antd'
import {Table} from './DataTable'
import {MultipleRecordSelect} from './RecordSelect'
import {download,useResource,type Row} from './api'

const fields=[['project','考试'],['subject','科目'],['grade','年级'],['label','范围'],['analyzed','统计人数'],['average','平均分'],['score_rate','平均得分率%'],['pass_rate','及格率%'],['excellent_rate','优秀率%'],['full_score','满分']]

export function ComparisonExport({ids,onClose,initialFormat='xlsx'}:{ids:string[];onClose:()=>void;initialFormat?:string}){
  const [columns,setColumns]=useState(fields.map(([key])=>key)),[format,setFormat]=useState(initialFormat),[busy,setBusy]=useState(false),{message}=App.useApp()
  const query=new URLSearchParams({scope_ids:ids.join(','),columns:columns.join(',')})
  const data=useResource<any>(columns.length?'/comparison?'+query:null,null)
  async function save(){setBusy(true);try{query.set('format',format);query.set('preview_version',data.data.version);await download('/comparison?'+query,'多次对比.'+format)}catch(e){message.error((e as Error).message);await data.reload()}finally{setBusy(false)}}
  return <Modal title="对比导出预览" width="90vw" open onCancel={()=>!busy&&onClose()} confirmLoading={busy} okText="下载" okButtonProps={{disabled:!columns.length||data.loading||!data.loaded||!!data.error}} onOk={save}>
    <Space wrap><MultipleRecordSelect title="导出内容" records={fields.map(([id,name])=>({id,name}))} value={columns} onChange={setColumns}/><Select aria-label="导出格式" value={format} onChange={setFormat} options={[{value:'xlsx',label:'Excel'},{value:'csv',label:'CSV'}]}/></Space>
    {data.error&&<Alert type="error" message={data.error}/>}<Table query="" columnChooser={false} rowKey="id" loading={data.loading} dataSource={data.loading?[]:data.data?.rows||[]} columns={(data.data?.columns||[]).map((c:any)=>({title:c.label,dataIndex:c.key}))}/>
  </Modal>
}

export function ComparisonChart({rows}:{rows:Row[]}){
  const [metric,setMetric]=useState('score_rate'),[mode,setMode]=useState('bar')
  const max=Math.max(1,...rows.map(r=>Number(r[metric])||0)),width=900,height=300,pad=40
  const point=(r:Row,i:number)=>({x:pad+(i+.5)*(width-2*pad)/Math.max(1,rows.length),y:height-pad-(height-2*pad)*(Number(r[metric])||0)/max})
  return <><Space wrap><Select aria-label="对比指标" value={metric} onChange={setMetric} options={fields.filter(([key])=>['average','analyzed','score_rate','pass_rate','excellent_rate'].includes(key)).map(([value,label])=>({value,label}))}/><Select aria-label="图表类型" value={mode} onChange={setMode} options={[{value:'bar',label:'柱状图 · 横向对比'},{value:'line',label:'折线图 · 纵向趋势'}]}/></Space>
    <svg role="img" aria-label="考试成绩对比图" viewBox="0 0 900 300" style={{width:'100%',maxHeight:380}}>
      {[0,.25,.5,.75,1].map(t=><g key={t}><line x1={pad} x2={width-pad} y1={height-pad-(height-2*pad)*t} y2={height-pad-(height-2*pad)*t} stroke="#ddd"/><text x={2} y={height-pad-(height-2*pad)*t} fontSize={11}>{(max*t).toFixed(1)}</text></g>)}
      {mode==='line'&&rows.slice(1).map((r,i)=>{if(r[metric]==null||rows[i][metric]==null)return null;const a=point(rows[i],i),b=point(r,i+1);return <line key={r.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#1677ff" strokeWidth={3}/>})}
      {rows.map((r,i)=>{const p=point(r,i),bar=Math.min(50,(width-2*pad)/rows.length*.6);return <g key={r.id}><title>{[r.project,r.subject,r.label].join(' / ')}：{r[metric]??'无数据'}</title>{r[metric]!=null&&(mode==='bar'?<rect x={p.x-bar/2} y={p.y} width={bar} height={height-pad-p.y} fill="#1677ff"/>:<circle cx={p.x} cy={p.y} r={5} fill="#1677ff"/>)}<text x={p.x} y={Math.max(14,p.y-8)} textAnchor="middle" fontSize={12}>{r[metric]??'—'}</text><text x={p.x} y={height-15} textAnchor="middle" fontSize={12}>{i+1}</text></g>})}
    </svg>
  </>
}
