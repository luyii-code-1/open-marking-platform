import { useState } from 'react'
import { Alert, App, Descriptions, Empty, Form, Input, Modal, Radio, Select, Space, Tabs, Tag } from 'antd'
import { Button } from './Button'
import { request, send, useResource, type Row, type Template } from './api'

export function TemplateLibrary({value,dirty,onCreated,groupId,disabled=false}:{value:Template;dirty:boolean;onCreated:(template:Template)=>void|Promise<void>;groupId?:string;disabled?:boolean}) {
  const library=useResource<Row[]>('/template-library',[]),groups=useResource<Row[]>('/groups',[]),subjects=useResource<Row[]>('/subjects',[]),projects=useResource<Row[]>('/projects',[])
  const teacherList=useResource<Row[]>('/teacher-templates',[])
  const users=useResource<Row[]>('/users',[])
  const [saveOpen,setSaveOpen]=useState(false),[useOpen,setUseOpen]=useState(false),[teacherOpen,setTeacherOpen]=useState(false),[assignOpen,setAssignOpen]=useState(false),[pending,setPending]=useState(''),[selected,setSelected]=useState(''),[target,setTarget]=useState('group'),[saveForm]=Form.useForm(),[useForm]=Form.useForm(),[assignForm]=Form.useForm()
  const [teacherMode,setTeacherMode]=useState<'link'|'list'>('link')
  const [linkText,setLinkText]=useState('')
  const [linkEntry,setLinkEntry]=useState<Row|null>(null)
  const [selectedTeacherId,setSelectedTeacherId]=useState('')
  const [adoptTarget,setAdoptTarget]=useState('group')
  const [adoptGroupId,setAdoptGroupId]=useState('')
  const [adoptSubjectId,setAdoptSubjectId]=useState('')
  const [adoptName,setAdoptName]=useState('')
  const statistics=!!value.statistics_mode
  const busy=!!pending
  const compatibleEntries=library.data.filter(row => statistics
    ? !row.definition.questions.some((q: Row) => q.type==='subjective')
    : !row.definition.statistics_mode)
  const {message}=App.useApp(),entry=compatibleEntries.find(row=>row.id===selected)
  async function save(values:Record<string,string>){if(busy)return;setPending('save');try{await send(`/templates/${value.id}/save-to-library`,values);await library.reload();setSaveOpen(false);message.success('版式快照已保存到题卡库')}catch(e){message.error((e as Error).message)}finally{setPending('')}}
  async function create(values:Record<string,string>){if(busy)return;setPending('create');try{const created=await send<Template>(`/template-library/${values.entry_id}/instantiate`,{...(groupId?{group_id:groupId}:target==='group'?{group_id:values.group_id}:{subject_id:values.subject_id}),...(values.name?.trim()?{name:values.name.trim()}:{})});setUseOpen(false);await onCreated(created);message.success('已从题卡库建立新草稿')}catch(e){message.error((e as Error).message)}finally{setPending('')}}
  async function lookupLink(){
    if(!linkText.trim()||busy)return
    setPending('lookup')
    try{
      const found=await request<Row>(`/teacher-templates/by-link?link=${encodeURIComponent(linkText.trim())}`)
      setLinkEntry(found)
      if(!adoptName)setAdoptName(found.name||'')
    }catch(e){setLinkEntry(null);message.error((e as Error).message)}
    finally{setPending('')}
  }
  const activeTeacherEntry=teacherMode==='link'?linkEntry:teacherList.data.find(r=>r.id===selectedTeacherId)
  async function adoptTeacher(){
    if(!activeTeacherEntry||busy)return
    if(!groupId&&(adoptTarget==='group'?!adoptGroupId:!adoptSubjectId)){message.warning('请选择目标题卡或科目');return}
    setPending('adopt')
    try{
      const res=await send<{template:Template}>(`/teacher-templates/${activeTeacherEntry.id}/adopt`,{
        ...(groupId?{group_id:groupId}:adoptTarget==='group'?{group_id:adoptGroupId}:{subject_id:adoptSubjectId}),
        ...(adoptName.trim()?{name:adoptName.trim()}:{}),
      })
      setTeacherOpen(false)
      await onCreated(res.template)
      message.success('已导入教师独立题卡为草稿，可编辑答案和内容后审查发布')
    }catch(e){message.error((e as Error).message)}
    finally{setPending('')}
  }
  const groupLocked=!!groupId&&!!groups.data.find(g=>g.id===groupId)?.frozen
  async function assignTask(values:{teacher_id:string;name?:string;description?:string}){
    const targetGroup=groupId||value.group_id
    if(!targetGroup||busy)return
    setPending('assign')
    try{
      const created=await send<Row>('/teacher-templates/assign',{group_id:targetGroup,teacher_id:values.teacher_id,name:values.name?.trim()||undefined,description:values.description?.trim()||''})
      setAssignOpen(false)
      assignForm.resetFields()
      message.success(`已向 ${created.owner_name} 创建并下发任务题卡，对方将在教师端通知中收到一键入口`)
    }catch(e){message.error((e as Error).message)}
    finally{setPending('')}
  }
  return <>
    <Button disabled={disabled||groupLocked} onClick={()=>{setUseOpen(true);void library.reload();void groups.reload();void subjects.reload();void projects.reload()}}>从题卡库创建</Button>
    {!statistics && <Button disabled={disabled||groupLocked} onClick={()=>{setTeacherOpen(true);setLinkText('');setLinkEntry(null);setSelectedTeacherId('');setAdoptName('');void teacherList.reload();void groups.reload();void subjects.reload();void projects.reload()}}>导入教师题卡 / 链接</Button>}
    {!statistics&&(groupId||value.group_id)&&<Button disabled={disabled||groupLocked} onClick={()=>{assignForm.setFieldsValue({name:value.name||'',description:''});setAssignOpen(true);void users.reload()}}>创建任务题卡</Button>}
    <Button disabled={disabled||!value.id||dirty} onClick={()=>{saveForm.setFieldsValue({name:value.name,description:''});setSaveOpen(true)}}>存入题卡库</Button>
    <Modal title="创建任务题卡（分配给教师）" open={assignOpen} onCancel={()=>!busy&&setAssignOpen(false)} onOk={()=>assignForm.submit()} confirmLoading={pending==='assign'} okText="创建并分配">
      <Alert type="info" showIcon style={{marginBottom:14}} message="创建后将分配到指定教师账号，对方教师端通知中心会显示一键进入制卡入口；制作完成后可保存、复制内部链接或推送给管理员审核。"/>
      <Form form={assignForm} layout="vertical" onFinish={assignTask}>
        <Form.Item name="teacher_id" label="分配给教师" rules={[{required:true,message:'请选择接收教师'}]}>
          <Select showSearch optionFilterProp="label" placeholder="搜索教师姓名或账号" options={users.data.map(u=>({value:u.id,label:`${u.name}（${u.username}）`}))}/>
        </Form.Item>
        <Form.Item name="name" label="任务题卡标题（选填）"><Input maxLength={100} placeholder="留空自动按考试科目命名"/></Form.Item>
        <Form.Item name="description" label="制卡要求说明（选填）"><Input.TextArea rows={3} maxLength={2000} placeholder="可注明题量、分值、纸张大小或截稿时间"/></Form.Item>
      </Form>
    </Modal>
    <Modal title="存入题卡库" open={saveOpen} onCancel={()=>!busy&&setSaveOpen(false)} onOk={()=>saveForm.submit()} confirmLoading={pending==='save'}>
      <Alert type="info" message="保存当前已同步的版式快照，之后可用于其他考试。" style={{marginBottom:16}}/>
      <Form form={saveForm} layout="vertical" onFinish={save}><Form.Item name="name" label="库内名称" rules={[{required:true,whitespace:true}]}><Input maxLength={100}/></Form.Item><Form.Item name="description" label="适用说明"><Input.TextArea rows={3} maxLength={2000}/></Form.Item></Form>
    </Modal>
    <Modal title="从题卡库创建" open={useOpen} onCancel={()=>!busy&&setUseOpen(false)} onOk={()=>useForm.submit()} confirmLoading={pending==='create'} okButtonProps={{disabled:!compatibleEntries.length}}>
      {library.error&&<Alert type="error" message={library.error}/>}
      {!compatibleEntries.length?<Empty description="先将已保存题卡存入题卡库"/>:<Form form={useForm} layout="vertical" onFinish={create}>
        <Form.Item name="entry_id" label="选择版式" rules={[{required:true,message:'请选择版式'}]}><Select showSearch optionFilterProp="label" options={compatibleEntries.map(row=>({label:row.name,value:row.id}))} onChange={setSelected}/></Form.Item>
        {entry&&<Descriptions size="small" column={1} style={{marginBottom:16}} items={[{label:'版面',children:`${entry.definition.paper} · ${entry.definition.sides===2?'双面':'单面'} · ${entry.definition.questions.length}题`},{label:'说明',children:entry.description||'—'}]}/>}
        {!groupId && <><Form.Item label="目标分组"><Radio.Group value={target} onChange={e=>setTarget(e.target.value)} options={[{label:'选择题卡',value:'group'},{label:'按科目使用Default',value:'subject'}]}/></Form.Item>
        {target==='group'?<Form.Item name="group_id" label="所属题卡" rules={[{required:true,message:'请选择题卡'}]}><Select showSearch optionFilterProp="label" options={groups.data.filter(g=>!g.frozen).map(g=>{const s=subjects.data.find(s=>s.id===g.subject_id);return{value:g.id,label:`${projects.data.find(p=>p.id===s?.project_id)?.name||''} / ${s?.name||''} / ${g.name}${g.template_id?'（已有题卡）':''}`}})}/></Form.Item>:<Form.Item name="subject_id" label="所属科目" rules={[{required:true,message:'请选择科目'}]}><Select showSearch optionFilterProp="label" options={subjects.data.map(s=>({value:s.id,label:`${projects.data.find(p=>p.id===s.project_id)?.name||''} / ${s.name}`}))}/></Form.Item>}
        </>}<Form.Item name="name" label="新题卡标题"><Input placeholder={entry?.name||'沿用库内名称'} maxLength={100}/></Form.Item>
        <Alert type="info" message={statistics ? "创建独立草稿，可继续编辑版式和选项，再审查发布。" : "创建独立草稿，选择后可继续设置答案和版式，再审查发布。"}/>
      </Form>}
    </Modal>
    <Modal title="导入教师独立题卡或内部链接" open={teacherOpen} onCancel={()=>!busy&&setTeacherOpen(false)} onOk={()=>void adoptTeacher()} confirmLoading={pending==='adopt'} okButtonProps={{disabled:!activeTeacherEntry}} okText="导入为题卡草稿" width={620}>
      <Space direction="vertical" size={12} style={{width:'100%'}}>
        <Tabs activeKey={teacherMode} onChange={k=>setTeacherMode(k as 'link'|'list')} items={[
          {
            key:'link',
            label:'粘贴内部链接',
            children:<Space direction="vertical" size={10} style={{width:'100%'}}>
              <Space.Compact style={{width:'100%'}}>
                <Input placeholder="粘贴教师提供的内部链接（omp-tpl:...）" value={linkText} onChange={e=>setLinkText(e.target.value)} onPressEnter={()=>void lookupLink()}/>
                <Button type="primary" loading={pending==='lookup'} onClick={()=>void lookupLink()}>解析链接</Button>
              </Space.Compact>
            </Space>,
          },
          {
            key:'list',
            label:`从教师列表选择（${teacherList.data.length}）`,
            children:<Select showSearch optionFilterProp="label" style={{width:'100%'}} placeholder="选择教师制作或提交的独立题卡" value={selectedTeacherId||undefined} onChange={v=>{setSelectedTeacherId(v);const found=teacherList.data.find(r=>r.id===v);if(found&&!adoptName)setAdoptName(found.name||'')}} options={teacherList.data.map(r=>({value:r.id,label:`${r.name} · ${r.owner_name}${r.subject_name?'（'+r.subject_name+'）':''} [${r.status==='submitted'?'待审核':r.status==='approved'?'已采用':r.status==='rejected'?'已退回':'草稿'}]`} ))}/>,
          },
        ]}/>
        {activeTeacherEntry&&<Descriptions size="small" column={2} bordered items={[
          {label:'标题',children:activeTeacherEntry.name},
          {label:'制作教师',children:activeTeacherEntry.owner_name},
          {label:'学科 / 状态',children:<Space size={4}><span>{activeTeacherEntry.subject_name||'—'}</span><Tag>{activeTeacherEntry.status==='submitted'?'待审核':activeTeacherEntry.status==='approved'?'已采用':activeTeacherEntry.status==='rejected'?'已退回':'草稿'}</Tag></Space>},
          {label:'题数 / 总分',children:`${activeTeacherEntry.question_count??activeTeacherEntry.definition?.questions?.length??0} 题 · ${activeTeacherEntry.total_points??0} 分`},
        ]}/>}
        {!groupId&&<>
          <Radio.Group value={adoptTarget} onChange={e=>setAdoptTarget(e.target.value)} options={[{label:'选择题卡',value:'group'},{label:'按科目使用Default',value:'subject'}]}/>
          {adoptTarget==='group'?<Select showSearch optionFilterProp="label" placeholder="所属题卡" value={adoptGroupId||undefined} onChange={setAdoptGroupId} options={groups.data.filter(g=>!g.frozen).map(g=>{const s=subjects.data.find(s=>s.id===g.subject_id);return{value:g.id,label:`${projects.data.find(p=>p.id===s?.project_id)?.name||''} / ${s?.name||''} / ${g.name}${g.template_id?'（已有题卡）':''}`}})}/>:<Select showSearch optionFilterProp="label" placeholder="所属科目" value={adoptSubjectId||undefined} onChange={setAdoptSubjectId} options={subjects.data.map(s=>({value:s.id,label:`${projects.data.find(p=>p.id===s.project_id)?.name||''} / ${s.name}`}))}/>}
        </>}
        <Input value={adoptName} onChange={e=>setAdoptName(e.target.value)} placeholder={activeTeacherEntry?.name||'导入后的题卡标题（留空沿用原标题）'} maxLength={100}/>
        <Alert type="info" message="导入后可在后台编辑全部内容（含标准答案、分值、题区、底图），确认无误后再审查发布。"/>
      </Space>
    </Modal>
  </>
}
