import {useState} from 'react'
import {Alert, App, Form, Input, Modal, Select, Space, Table, Upload} from 'antd'
import {Button} from './Button'
import {request, type Row} from './api'

type Sheet = {name:string;columns:string[];rows:number}
const fields = {name:'姓名',class_name:'班级',grade:'年级',candidate_number:'准考证号'}
type Field = keyof typeof fields
const aliases: Record<Field,string[]> = {name:['姓名','学生姓名','name'],class_name:['班级','行政班','班级名称'],grade:['年级','年级名称'],candidate_number:['准考证号','考号','准考证号码','candidate_number']}
type Result = {new:number;updated:number;skipped:number;duplicates:number;classes:number;errors:string[];conflicts:string[];sample:Row[];can_import:boolean}

export function StudentImport({grades,onSaved}:{grades:Row[];onSaved:()=>Promise<void>}) {
  const [open,setOpen]=useState(false),[file,setFile]=useState<File>(),[sheets,setSheets]=useState<Sheet[]>([])
  const [selected,setSelected]=useState<string[]>([]),[mapping,setMapping]=useState<Partial<Record<Field,string>>>({})
  const [grade,setGrade]=useState<string>(),[fixedClass,setFixedClass]=useState(''),[policy,setPolicy]=useState('block')
  const [busy,setBusy]=useState(false),[result,setResult]=useState<Result>(),[error,setError]=useState('')
  const {message}=App.useApp()
  const columns=Array.from(new Set(sheets.filter(s=>selected.includes(s.name)).flatMap(s=>s.columns)))
  function invalidate(){setResult(undefined);setError('')}
  async function inspect(next:File){
    setBusy(true);invalidate();setFile(undefined);setSheets([])
    try{
      const data=new FormData();data.append('file',next)
      const info=await request<{sheets:Sheet[]}>('/student-import/inspect',{method:'POST',body:data})
      const detected:Partial<Record<Field,string>>={}
      for(const field of Object.keys(fields) as Field[])detected[field]=aliases[field].find(a=>info.sheets[0].columns.includes(a))
      setFile(next);setSheets(info.sheets);setSelected(info.sheets.map(s=>s.name));setMapping(detected)
      setGrade(detected.grade?undefined:grades.find(g=>!g.archived&&next.name.includes(g.name))?.id)
      setFixedClass('');setPolicy('block')
    }catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  async function run(){
    if(!file)return
    const commit=!!result?.can_import
    setBusy(true);setError('')
    try{
      const data=new FormData();data.append('file',file)
      data.append('options',JSON.stringify({sheets:selected,mapping,grade_id:grade,class_name:fixedClass.trim(),conflicts:policy}))
      const report=await request<Result>('/student-import/'+(commit?'commit':'preview'),{method:'POST',body:data})
      if(commit){setOpen(false);message.success('已导入：新增 '+report.new+' 人，更新 '+report.updated+' 人');await onSaved()}
      else setResult(report)
    }catch(e){setError((e as Error).message);setResult(undefined)}finally{setBusy(false)}
  }
  return <><Button onClick={()=>{setOpen(true);setFile(undefined);setSheets([]);invalidate()}}>导入学生名单</Button>
    <Modal width={720} title="导入学生名单" open={open} onCancel={()=>!busy&&setOpen(false)} confirmLoading={busy} okButtonProps={{disabled:!file||!selected.length||busy||!!result&&!result.can_import}} okText={result?.can_import?'确认导入':'预览名单'} onOk={run}>
      <Space direction="vertical" size={16} style={{width:'100%'}}>
        <Upload accept=".xlsx,.csv" disabled={busy} showUploadList={false} beforeUpload={f=>{void inspect(f);return false}}><Button disabled={busy}>{file?'更换文件':'选择 Excel 或 CSV 文件'}</Button></Upload>
        {file&&<Form layout="vertical" disabled={busy}>
          <Form.Item label={file.name}><Select mode="multiple" value={selected} options={sheets.map(s=>({value:s.name,label:s.name+'（'+s.rows+' 行）'}))} onChange={v=>{setSelected(v);invalidate()}}/></Form.Item>
          <Form.Item label="统一年级"><Select allowClear placeholder="使用表中的年级列" value={grade} options={grades.filter(g=>!g.archived).map(g=>({value:g.id,label:g.name}))} onChange={v=>{setGrade(v);invalidate()}}/></Form.Item>
          <div className="editor-form-grid">{(Object.keys(fields) as Field[]).filter(f=>!(f==='grade'&&grade)&&!(f==='class_name'&&fixedClass.trim())).map(f=><Form.Item key={f} label={fields[f]}><Select placeholder="选择表格列" value={mapping[f]} options={columns.map(c=>({value:c,label:c}))} onChange={v=>{setMapping({...mapping,[f]:v});invalidate()}}/></Form.Item>)}</div>
          <Form.Item label="统一班级（可选）"><Input value={fixedClass} placeholder="留空时按班级列匹配或创建" onChange={e=>{setFixedClass(e.target.value);invalidate()}}/></Form.Item>
          <Form.Item label="已有考号的姓名或班级不一致时"><Select value={policy} options={[{value:'block',label:'列出冲突，暂停导入'},{value:'skip',label:'跳过冲突学生'},{value:'update',label:'按表格更新已有学生'}]} onChange={v=>{setPolicy(v);invalidate()}}/></Form.Item>
        </Form>}
        {error&&<Alert type="error" message={error}/>}
        {result&&<><Alert type={result.can_import?'info':'warning'} message={'新增 '+result.new+' 人，更新 '+result.updated+' 人，跳过 '+result.skipped+' 人，合并重复 '+result.duplicates+' 行，新建 '+result.classes+' 个班级'}/>
          {!!(result.errors.length+result.conflicts.length)&&<details><summary>查看问题及冲突（{result.errors.length+result.conflicts.length}）</summary><div style={{maxHeight:180,overflow:'auto'}}>{[...result.errors,...result.conflicts].map((v,i)=><div key={i}>{v}</div>)}</div></details>}
          <Table size="small" pagination={false} rowKey="candidate_number" dataSource={result.sample} columns={Object.entries(fields).map(([key,title])=>({title,dataIndex:key}))}/></>}
      </Space>
    </Modal></>
}
