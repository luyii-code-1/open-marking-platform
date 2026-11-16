import {useState} from 'react'
import {Alert,App,Form,Modal,Progress,Radio,Space,Tag,Typography} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {RecordPicker,type FilterField} from './RecordPicker'
import {useResource,send,request,type Row,type Question,type Template} from './api'
import {questionLabel} from './mergeQuestions'

export function ReviewAllocation({templateId,frozen}:{templateId:string;frozen:boolean}){
  const templates=useResource<Template[]>('/templates',[]),users=useResource<Row[]>('/users',[])
  const assignments=useResource<Row[]>('/assignments',[]),summary=useResource<Row[]>(`/review-allocation-progress?template_id=${templateId}`,[])
  const classes=useResource<Row[]>('/classes',[]),grades=useResource<Row[]>('/grades',[])
  const questions=templates.data.find(t=>t.id===templateId)?.questions.filter(q=>q.type==='subjective')||[]
  const [editing,setEditing]=useState<Question|null>(null),[saving,setSaving]=useState(false),[pool,setPool]=useState<'user_ids'|'arbitrator_ids'|null>(null)
  const [form]=Form.useForm(),{message}=App.useApp()
  const graders:string[]=Form.useWatch('user_ids',form)||[],arbiters:string[]=Form.useWatch('arbitrator_ids',form)||[]
  const teacherLabel=(u:Row)=>u.name+'（'+u.username+'）'
  const assignment=(q:Question)=>assignments.data.find(a=>a.template_id===templateId&&a.question_id===q.id)
  const gradeNames=new Map(grades.data.map(g=>[g.id,g.name]))
  const relationClasses=(u:Row)=>classes.data.filter(c=>c.teacher_ids?.includes(u.id)||c.teaching?.[u.id])
  const subjects=(u:Row)=>[...new Set<string>(relationClasses(u).flatMap(c=>c.teaching?.[u.id]?.subjects||[]))]
  const fields:FilterField<Row>[]=[
    {key:'grades',label:'任教年级',options:grades.data.map(g=>({value:g.id,label:g.name})),values:u=>relationClasses(u).map(c=>c.grade_id||c.grade).filter(Boolean)},
    {key:'subjects',label:'任教科目',options:[...new Set<string>(users.data.flatMap(subjects))].sort().map(value=>({value,label:value})),values:subjects},
    {key:'classes',label:'行政班',options:classes.data.map(c=>({value:c.id,label:[gradeNames.get(c.grade_id)||c.grade,c.name].filter(Boolean).join(' · ')})),values:u=>relationClasses(u).map(c=>c.id)},
    {key:'homeroom',label:'班主任',options:[{value:'yes',label:'班主任'}],values:u=>relationClasses(u).some(c=>c.teaching?.[u.id]?.homeroom)?['yes']:[]}
  ]
  function edit(q:Question){
    const a=assignment(q);setPool(null);form.resetFields()
    form.setFieldsValue({user_ids:a?.user_ids||[],arbitrator_ids:a&&(a.arbitration_mode==='random'||(!a.arbitration_mode&&!a.arbitrator_ids?.length))&&q.review_mode==='double'?a.user_ids:a?.arbitrator_ids||[]})
    setEditing(q)
  }
  async function save(){
    const v=await form.validateFields();if(!editing)return
    setSaving(true)
    try{
      const ids:string[]=v.user_ids,arbIds:string[]=editing.review_mode==='double'?v.arbitrator_ids||[]:[]
      await send('/assignments',{template_id:templateId,question_id:editing.id,user_ids:ids,weights:Object.fromEntries(ids.map(id=>[id,assignment(editing)?.weights?.[id]===0?0:1])),arbitration_mode:'weighted',arbitrator_ids:arbIds,arbitrator_weights:Object.fromEntries(arbIds.map(id=>[id,assignment(editing)?.arbitrator_weights?.[id]===0?0:1]))})
      await Promise.all([assignments.reload(),summary.reload()]);setEditing(null);message.success('分配已保存')
    }catch(e){message.error((e as Error).message)}finally{setSaving(false)}
  }
  const poolTags=(ids:string[]=[],weights:Record<string,number>={})=>ids.length?ids.map(id=><Tag key={id}>{users.data.find(u=>u.id===id)?.name||id}{weights[id]===0?'（暂停）':''}</Tag>):'待分配'
  const progressRows=summary.data.flatMap(q=>(q.teachers||[]).map((teacher:Row)=>({...teacher,id:q.question_id+':'+teacher.user_id,question_id:q.question_id})))
  const error=templates.error||assignments.error||users.error||summary.error
  function poolField(name:'user_ids'|'arbitrator_ids',label:string,ids:string[]){return <Form.Item label={label} required><Form.Item name={name} hidden rules={[{required:true,type:'array',min:1,message:'请选择'+label+'教师'}]}><input/></Form.Item><Space wrap>{ids.map(id=><Tag key={id} closable onClose={()=>form.setFieldValue(name,ids.filter(value=>value!==id))}>{users.data.find(u=>u.id===id)?.name||id}</Tag>)}<Button onClick={()=>setPool(name)}>选择教师</Button></Space></Form.Item>}
  return <><Space direction="vertical" size={20} style={{width:'100%'}}>{error&&<Alert type="error" message={error}/>}
    <Radio.Group value="equal" aria-label="分配模式"><Radio.Button value="equal">按题等量分配</Radio.Button><Radio.Button value="whole" disabled>单一批卷</Radio.Button></Radio.Group>
    <Typography.Text type="secondary">各题在阅卷池中等量分配。调整教师后，已完成和正在评阅的答卷保留，其余答卷重新分配。</Typography.Text>
    <Table<Question> rowKey="id" dataSource={questions} loading={!templates.loaded||!assignments.loaded} locale={{emptyText:'当前题卡没有主观题'}} columns={[
      {title:'题目',render:(_,q)=>'第 '+questionLabel(q)+' 题'},
      {title:'评阅方式',render:(_,q)=>q.review_mode==='double'?'双评':'单评'},
      {title:'阅卷池',render:(_,q)=>poolTags(assignment(q)?.user_ids,assignment(q)?.weights)},
      {title:'仲裁池',render:(_,q)=>{const a=assignment(q);return q.review_mode==='double'?poolTags(a?.arbitration_mode==='random'?a.user_ids:a?.arbitrator_ids,a?.arbitrator_weights):'—'}},
      {title:'操作',render:(_,q)=><Button disabled={frozen||!users.loaded||!!error} onClick={()=>edit(q)}>分配教师</Button>}
    ]}/>
    <div><Space style={{marginBottom:12}}><Typography.Text strong>教师任务与进度</Typography.Text><Button size="small" onClick={()=>summary.reload()}>刷新进度</Button></Space><Table<Row> rowKey="id" dataSource={progressRows} loading={summary.loading} locale={{emptyText:'保存教师分配后显示任务进度'}} columns={[
      {title:'题目',render:(_,r)=>'第 '+questionLabel(questions.find(q=>q.id===r.question_id)||{number:0} as Question)+' 题'},
      {title:'教师',render:(_,r)=>users.data.find(u=>u.id===r.user_id)?.name||r.user_id},
      {title:'阅卷',render:(_,r)=>`${r.ordinary_completed} / ${r.ordinary_total} 份`},
      {title:'仲裁',render:(_,r)=>`${r.arbitration_completed} / ${r.arbitration_total} 份`},
      {title:'进度',render:(_,r)=>{const total=r.ordinary_total+r.arbitration_total,done=r.ordinary_completed+r.arbitration_completed;return <Progress percent={total?Math.round(done/total*100):0} size="small" style={{minWidth:140}}/>}}
    ]}/></div></Space>
    <Modal width={760} forceRender title={editing?'第 '+questionLabel(editing)+' 题 · 分配教师':'分配教师'} open={!!editing} onCancel={()=>!saving&&setEditing(null)} confirmLoading={saving} okText="保存分配" onOk={save}>
      <Form layout="vertical" form={form} preserve={false}>{poolField('user_ids','阅卷池',graders)}{editing?.review_mode==='double'&&poolField('arbitrator_ids','仲裁池',arbiters)}</Form>
    </Modal>
    <RecordPicker<Row> open={!!pool&&!!editing} onClose={()=>setPool(null)} title={pool==='arbitrator_ids'?'选择仲裁教师':'选择阅卷教师'} records={users.data} value={pool==='arbitrator_ids'?arbiters:graders} onChange={ids=>pool&&form.setFieldValue(pool,ids)} label={teacherLabel} fields={fields} loading={users.loading||classes.loading||grades.loading}
      columns={[{title:'姓名',dataIndex:'name'},{title:'账号',dataIndex:'username'},{title:'任教科目',render:(_,u)=>subjects(u).join('、')||'—'},{title:'任教班级',render:(_,u)=>relationClasses(u).map(c=>[gradeNames.get(c.grade_id)||c.grade,c.name].filter(Boolean).join(' · ')).join('、')||'—'}]}
      importer={{templateUrl:'/selection/users/template',templateName:'教师选择模板.xlsx',upload:async file=>{const body=new FormData();body.append('file',file);return (await request<{ids:string[]}>('/selection/users/match',{method:'POST',body})).ids}}}/>
  </>
}
