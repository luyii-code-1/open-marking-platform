import {useState} from 'react'
import {Alert,Drawer,Modal,Space,Typography} from 'antd'
import {AssetImage} from './components'
import {Table} from './DataTable'
import {Button} from './Button'
import {useResource,type Row} from './api'

export function AnswerDetails({group,q,room,absent,onClose}:{group:string;q:Row;room?:string;absent:boolean;onClose:()=>void}){
  const params=new URLSearchParams({include_absent:String(absent)})
  if(room)params.set('room_tag_id',room)
  const {data,loading,error}=useResource<any>(`/analysis/groups/${group}/questions/${q.id}?${params}`,null)
  const [image,setImage]=useState<Row|null>(null)
  const objective=q.type!=='subjective'
  const percent=(n:number)=>data.respondents?(100*n/data.respondents).toFixed(1)+'%':'—'
  return <Drawer open width="min(860px, 100vw)" title={`第 ${q.number} 题 · 答题详情`} onClose={onClose}>
    {error&&<Alert type="error" message={error}/>}
    {objective&&data&&<Space direction="vertical" style={{marginBottom:16}}>
      <Typography.Text>标准答案 {data.answer.join('、')} · 实考 {data.respondents} 人（含空答）</Typography.Text>
      <Space wrap>{Object.entries(data.counts).map(([k,n])=><span key={k}>{k}　{String(n)} 人（{percent(Number(n))}）</span>)}<span>空答　{data.blank} 人（{percent(data.blank)}）</span></Space>
    </Space>}
    <Table<Row> rowKey="student_id" loading={loading} dataSource={data?.rows??[]} scroll={{x:'max-content'}} columns={[
      {title:'姓名',dataIndex:'name'},{title:'准考证号',dataIndex:'candidate_number'},{title:'班级',dataIndex:'class_name'},
      {title:'作答',render:(_,r)=>r.status==='unscanned'?'未扫描':r.status==='absent'?'缺考':objective?(r.selected?.join('、')||(r.selected?'空答':'—')):r.image_url?<Button type="link" onClick={()=>setImage(r)}>查看作答图</Button>:'—'},
      ...(objective?[{title:'标准答案',render:(_:unknown,r:Row)=>r.answer?.join('、')??'—'}]:[]),
      {title:'本题得分',render:(_,r)=>r.score??(r.status==='pending'?'待评分':'—')}]}/>
    <Modal title={image&&`${image.name} · 第 ${q.number} 题`} open={!!image} footer={null} width={800} onCancel={()=>setImage(null)}>
      {image&&<AssetImage key={image.image_url} src={image.image_url}/>}
    </Modal>
  </Drawer>
}
