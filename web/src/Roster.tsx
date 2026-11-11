import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Select, Space, Table, Tag, Typography } from 'antd'
import { send, useResource, type Row } from './api'

export function Roster() {
  const groups=useResource<Row[]>('/groups',[]),classes=useResource<Row[]>('/classes',[]),students=useResource<Row[]>('/students',[])
  const [group,setGroup]=useState(''),[classIds,setClassIds]=useState<string[]>([]),[studentIds,setStudentIds]=useState<string[]>([]),[busy,setBusy]=useState(false),{message}=App.useApp()
  const resource=useResource<any>(group?`/groups/${group}/roster`:null,null,{live:false})
  const data=resource.data?.group_id===group?resource.data:null
  useEffect(()=>{setClassIds(data?.class_ids||[]);setStudentIds(data?.student_ids||[])},[data])
  const expected=students.data.filter(s=>classIds.includes(s.class_id)||studentIds.includes(s.id)).length
  async function save(){setBusy(true);try{await send(`/groups/${group}/roster`,{class_ids:classIds,student_ids:studentIds},'PUT');await resource.reload();await groups.reload();message.success('应考名单已保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  return <Card title="题卡组应考名单" extra={<Button onClick={()=>{void groups.reload();void classes.reload();void students.reload();void resource.reload()}}>刷新</Button>}>
    {(groups.error||resource.error||classes.error||students.error)&&<Alert type="error" message={groups.error||resource.error||classes.error||students.error}/>}
    <Space direction="vertical" style={{width:'100%'}}><Select style={{minWidth:300}} placeholder="选择题卡组" value={group||undefined} options={groups.data.map(g=>({label:g.name,value:g.id}))} onChange={setGroup}/>
      <Typography.Paragraph type="secondary">按班级加入学生，也可补充单独应考学生。保存时固定本次名单，后续学生升级或变更班级不会自动改动；需要更新时重新保存。已有答卷会继续保留。</Typography.Paragraph>
      {group&&<><Form layout="vertical"><Form.Item label="应考班级"><Select mode="multiple" value={classIds} onChange={setClassIds} options={classes.data.map(c=>({label:`${c.grade||''} ${c.name}`,value:c.id}))}/></Form.Item><Form.Item label="额外应考学生"><Select mode="multiple" showSearch optionFilterProp="label" value={studentIds} onChange={setStudentIds} options={students.data.map(s=>({label:`${s.candidate_number} ${s.name}`,value:s.id}))}/></Form.Item></Form><Space><Button type="primary" loading={busy} disabled={resource.loading||groups.data.find(g=>g.id===group)?.frozen} onClick={save}>保存应考名单（{expected} 人）</Button><Typography.Text>已保存：{data?.configured?`${data.students.length} 人`:'尚未配置'}</Typography.Text></Space>
        <Table rowKey="id" loading={resource.loading} dataSource={data?.students||[]} columns={[{title:'考号',dataIndex:'candidate_number'},{title:'姓名',dataIndex:'name'},{title:'班级',dataIndex:'class_name'},{title:'采集状态',dataIndex:'status',render:value=><Tag color={value==='unscanned'?'orange':value==='absent'?'default':'green'}>{value==='unscanned'?'未扫描':value==='absent'?'已确认缺考':'已扫描'}</Tag>}]}/></>}
    </Space>
  </Card>
}
