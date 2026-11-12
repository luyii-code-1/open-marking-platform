import { Button } from './Button'
import { RoomTagBadges, RoomTagPicker } from './RoomTags'
import { useEffect, useState } from 'react'
import { Alert, App, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd'
import { download, send, useResource, type Row } from './api'
import { AssetImage } from './components'
import { HierarchyPicker } from './HierarchyPicker'

const kinds:Record<string,string>={automatic:'自动检查',recognition:'定位识别失败',wrong_paper:'混卷或正反面不符',scan_quality:'扫描页面质量',exception:'教师报告',excellent:'优秀卷'}
const rules:Record<string,string>={blank_answers:'客观题留空数量',same_answer_run:'连续相同选项',invalid_single:'单选题多选'}

export function Exceptions({groupId}:{groupId?:string}) {
  const [selectedGroup,setGroup]=useState(groupId || ''),group=groupId || selectedGroup,[status,setStatus]=useState<string|undefined>('open'),[selected,setSelected]=useState<string[]>([]),[detailId,setDetailId]=useState(''),[resolution,setResolution]=useState(''),[bulk,setBulk]=useState(false),[busy,setBusy]=useState(false),[savingRules,setSavingRules]=useState(false),[form]=Form.useForm()
  const [roomTag,setRoomTag]=useState<string|undefined>()
  const groups=useResource<Row[]>('/groups',[])
  const list=useResource<Row[]>(`/exceptions?${new URLSearchParams({...group?{group_id:group}:{},...status?{status}:{},...roomTag?{room_tag_id:roomTag}:{}})}`,[])
  const configuration=useResource<Record<string,any>>(group?`/groups/${group}/anomaly-rules`:null,{},{live:false})
  const details=useResource<any>(detailId?`/exceptions/${detailId}`:null,null)
  const {message}=App.useApp()
  useEffect(()=>{form.resetFields();if(group)form.setFieldsValue(configuration.data)},[configuration.data,group,form])
  async function resolve(ids:string[]) {
    if(!resolution.trim()){message.warning('请填写核查结论');return}
    setBusy(true)
    try{await send('/exceptions/resolve',{ids,resolution});setDetailId('');setBulk(false);setSelected([]);await list.reload();message.success('核查结论已保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}
  }
  const item=details.data?.exception
  return <Space direction="vertical" size={16} style={{width:'100%'}}>
    <Card title="异常与优秀卷" extra={<Button onClick={list.reload}>刷新</Button>}>
      <Space wrap style={{marginBottom:16}}>{!groupId && <HierarchyPicker allowClear placeholder="全部题卡组" value={group} onChange={value=>{setGroup(value);setSelected([])}}/>}<Select allowClear placeholder="全部状态" value={status} style={{width:150}} options={[{label:'待核查',value:'open'},{label:'已处理',value:'resolved'}]} onChange={value=>{setStatus(value);setSelected([])}}/><RoomTagPicker groupId={group} value={roomTag} onChange={value=>{setRoomTag(value);setSelected([])}}/><Button onClick={()=>download(`/exports/exceptions?${new URLSearchParams({...group?{group_id:group}:{},...status?{status}:{},...roomTag?{room_tag_id:roomTag}:{}})}`,'异常核查.csv').catch(e=>message.error(e.message))}>导出</Button><Button disabled={!selected.length} onClick={()=>{setBulk(true);setResolution('')}}>批量处理（{selected.length}）</Button></Space>
      {list.error&&<Alert type="error" message={list.error}/>}
      <Table rowKey="id" loading={list.loading} dataSource={list.data} rowSelection={{selectedRowKeys:selected,onChange:keys=>setSelected(keys.map(String))}} columns={[{title:'类型',dataIndex:'kind',render:value=>kinds[value]||value},{title:'题卡组',dataIndex:'group_id',render:id=>groups.data.find(g=>g.id===id)?.name||'—'},{title:'考场标签',render:(_,row)=><RoomTagBadges tags={row.room_tags}/>},{title:'说明',dataIndex:'reason'},{title:'状态',dataIndex:'status',render:value=><Tag color={value==='open'?'orange':'green'}>{value==='open'?'待核查':'已处理'}</Tag>},{title:'操作',render:(_,row)=><Button onClick={()=>{setDetailId(row.id);setResolution('')}}>查看与处理</Button>}]}/>
    </Card>
    {group&&<Card title="自动检查规则">
      <Typography.Paragraph type="secondary">规则用于提示人工核查，不修改识读结果或分数。保存后重新检查本题卡组已有答卷；关闭规则会结束该规则仍待核查的事项。</Typography.Paragraph>
      {configuration.error&&<Alert type="error" message={configuration.error}/>}
      <Form form={form} layout="vertical" onFinish={async value=>{setSavingRules(true);try{const result=await send<{checked_submissions:number}>(`/groups/${group}/anomaly-rules`,value,'PUT');await configuration.reload();await list.reload();message.success(`已检查 ${result.checked_submissions} 份答卷`)}catch(e){message.error((e as Error).message)}finally{setSavingRules(false)}}}>
        {Object.entries(rules).map(([key,label])=><Space key={key} align="start" wrap><Form.Item name={[key,'enabled']} label={label} valuePropName="checked"><Switch/></Form.Item>{key!=='invalid_single'&&<Form.Item name={[key,key==='blank_answers'?'min_count':'min_run']} label="达到此数量时提示" rules={[{required:true}]}><InputNumber min={key==='blank_answers'?1:2} max={10000}/></Form.Item>}</Space>)}
        <Button type="primary" htmlType="submit" loading={savingRules} disabled={configuration.loading || savingRules}>保存并重新检查</Button>
      </Form>
    </Card>}
    <Modal width={1000} title="查看与核查" open={!!detailId} onCancel={()=>setDetailId('')} confirmLoading={busy} onOk={()=>resolve([detailId])} okText="记录核查结论">
      {details.error&&<Alert type="error" message={details.error}/>}
      {!details.loading&&details.data&&<Space direction="vertical" style={{width:'100%'}}>
        <Descriptions column={2} items={Object.entries({考试:details.data.context.project,科目:details.data.context.subject,题卡组:details.data.context.group,考场备注:details.data.context.room,准考证号:details.data.context.candidate_number,姓名:details.data.context.student_name,类型:kinds[item.kind]||item.kind,说明:item.reason,原核查结论:item.resolution}).map(([label,value])=>({label,children:String(value||'—')}))}/>
        {item.evidence&&<Alert type="info" message="触发依据" description={<pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(item.evidence,null,2)}</pre>}/>}
        {details.data.answer_image_url&&<AssetImage src={details.data.answer_image_url}/>}
        <Tabs items={details.data.pages.map((page:Row)=>({key:page.id,label:`${page.side==='front'?'正面':'背面'} · 序号 ${page.sequence}`,children:<><Typography.Paragraph>识读选项：{Object.entries(page.selections).map(([number,answer])=>`第${number}题 ${(answer as string[]).join('、')||'空白'}`).join('；')||'无客观题记录'}</Typography.Paragraph><AssetImage src={page.image_url}/></>}))}/>
        <Typography.Paragraph type="secondary">需要修改考号、选项、补扫或答题区域时，请先在“扫描批次 → 纠正与补扫”保存更正，再记录核查结论。</Typography.Paragraph>
      </Space>}
      <Input.TextArea rows={3} value={resolution} onChange={e=>setResolution(e.target.value)} placeholder="填写核查结论与处理结果"/>
    </Modal>
    <Modal title={`批量处理 ${selected.length} 条事项`} open={bulk} onCancel={()=>setBulk(false)} confirmLoading={busy} onOk={()=>resolve(selected)}><Typography.Paragraph>为所选记录保存同一份核查结论。识读数据和分数需要在对应工作台另行更正。</Typography.Paragraph><Input.TextArea rows={4} value={resolution} onChange={e=>setResolution(e.target.value)} placeholder="填写共同的核查结论"/></Modal>
  </Space>
}
