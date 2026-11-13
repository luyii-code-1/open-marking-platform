import { useState } from 'react'
import { Alert, App, Descriptions, Empty, Form, Input, Modal, Radio, Select, Space } from 'antd'
import { Button } from './Button'
import { send, useResource, type Row, type Template } from './api'

export function TemplateLibrary({value,dirty,onCreated,groupId,disabled=false}:{value:Template;dirty:boolean;onCreated:(template:Template)=>void|Promise<void>;groupId?:string;disabled?:boolean}) {
  const library=useResource<Row[]>('/template-library',[]),groups=useResource<Row[]>('/groups',[]),subjects=useResource<Row[]>('/subjects',[]),projects=useResource<Row[]>('/projects',[])
  const [saveOpen,setSaveOpen]=useState(false),[useOpen,setUseOpen]=useState(false),[pending,setPending]=useState(''),[selected,setSelected]=useState(''),[target,setTarget]=useState('group'),[saveForm]=Form.useForm(),[useForm]=Form.useForm()
  const busy=!!pending
  const {message}=App.useApp(),entry=library.data.find(row=>row.id===selected)
  async function save(values:Record<string,string>){if(busy)return;setPending('save');try{await send(`/templates/${value.id}/save-to-library`,values);await library.reload();setSaveOpen(false);message.success('版式快照已保存到题卡库')}catch(e){message.error((e as Error).message)}finally{setPending('')}}
  async function create(values:Record<string,string>){if(busy)return;setPending('create');try{const created=await send<Template>(`/template-library/${values.entry_id}/instantiate`,{...(groupId?{group_id:groupId}:target==='group'?{group_id:values.group_id}:{subject_id:values.subject_id}),...(values.name?.trim()?{name:values.name.trim()}:{})});setUseOpen(false);await onCreated(created);message.success('已从题卡库建立新草稿')}catch(e){message.error((e as Error).message)}finally{setPending('')}}
  return <>
    <Button disabled={disabled||!!groupId&&!!groups.data.find(g=>g.id===groupId)?.template_id} onClick={()=>{setUseOpen(true);void library.reload();void groups.reload();void subjects.reload();void projects.reload()}}>从题卡库创建</Button>
    <Button disabled={disabled||!value.id||dirty} onClick={()=>{saveForm.setFieldsValue({name:value.name,description:''});setSaveOpen(true)}}>存入题卡库</Button>
    <Modal title="存入题卡库" open={saveOpen} onCancel={()=>!busy&&setSaveOpen(false)} onOk={()=>saveForm.submit()} confirmLoading={pending==='save'}>
      <Alert type="info" message="保存当前已同步的版式快照，之后可用于其他考试。" style={{marginBottom:16}}/>
      <Form form={saveForm} layout="vertical" onFinish={save}><Form.Item name="name" label="库内名称" rules={[{required:true,whitespace:true}]}><Input maxLength={100}/></Form.Item><Form.Item name="description" label="适用说明"><Input.TextArea rows={3} maxLength={2000}/></Form.Item></Form>
    </Modal>
    <Modal title="从题卡库创建" open={useOpen} onCancel={()=>!busy&&setUseOpen(false)} onOk={()=>useForm.submit()} confirmLoading={pending==='create'} okButtonProps={{disabled:!library.data.length}}>
      {library.error&&<Alert type="error" message={library.error}/>}
      {!library.data.length?<Empty description="先将已保存题卡存入题卡库"/>:<Form form={useForm} layout="vertical" onFinish={create}>
        <Form.Item name="entry_id" label="选择版式" rules={[{required:true,message:'请选择版式'}]}><Select showSearch optionFilterProp="label" options={library.data.map(row=>({label:row.name,value:row.id}))} onChange={setSelected}/></Form.Item>
        {entry&&<Descriptions size="small" column={1} style={{marginBottom:16}} items={[{label:'版面',children:`${entry.definition.paper} · ${entry.definition.sides===2?'双面':'单面'} · ${entry.definition.questions.length}题`},{label:'说明',children:entry.description||'—'}]}/>}
        {!groupId && <><Form.Item label="目标分组"><Radio.Group value={target} onChange={e=>setTarget(e.target.value)} options={[{label:'选择题卡',value:'group'},{label:'按科目使用Default',value:'subject'}]}/></Form.Item>
        {target==='group'?<Form.Item name="group_id" label="所属题卡" rules={[{required:true,message:'请选择题卡'}]}><Select showSearch optionFilterProp="label" options={groups.data.filter(g=>!g.frozen&&!g.template_id).map(g=>{const s=subjects.data.find(s=>s.id===g.subject_id);return{value:g.id,label:`${projects.data.find(p=>p.id===s?.project_id)?.name||''} / ${s?.name||''} / ${g.name}${g.template_id?'（已有题卡）':''}`}})}/></Form.Item>:<Form.Item name="subject_id" label="所属科目" rules={[{required:true,message:'请选择科目'}]}><Select showSearch optionFilterProp="label" options={subjects.data.map(s=>({value:s.id,label:`${projects.data.find(p=>p.id===s.project_id)?.name||''} / ${s.name}`}))}/></Form.Item>}
        </>}<Form.Item name="name" label="新题卡标题"><Input placeholder={entry?.name||'沿用库内名称'} maxLength={100}/></Form.Item>
        <Alert type="info" message="创建独立草稿，选择后可继续设置答案和版式，再审查发布。"/>
      </Form>}
    </Modal>
  </>
}
