import {DeleteRecord} from './DeleteRecord'
import {useEffect,useMemo,useState} from 'react'
import {App,Card,Empty,Space,Upload,Tag,Tabs,Modal,Alert,Typography} from 'antd'
import {Table} from './DataTable'
import {Button} from './Button'
import {RecordPicker} from './RecordPicker'
import {ClassTags,DEFAULT_CLASS_TAGS,gradeColor} from './SchoolTags'
import {MultiTagPicker,SUBJECT_PRESETS,TagPicker} from './TagPicker'
import {request,send,useResource,type Row} from './api'

export function Electives({grades,students,classes}:{grades:Row[];students:Row[];classes:Row[]}){
  const lists=useResource<Row[]>('/electives',[]),subjects=useResource<Row[]>('/subject-tags',[])
  const [grade,setGrade]=useState(''),[subject,setSubject]=useState(''),[ids,setIds]=useState<string[]>([]),[busy,setBusy]=useState(false),[picker,setPicker]=useState(false),[kind,setKind]=useState('elective')
  const {message}=App.useApp(),activeGrades=grades.filter(g=>!g.archived),gradeClasses=useMemo(()=>classes.filter(c=>c.grade_id===grade),[classes,grade]),classNames=new Map(gradeClasses.map(c=>[c.id,c.name])),classById=new Map(gradeClasses.map(c=>[c.id,c]))
  const tagOptions=useMemo(()=>[...new Set([...DEFAULT_CLASS_TAGS,...gradeClasses.flatMap(c=>Array.isArray(c.tags)?c.tags.map(String):[])].filter(Boolean))].map(value=>({value,label:value})),[gradeClasses])
  const roster=students.filter(s=>classNames.has(s.class_id))
  function choose(g:string,s:string){setGrade(g);setSubject(s);const row=lists.data.find(l=>l.grade_id===g&&l.subject===s);setIds(row?.student_ids||[]);setKind(row?.kind_of_subject||'elective')}
  useEffect(()=>{if(!grade&&activeGrades.length)choose(activeGrades[0].id,subject)},[grade,activeGrades.length])
  async function save(){setBusy(true);try{await send('/electives',{grade_id:grade,subject,student_ids:kind==='required'?[]:ids,kind},'PUT');await lists.reload();message.success('应考范围已保存，可在题卡「应考名单」中同步应用')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  const studentColumns=[{title:'准考证号',dataIndex:'candidate_number'},{title:'姓名',dataIndex:'name'},{title:'行政班',render:(_:unknown,s:Row)=><Space size={6} wrap><span>{classNames.get(s.class_id)}</span><ClassTags tags={classById.get(s.class_id)?.tags} empty={null}/></Space>}]
  return <Space direction="vertical" size={16} style={{width:'100%'}}>
    {(lists.error||subjects.error)&&<Alert type="error" showIcon message={lists.error||subjects.error} action={<Button onClick={()=>{void lists.reload();void subjects.reload()}}>重试</Button>}/>}
    <Card title="年级选科名单" extra={<Button onClick={()=>{void lists.reload();void subjects.reload()}} loading={lists.loading}>刷新</Button>}>{activeGrades.length?<Tabs activeKey={grade||activeGrades[0]?.id} onChange={g=>choose(g,subject)} items={activeGrades.map(g=>({key:g.id,label:g.name,children:<Table<Row> rowKey="id" dataSource={lists.data.filter(row=>row.grade_id===g.id)} loading={lists.loading} columns={[{title:'科目',dataIndex:'subject'},{title:'应考范围',render:(_,r)=>r.kind_of_subject==='required'?'年级全体':`选考 · ${r.student_ids.length} 人`},{title:'操作',render:(_,r)=><Space><Button onClick={()=>choose(r.grade_id,r.subject)}>编辑</Button><DeleteRecord kind="electives" row={{...r,name:r.subject}} reload={async()=>{await lists.reload();if(grade===r.grade_id&&subject===r.subject)choose(g.id,'')}}/></Space>}]}/>}))}/>:<Empty description={<>暂无可用年级，请先前往 <a href="#/people/grades">人员与班级 / 年级</a> 创建年级</>}/>}</Card>
    <Card title="设置应考范围"><Space direction="vertical" size={12} style={{width:'100%',marginBottom:12}}>
      <Space wrap align="center"><Typography.Text type="secondary">年级</Typography.Text><TagPicker disabled={busy} value={grade||undefined} onChange={g=>choose(g||'',subject)} options={grades.filter(g=>!g.archived||g.id===grade).map(g=>({value:g.id,label:g.name,color:gradeColor(g.name)}))}/></Space>
      <Space wrap align="center"><Typography.Text type="secondary">科目</Typography.Text><TagPicker disabled={busy} value={subject||undefined} onChange={s=>choose(grade,s||'')} options={subjects.data.map(s=>({value:s.name,label:s.name}))}/></Space>
      <Space wrap align="center">
        <Typography.Text type="secondary">类型</Typography.Text>
        <TagPicker disabled={busy} value={kind} onChange={v=>v&&setKind(v)} options={[{value:'required',label:'必考'},{value:'elective',label:'选考'}]}/>
        {kind==='elective'&&<Button disabled={!grade||!subject||busy} onClick={()=>setPicker(true)}>选择应考学生（{ids.length}）</Button>}
        <Button type="primary" loading={busy} disabled={!grade||!subject||busy} onClick={save}>保存名单</Button>
      </Space>
    </Space>
      {subjects.loaded&&!subjects.data.length&&<Typography.Paragraph type="secondary">尚未维护全校科目，<a href="#/subject-catalog">前往科目管理添加科目</a>。</Typography.Paragraph>}
      {kind==='elective'?<Table<Row> rowKey="id" dataSource={roster.filter(s=>ids.includes(s.id))} columns={studentColumns}/>:<Tag>使用该年级全体学生</Tag>}
    </Card>
    <RecordPicker<Row> open={picker} onClose={()=>setPicker(false)} title="选择应考学生" records={roster} columns={studentColumns} value={ids} onChange={setIds} label={s=>`${s.name}（${s.candidate_number}）`} fields={[{key:'tag',label:'班级标签',options:tagOptions,values:s=>classById.get(s.class_id)?.tags||[]},{key:'class',label:'行政班',options:[...classNames].map(([value,label])=>({value,label})),values:s=>[s.class_id]}]}
      importer={{templateUrl:'/selection/students/template',templateName:'应考学生选择模板.xlsx',upload:async file=>{const body=new FormData();body.append('file',file);return await request<string[]>('/electives/match?grade_id='+encodeURIComponent(grade)+'&subject='+encodeURIComponent(subject),{method:'POST',body})}}}/>
  </Space>
}

export function ElectiveManagement(){
  const grades=useResource<Row[]>('/grades',[]),students=useResource<Row[]>('/students',[]),classes=useResource<Row[]>('/classes',[])
  return <>{(grades.error||students.error||classes.error)&&<Alert type="error" showIcon message={grades.error||students.error||classes.error} action={<Button onClick={()=>{void grades.reload();void students.reload();void classes.reload()}}>重试</Button>}/>}<Electives grades={grades.data} students={students.data} classes={classes.data}/></>
}

export function SubjectCatalog(){
  const tags=useResource<Row[]>('/subject-tags',[]),[name,setName]=useState(''),[busy,setBusy]=useState(false),[editing,setEditing]=useState<Row|null>(null),[open,setOpen]=useState(false),{message}=App.useApp()
  function edit(row?:Row){setEditing(row||null);setName(row?.name||'');setOpen(true)}
  async function save(){setBusy(true);try{await send(editing?'/subject-tags/'+editing.id:'/subject-tags',{name:name.trim()},editing?'PUT':'POST');await tags.reload();setOpen(false);message.success(editing?'科目名称已保存':'科目已添加')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  return <><Card title="全校科目" extra={<Button onClick={tags.reload} loading={tags.loading}>刷新</Button>}>{tags.error&&<Alert type="error" showIcon message={tags.error} action={<Button onClick={tags.reload}>重试</Button>} style={{marginBottom:12}}/>}<Space wrap style={{marginBottom:12}}>
    <Button type="primary" disabled={busy} onClick={()=>edit()}>添加科目</Button>
    <Upload accept=".csv,.xlsx" showUploadList={false} disabled={busy} beforeUpload={async file=>{const body=new FormData();body.append('file',file);setBusy(true);try{const result=await request<{created:number}>('/subject-tags/import',{method:'POST',body});await tags.reload();message.success(`新增 ${result.created} 个科目`)}catch(e){message.error((e as Error).message)}finally{setBusy(false)}return false}}><Button title="Excel 或 CSV，表头为“科目”">导入科目表</Button></Upload>
    </Space><Table<Row> rowKey="id" dataSource={tags.data} loading={tags.loading} columns={[{title:'科目',dataIndex:'name'},{title:'操作',render:(_,row)=><Space><Button disabled={busy} onClick={()=>edit(row)}>编辑</Button><DeleteRecord kind="subject-tags" row={row} reload={tags.reload}/></Space>}]}/></Card>
    <Modal title={editing?'修改科目名称':'添加科目'} open={open} onCancel={()=>!busy&&setOpen(false)} onOk={save} confirmLoading={busy} okButtonProps={{disabled:!name.trim()}}><TagPicker allowCustom maxLength={100} aria-label="科目名称" customPlaceholder="点击上方科目标签快速填充，或输入自定义科目名称" value={name} onChange={v=>setName(v||'')} options={SUBJECT_PRESETS.map(s=>({label:s,value:s,disabled:!editing&&tags.data.some(t=>t.name===s)}))}/></Modal></>
}

export function CatalogPicker({value=[],onChange}:{value?:string[];onChange?:(ids:string[])=>void}){
  const tags=useResource<Row[]>('/subject-tags',[])
  const options=tags.data.map(t=>({label:t.name,value:t.id}))
  return <Space direction="vertical" style={{width:'100%'}}>{options.length>0?<MultiTagPicker showSelectAll options={options} value={value} onChange={v=>onChange?.(v.map(String))}/>:tags.error?<Alert type="error" message={tags.error} action={<Button onClick={tags.reload}>重新加载科目</Button>}/>:tags.loaded&&<Space wrap><a href="#/subject-catalog" target="_blank" rel="noopener noreferrer">在新标签页打开科目管理，添加科目</a><Button onClick={tags.reload} loading={tags.loading}>刷新科目</Button></Space>}</Space>
}
