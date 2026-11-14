import {useState} from 'react'
import {Alert,App,Checkbox,Form,InputNumber,Modal,Select,Space,Tag} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {useResource,send,type Row,type Question,type Template} from './api'
import {emptyTeacherFilter,matchingTeachers,type TeacherFilter} from './teacherFilter'
import {questionLabel} from './mergeQuestions'

export function ReviewAllocation({templateId,frozen}:{templateId:string;frozen:boolean}){
  const templates=useResource<Template[]>('/templates',[]),users=useResource<Row[]>('/users',[])
  const assignments=useResource<Row[]>('/assignments',[])
  const questions=templates.data.find(t=>t.id===templateId)?.questions.filter(q=>q.type==='subjective')||[]
  const [editing,setEditing]=useState<Question|null>(null),[saving,setSaving]=useState(false)
  const [form]=Form.useForm(),{message}=App.useApp()
  const graders:string[]=Form.useWatch('user_ids',form)||[]
  const arbiters:string[]=Form.useWatch('arbitrator_ids',form)||[]
  const classes=useResource<Row[]>(editing?'/classes':null,[])
  const grades=useResource<Row[]>(editing?'/grades':null,[])
  const [filter,setFilter]=useState<TeacherFilter>(emptyTeacherFilter)
  const candidates=matchingTeachers(users.data,classes.data,filter)
  const teacherLabel=(u:Row)=>u.name+'（'+u.username+'）'
  const poolOptions=(selected:string[])=>users.data.filter(u=>selected.includes(u.id)||candidateIds.has(u.id)).map(u=>({label:teacherLabel(u),value:u.id}))
  const candidateIds=new Set(candidates.map(u=>u.id))
  const gradeNames=new Map(grades.data.map(g=>[g.id,g.name]))
  const availableGrades=new Map(classes.data.map(c=>[c.grade_id||c.grade,gradeNames.get(c.grade_id)||c.grade||c.grade_name]))
  const availableSubjects=new Set<string>(classes.data.flatMap(c=>Object.values(c.teaching||{}).flatMap(r=>(r as {subjects?:string[]}).subjects||[])))
  function addCandidates(field:'user_ids'|'arbitrator_ids'){
    const selected:string[]=form.getFieldValue(field)||[]
    form.setFieldValue(field,[...new Set([...selected,...candidateIds])])
  }
  const assignment=(q:Question)=>assignments.data.find(a=>a.template_id===templateId&&a.question_id===q.id)
  const names=(ids:string[]=[])=>ids.length?ids.map(id=><Tag key={id}>{users.data.find(u=>u.id===id)?.name||id}</Tag>):'待分配'
  function edit(q:Question){
    const a=assignment(q)
    setFilter(emptyTeacherFilter)
    form.resetFields()
    form.setFieldsValue({user_ids:a?.user_ids||[],weights:a?.weights||{},arbitrator_ids:a&&(a.arbitration_mode==='random'||(!a.arbitration_mode&&!a.arbitrator_ids?.length))&&q.review_mode==='double'?a.user_ids:a?.arbitrator_ids||[],arbitrator_weights:a?.arbitrator_weights||{}})
    setEditing(q)
  }
  async function save(){
    const v=await form.validateFields()
    if(!editing)return
    setSaving(true)
    try{
      const arbIds:string[]=v.arbitrator_ids||[]
      await send('/assignments',{template_id:templateId,question_id:editing.id,user_ids:v.user_ids,weights:Object.fromEntries(v.user_ids.map((id:string)=>[id,v.weights?.[id]??1])),arbitration_mode:'weighted',arbitrator_ids:arbIds,arbitrator_weights:Object.fromEntries(arbIds.map(id=>[id,v.arbitrator_weights?.[id]??1]))})
      await assignments.reload();setEditing(null);message.success('分配已保存')
    }catch(e){message.error((e as Error).message)}finally{setSaving(false)}
  }
  const error=templates.error||assignments.error||users.error
  return <><Space direction="vertical" style={{width:'100%'}}>{error&&<Alert type="error" message={error}/>}
    <Table<Question> rowKey="id" dataSource={questions} loading={!templates.loaded||!assignments.loaded} locale={{emptyText:'当前题卡没有主观题'}} columns={[
      {title:'题目',render:(_,q)=>'第 '+questionLabel(q)+' 题'},
      {title:'评阅方式',render:(_,q)=>q.review_mode==='double'?'双评':'单评'},
      {title:'阅卷池',render:(_,q)=>names(assignment(q)?.user_ids)},
      {title:'仲裁池',render:(_,q)=>{const a=assignment(q);return a&&q.review_mode==='double'&&(a.arbitration_mode==='random'||(!a.arbitration_mode&&!a.arbitrator_ids?.length))?names(a.user_ids):a?.arbitrator_ids?.length?names(a.arbitrator_ids):q.review_mode==='double'?'待分配':'未设置'}},
      {title:'操作',render:(_,q)=><Button disabled={frozen||!users.loaded||!!error} onClick={()=>edit(q)}>分配教师</Button>}
    ]}/></Space>
    <Modal width={720} forceRender title={editing?'第 '+questionLabel(editing)+' 题 · 分配教师':'分配教师'} open={!!editing} onCancel={()=>setEditing(null)} confirmLoading={saving} okText="保存分配" onOk={save}>
      <Form layout="vertical" form={form} preserve={false}>
        <Form.Item label="筛选教师">
          <Space wrap>
            <Select aria-label="任教年级" mode="multiple" allowClear placeholder="任教年级" style={{minWidth:140}} value={filter.grades} options={[...availableGrades].filter(([id])=>id).map(([value,label])=>({value,label}))} optionFilterProp="label" onChange={values=>setFilter({...filter,grades:values})}/>
            <Select aria-label="任教科目" mode="multiple" allowClear placeholder="任教科目" style={{minWidth:140}} value={filter.subjects} options={[...availableSubjects].sort().map(value=>({value}))} onChange={values=>setFilter({...filter,subjects:values})}/>
            <Select aria-label="行政班" mode="multiple" allowClear placeholder="行政班" style={{minWidth:140}} value={filter.classes} options={classes.data.map(c=>({value:c.id,label:[gradeNames.get(c.grade_id)||c.grade,c.name].filter(Boolean).join(' · ')}))} optionFilterProp="label" onChange={values=>setFilter({...filter,classes:values})}/>
            <Checkbox checked={filter.homeroom} onChange={e=>setFilter({...filter,homeroom:e.target.checked})}>班主任</Checkbox>
          </Space>
        </Form.Item>
        {(classes.error||grades.error)&&<Alert type="error" message={classes.error||grades.error}/>}
        <Form.Item><Space wrap><span>匹配 {candidates.length} 人</span>
          <Button disabled={!candidates.length||!classes.loaded||!!classes.error} onClick={()=>addCandidates('user_ids')}>加入阅卷池</Button>
          <Button disabled={!candidates.length||!classes.loaded||!!classes.error} onClick={()=>addCandidates('arbitrator_ids')}>加入仲裁池</Button>
        </Space></Form.Item>
        <Form.Item name="user_ids" label="阅卷池" rules={[{required:true,message:'请选择阅卷教师'}]}><Select mode="multiple" optionFilterProp="label" options={poolOptions(graders)}/></Form.Item>
        {graders.map(id=><Form.Item key={id} name={['weights',id]} label={(users.data.find(u=>u.id===id)?.name||'教师')+' · 分配权重'}><InputNumber min={0} max={255} placeholder="1"/></Form.Item>)}
        <Form.Item name="arbitrator_ids" label="仲裁池" rules={[{required:editing?.review_mode==='double',message:'请选择仲裁教师'}]}><Select mode="multiple" optionFilterProp="label" options={poolOptions(arbiters)}/></Form.Item>
        {arbiters.map(id=><Form.Item key={id} name={['arbitrator_weights',id]} label={(users.data.find(u=>u.id===id)?.name||'教师')+' · 仲裁权重'}><InputNumber min={0} max={255} placeholder="1"/></Form.Item>)}
      </Form>
    </Modal></>
}
