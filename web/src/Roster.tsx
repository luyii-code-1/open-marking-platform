import { useEffect,useState } from 'react'
import { Alert,App,Card,Checkbox,Form,Modal,Popconfirm,Select,Space,Statistic,Table,Tag,Typography,Upload } from 'antd'
import { DownloadOutlined,UploadOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { download,request,send,useResource,type Row } from './api'
import { HierarchyPicker } from './HierarchyPicker'
import { ErrorNotice } from './EntityTable'

type ImportReport={preview_sha:string;total_rows:number;duplicates:number;matched_count:number;students:Row[];errors:any[];warnings:any[]}
export function Roster({groupId}:{groupId?:string}){
  const groups=useResource<Row[]>('/groups',[]),grades=useResource<Row[]>('/grades',[])
  const [selectedGroup,setGroup]=useState(groupId||''),group=groupId||selectedGroup,[gradeId,setGrade]=useState<string>(),[busy,setBusy]=useState(false),{message}=App.useApp()
  const resource=useResource<any>(group?`/groups/${group}/roster`:null,null),current=groups.data.find(g=>g.id===group)
  const [open,setOpen]=useState(false),[file,setFile]=useState<File>(),[report,setReport]=useState<ImportReport>(),[confirmed,setConfirmed]=useState(false),[importError,setImportError]=useState('')
  const data=resource.data?.group_id===group?resource.data:null,frozen=!!current?.frozen,selected=data?.mode==='selected'
  useEffect(()=>{setGrade(current?.grade_id);setOpen(false);setFile(undefined);setReport(undefined);setImportError('')},[group,current?.grade_id])
  async function refresh(){await Promise.all([groups.reload(),resource.reload()])}
  async function saveGrade(){if(!gradeId)return;setBusy(true);try{await send(`/groups/${group}/grade`,{grade_id:gradeId},'PUT');await refresh();message.success('所属年级已保存')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  async function useGrade(){setBusy(true);try{await send(`/groups/${group}/roster`,{mode:'grade'},'PUT');await refresh();message.success('已使用年级全体学生')}catch(e){message.error((e as Error).message)}finally{setBusy(false)}}
  async function preview(next:File){
    setFile(next);setReport(undefined);setConfirmed(false);setImportError('');setBusy(true)
    try{const body=new FormData();body.append('file',next);setReport(await request<ImportReport>(`/groups/${group}/roster/import`,{method:'POST',body}))}
    catch(e){setImportError((e as Error).message)}finally{setBusy(false)}
  }
  async function apply(){
    if(!file||!report)return
    setBusy(true);setImportError('')
    try{const body=new FormData();body.append('file',file);body.append('action','import');body.append('preview_sha',report.preview_sha);body.append('confirm_warnings',String(confirmed));const result=await request<{expected_students:number}>(`/groups/${group}/roster/import`,{method:'POST',body});await refresh();setOpen(false);message.success(`已导入 ${result.expected_students} 名应考学生`)}
    catch(e){setImportError((e as Error).message)}finally{setBusy(false)}
  }
  const issues=report?[...report.errors.map(v=>({...v,type:'需修正'})),...report.warnings.map(v=>({...v,type:'需确认'}))]:[]
  return <Space direction="vertical" size={24} style={{width:'100%'}}>
    {!groupId&&<HierarchyPicker value={group} onChange={setGroup}/>}
    <ErrorNotice error={groups.error||grades.error||resource.error} retry={refresh}/>
    {group&&<><Card title="应考名单" extra={<Button disabled={busy} onClick={refresh}>刷新</Button>}>
      <Space direction="vertical" size={24} style={{width:'100%'}}>
        <div className="roster-summary"><Statistic title="应考学生" value={data?.students.length||0}/><div><Tag>{selected?'指定名单':data?.dynamic?'年级全体':'待设置'}</Tag><Typography.Paragraph type="secondary" style={{marginTop:8,marginBottom:0}}>{selected?'名单成员按导入结果确定，学生资料实时关联。':'默认使用所属年级当前全体学生，走班科目可导入指定名单。'}</Typography.Paragraph></div></div>
        <Space wrap size={16}><Button type="primary" icon={<UploadOutlined/>} disabled={busy||frozen||!current?.grade_id} onClick={()=>{setFile(undefined);setReport(undefined);setImportError('');setConfirmed(false);setOpen(true)}}>{selected?'重新导入名单':'导入指定名单'}</Button><Button icon={<DownloadOutlined/>} disabled={busy} onClick={()=>download(`/groups/${group}/roster/template`,'应考名单模板.xlsx').catch(e=>message.error(e.message))}>下载Excel模板</Button>{selected&&<Popconfirm title="改用所属年级全体学生？" description="现有答卷和成绩继续保留，应考范围改为该年级当前所有学生。" onConfirm={useGrade}><Button disabled={busy||frozen}>使用年级全体学生</Button></Popconfirm>}</Space>
        {!current?.grade_id&&<Alert type="info" showIcon message="请先设置所属年级，再导入名单。"/>}
        {frozen&&<Alert type="info" message="成绩已发布，发起复核后可调整应考名单。"/>}
      </Space>
    </Card>
    <Card title="所属年级"><Form layout="vertical" style={{maxWidth:420}}><Form.Item label="全局年级"><Select disabled={busy||frozen} value={gradeId} placeholder="选择年级" onChange={setGrade} options={grades.data.filter(g=>!g.archived||g.id===current?.grade_id).map(g=>({label:g.name,value:g.id}))}/></Form.Item><Button disabled={busy||frozen||!gradeId||gradeId===current?.grade_id} loading={busy} onClick={saveGrade}>保存所属年级</Button></Form></Card>
    <Card title="学生"><Table rowKey="id" loading={resource.loading} dataSource={data?.students||[]} pagination={{defaultPageSize:20,showSizeChanger:true}} columns={[{title:'准考证号',dataIndex:'candidate_number'},{title:'姓名',dataIndex:'name'},{title:'年级',dataIndex:'grade'},{title:'班级',dataIndex:'class_name'},{title:'采集状态',dataIndex:'status',render:value=><Tag color={value==='scanned'?'green':undefined}>{value==='unscanned'?'未扫描':value==='absent'?'已确认缺考':'已扫描'}</Tag>}]}/></Card>
    <Modal title="导入应考名单" width={860} open={open} onCancel={()=>!busy&&setOpen(false)} okText="确认导入" onOk={apply} confirmLoading={busy} okButtonProps={{disabled:!report||report.errors.length>0||!report.matched_count||report.warnings.length>0&&!confirmed}}>
      <Space direction="vertical" size={24} style={{width:'100%'}}>
        <Typography.Paragraph type="secondary" style={{margin:0}}>填写模板中的准考证号，可选填姓名。上传后自动关联全局学生，重复行合并。确认后替换本题卡应考名单，已有答卷和成绩保留。</Typography.Paragraph>
        <Space wrap><Upload accept=".xlsx,.csv" showUploadList={false} disabled={busy} beforeUpload={next=>{void preview(next);return false}}><Button icon={<UploadOutlined/>} disabled={busy} loading={busy}>选择表格文件</Button></Upload>{file&&<Typography.Text>{file.name}</Typography.Text>}</Space>
        {importError&&<Alert type="error" showIcon message={importError} action={file&&<Button disabled={busy} onClick={()=>preview(file)}>重新预览</Button>}/>}
        {report&&<><Space size={24} wrap><Statistic title="数据行" value={report.total_rows}/><Statistic title="匹配学生" value={report.matched_count}/><Statistic title="合并重复行" value={report.duplicates}/></Space>
          {report.errors.length>0&&<Alert type="error" showIcon message={`有 ${report.errors.length} 行需要修正，请维护全局学生或修改表格后重新上传。`}/>}
          {issues.length>0?<Table size="small" rowKey={(_,i)=>String(i)} dataSource={issues} pagination={{pageSize:8}} scroll={{x:'max-content'}} columns={[{title:'行',dataIndex:'row'},{title:'准考证号',dataIndex:'candidate_number'},{title:'表格姓名',dataIndex:'name'},{title:'当前姓名',dataIndex:'actual_name'},{title:'处理',dataIndex:'type'},{title:'说明',dataIndex:'reason'}]}/>:<Alert type="success" showIcon message="全部匹配，可以确认导入。"/>}
          {report.warnings.length>0&&<Checkbox checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}>已核对跨年级或姓名差异记录，按匹配的全局学生导入</Checkbox>}
        </>}
      </Space>
    </Modal></>}
  </Space>
}
