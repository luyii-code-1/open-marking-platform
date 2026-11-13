import { useEffect,useState } from 'react'
import { Alert,App,Card,Form,Select,Space,Table,Tag,Typography } from 'antd'
import { Button } from './Button'
import { send,useResource,type Row } from './api'
import { HierarchyPicker } from './HierarchyPicker'

export function Roster({groupId}:{groupId?:string}){
  const groups=useResource<Row[]>('/groups',[]),grades=useResource<Row[]>('/grades',[])
  const [selectedGroup,setGroup]=useState(groupId||''),group=groupId||selectedGroup,[gradeId,setGrade]=useState<string>(),[busy,setBusy]=useState(false),{message}=App.useApp()
  const resource=useResource<any>(group?`/groups/${group}/roster`:null,null),current=groups.data.find(g=>g.id===group)
  const data=resource.data?.group_id===group?resource.data:null
  useEffect(()=>setGrade(current?.grade_id),[group,current?.grade_id])
  async function save(){if(!gradeId)return;setBusy(true);try{await send(`/groups/${group}/grade`,{grade_id:gradeId},'PUT');await Promise.all([groups.reload(),resource.reload()]);message.success('年级已关联，应考名单实时更新')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  return <Card title="应考年级与名单" extra={<Button disabled={busy} onClick={()=>{void groups.reload();void grades.reload();void resource.reload()}}>刷新</Button>}>
    {(groups.error||grades.error||resource.error)&&<Alert type="error" message={groups.error||grades.error||resource.error}/>}
    <Space direction="vertical" size={24} style={{width:'100%'}}>{!groupId&&<HierarchyPicker value={group} onChange={setGroup}/>}
      <Typography.Paragraph type="secondary">题卡组使用一个年级的全体学生作为默认应考对象。转班、转年级及资料修改实时生效；已有答卷和成绩保留。选科造成的未扫描可以正常保留。</Typography.Paragraph>
      {group&&<><Form layout="vertical" style={{maxWidth:420}}><Form.Item label="所属年级"><Select value={gradeId} placeholder="选择全局年级" onChange={setGrade} options={grades.data.filter(g=>!g.archived||g.id===current?.grade_id).map(g=>({label:g.name,value:g.id}))}/></Form.Item><Button type="primary" disabled={!gradeId||resource.loading} loading={busy} onClick={save}>保存所属年级</Button></Form><Typography.Text>{data?.configured?`当前应考 ${data.students.length} 人`:'设置年级后自动生成名单'}</Typography.Text>
        <Table rowKey="id" loading={resource.loading} dataSource={data?.students||[]} pagination={{defaultPageSize:20}} columns={[{title:'考号',dataIndex:'candidate_number'},{title:'姓名',dataIndex:'name'},{title:'年级',dataIndex:'grade'},{title:'班级',dataIndex:'class_name'},{title:'采集状态',dataIndex:'status',render:value=><Tag color={value==='scanned'?'green':undefined}>{value==='unscanned'?'未扫描':value==='absent'?'已确认缺考':'已扫描'}</Tag>}]}/></>}
    </Space>
  </Card>
}
