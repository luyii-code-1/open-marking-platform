import {useState} from 'react'
import {App,Form,Input,InputNumber,Modal,Select,Space,Typography} from 'antd'
import {Button} from './Button'
import {send,type Row} from './api'

type Option={value:string;label:string}
export function RoomBatch({projectId,groupId,options,tags,reload}:{projectId:string;groupId?:string;options:Option[];tags:Row[];reload:()=>Promise<unknown>}){
  const [open,setOpen]=useState(false),[group,setGroup]=useState<string>(),[busy,setBusy]=useState(false)
  const [pattern,setPattern]=useState('第{n:02}考场'),[first,setFirst]=useState<number|null>(1),[last,setLast]=useState<number|null>(30)
  const [text,setText]=useState(''),[expected,setExpected]=useState<number|null>(0),{message}=App.useApp()
  const names=text.split(/\r?\n/).map(n=>n.trim()).filter(Boolean)
  const known=new Set(tags.filter(t=>t.group_id===group).map(t=>t.name))
  const duplicates=names.filter(name=>{if(known.has(name))return true;known.add(name);return false})
  function generate(){
    if(first===null||last===null||last<first||last-first>=500||!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<0){message.warning('请输入最多 500 个连续编号');return}
    const token=/\{n(?::0([1-9]))?\}/g
    if(!pattern.match(token)){message.warning('模板需包含 {n} 或 {n:02}');return}
    setText(Array.from({length:last-first+1},(_,i)=>pattern.replace(token,(_,width)=>String(first+i).padStart(Number(width)||1,'0'))).join('\n'))
  }
  async function save(){
    setBusy(true)
    try{
      const result=await send('/projects/'+projectId+'/room-tags/batch',{group_id:group,expected_students:expected,names})
      message.success('已创建 '+result.created+' 个考场，跳过 '+result.skipped.length+' 个重名项')
      setOpen(false);await reload()
    }catch(e){message.error((e as Error).message)}finally{setBusy(false)}
  }
  return <><Button disabled={!options.length} onClick={()=>{setGroup(groupId??(options.length===1?options[0].value:undefined));setText('');setOpen(true)}}>批量添加</Button>
    <Modal title="批量添加考场" open={open} onCancel={()=>!busy&&setOpen(false)} onOk={save} okText="创建考场" confirmLoading={busy} okButtonProps={{disabled:!group||expected===null||names.length>500||names.some(n=>n.length>60)||names.length===duplicates.length}}>
      <Form layout="vertical"><Form.Item label="所属题卡"><Select value={group} options={options} onChange={setGroup} disabled={!!groupId}/></Form.Item>
        <Form.Item label="每个考场预期人数"><InputNumber min={0} max={100000} precision={0} value={expected} onChange={setExpected}/></Form.Item>
        <Form.Item label="按编号生成"><Space wrap><Input aria-label="命名模板" value={pattern} onChange={e=>setPattern(e.target.value)}/><InputNumber aria-label="起始编号" min={0} precision={0} value={first} onChange={setFirst}/> 至 <InputNumber aria-label="结束编号" min={0} precision={0} value={last} onChange={setLast}/><Button onClick={generate}>生成名单</Button></Space></Form.Item>
        <Form.Item label="考场名单"><Input.TextArea rows={6} placeholder="每行一个考场，可直接粘贴或修改生成的名单" value={text} onChange={e=>setText(e.target.value)}/></Form.Item>
        <Typography.Text>待创建 {names.length-duplicates.length} 个{duplicates.length>0&&'，跳过重名：'+[...new Set(duplicates)].join('、')}</Typography.Text>
        {(names.length>500||names.some(n=>n.length>60))&&<Typography.Text type="danger">每批最多 500 个，每个名称最多 60 字。</Typography.Text>}
      </Form>
    </Modal></>
}
