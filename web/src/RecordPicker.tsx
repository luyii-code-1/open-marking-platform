import {useEffect,useState,type ReactNode} from 'react'
import {Alert,App,Checkbox,Input,Modal,Select,Space,Tag,Typography,Upload,type TableColumnsType} from 'antd'
import {Button} from './Button'
import {Table} from './DataTable'
import {download} from './api'
import {filterRecords,type FilterField,type FilterValues} from './recordFilters'
import './recordPicker.css'

export type {FilterField} from './recordFilters'
type Importer={templateUrl:string;templateName:string;upload:(file:File)=>Promise<string[]>}
export function RecordPicker<T extends object>({open,onClose,title,records,columns,fields=[],value,onChange,label,rowKey='id',loading=false,importer,extra,multiple=true}: {
  open:boolean;onClose:()=>void;title:string;records:readonly T[];columns:TableColumnsType<T>;fields?:FilterField<T>[]
  value:string[];onChange:(ids:string[])=>void;label?:(row:T)=>string;rowKey?:string;loading?:boolean;importer?:Importer;extra?:ReactNode;multiple?:boolean
}){
  const [checked,setChecked]=useState<string[]>([]),[filters,setFilters]=useState<FilterValues>({}),[query,setQuery]=useState(''),[searchField,setSearchField]=useState(''),[onlySelected,setOnlySelected]=useState(false),[importing,setImporting]=useState(false),[error,setError]=useState('')
  const {message}=App.useApp(),key=(row:T)=>String((row as Record<string,unknown>)[rowKey]),byId=new Map(records.map(row=>[key(row),row]))
  useEffect(()=>{if(open){setChecked(value);setFilters({});setQuery('');setSearchField('');setOnlySelected(false);setError('')}},[open])
  const filtered=filterRecords(records,fields,filters,query,searchField),rows=onlySelected?filtered.filter(row=>checked.includes(key(row))):filtered
  function remove(id:string){setChecked(current=>current.filter(v=>v!==id))}
  return <Modal title={title} open={open} width="80vw" className="record-picker-modal" style={{top:'5vh'}} onCancel={()=>!importing&&onClose()} destroyOnHidden
    footer={<Space><Typography.Text type="secondary">已选 {checked.length} 项</Typography.Text><Button disabled={importing} onClick={onClose}>取消</Button><Button type="primary" disabled={importing||loading} onClick={()=>{onChange([...new Set(checked)]);onClose()}}>确认选择</Button></Space>}>
    <Space direction="vertical" size={12} style={{width:'100%'}}>
      <div className="record-picker-filters">{fields.map(field=><Select key={field.key} mode="multiple" allowClear showSearch optionFilterProp="label" maxTagCount="responsive" aria-label={field.label} placeholder={field.label} value={filters[field.key]||[]} options={field.options}
        onChange={values=>setFilters(current=>({...current,[field.key]:values}))}/>)}{extra}</div>
      <Space.Compact className="record-picker-search"><Select aria-label="搜索字段" value={searchField} onChange={setSearchField} options={[{value:'',label:'全部字段'},...fields.map(f=>({value:f.key,label:f.label}))]}/><Input.Search aria-label="关键字搜索" placeholder="输入关键字搜索" allowClear value={query} onChange={e=>setQuery(e.target.value)}/></Space.Compact>
      {Object.entries(filters).some(([,ids])=>ids.length>0)&&<div className="record-picker-tags">{fields.flatMap(field=>(filters[field.key]||[]).map(id=><Tag key={field.key+':'+id} closable onClose={()=>setFilters(current=>({...current,[field.key]:(current[field.key]||[]).filter(v=>v!==id)}))}>{field.label}：{field.options.find(o=>o.value===id)?.label||id}</Tag>))}<Button type="link" size="small" onClick={()=>{setFilters({});setQuery('')}}>重置过滤器</Button></div>}
      <Space wrap><Checkbox checked={onlySelected} onChange={e=>setOnlySelected(e.target.checked)}>只看已选（{checked.length}）</Checkbox>{multiple&&<Button size="small" onClick={()=>setChecked(current=>[...new Set([...current,...filtered.map(key)])])} disabled={!filtered.length}>选择全部匹配（{filtered.length}）</Button>}<Button size="small" disabled={!checked.length} onClick={()=>setChecked([])}>清空选择</Button>
        {importer&&<><Button disabled={importing} onClick={()=>download(importer.templateUrl,importer.templateName).catch(e=>message.error(e.message))}>下载导入模板</Button><Upload accept=".csv,.xlsx" disabled={importing} showUploadList={false} beforeUpload={async file=>{setImporting(true);setError('');try{const ids=await importer.upload(file),allowed=new Set(records.map(key));if(ids.some(id=>!allowed.has(id)))throw new Error('导入记录超出当前可选范围，请核对文件');if(!multiple&&ids.length>1)throw new Error('此处只可选择一项，请仅保留一条导入记录');setChecked(current=>multiple?[...new Set([...current,...ids])]:ids);message.success(`已匹配 ${ids.length} 项，请核对后确认`)}catch(e){setError((e as Error).message)}finally{setImporting(false)}return false}}><Button loading={importing}>外部导入</Button></Upload></>}
      </Space>
      {!!checked.length&&<div className="record-picker-selected" aria-label="已选记录">{checked.map(id=>{const row=byId.get(id);return <Tag key={id} closable onClose={()=>remove(id)}>{row?(label?.(row)||String((row as Record<string,unknown>).name||id)):id}</Tag>})}</div>}
      {error&&<Alert type="error" showIcon message={error}/>}
      <Table<T> query="" rowKey={rowKey} dataSource={rows} columns={columns} loading={loading||importing} pagination={{defaultPageSize:50,showSizeChanger:true,pageSizeOptions:[15,30,50,100]}} scroll={{x:'max-content',y:'55vh'}} rowSelection={{type:multiple?'checkbox':'radio',selectedRowKeys:checked,preserveSelectedRowKeys:true,onChange:keys=>setChecked(keys.map(String))}}/>
    </Space>
  </Modal>
}
