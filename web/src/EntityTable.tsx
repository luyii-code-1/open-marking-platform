import { useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, App, Card, Dropdown, Form, Input, InputNumber, Modal, Progress, Select, Space, Tag, Typography, Upload } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { MoreOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { download, request, send, useResource, type Row } from './api'
import { scopedRecord } from './examNavigation'
import { rowNavigation } from './rowNavigation'
import {RecordSelect} from './RecordSelect'
import type {FilterField} from './recordFilters'

type Field = { name: string; label: string; type?: 'number' | 'password' | 'select'; options?: { label: string; value: string | number }[]; required?: boolean; initial?: string | number }
type ListResource = { data: Row[]; loading: boolean; error: string; reload: () => Promise<void> }
export function ErrorNotice({ error, retry }: { error: string; retry?: () => void }) {
  return error ? <Alert type="error" showIcon message={error} action={retry && <Button onClick={retry}>重试</Button>} /> : null
}
export function EntityTable({ path, title, fields, columns, extra, creationFields, onCreated, scope = {}, searchText, resource: external,onEnter,allowImport=true,filterFields }: { path: string; title: string; fields: Field[]; columns?: TableColumnsType<Row>; extra?: ReactNode; creationFields?:ReactNode; onCreated?: (row?: Row) => void | Promise<unknown>; scope?: Record<string, string>; searchText?:(row:Row)=>unknown; resource?: ListResource; onEnter?:(row:Row)=>void; allowImport?:boolean;filterFields?:FilterField<Row>[] }) {
  const internal = useResource<Row[]>(external ? null : path, []), resource = external || internal, [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [importing, setImporting] = useState(false), [csv, setCsv] = useState(''), [search, setSearch] = useState(''), [progress, setProgress] = useState(0), [form] = Form.useForm()
  const { message } = App.useApp()
  const rows = resource.data.filter(row => Object.entries(scope).every(([key, value]) => row[key] === value))
  async function create(value: Record<string, unknown>) {
    setSaving(true)
    try { const row = await send<Row>(path, scopedRecord(value, scope)); message.success(`${title}已创建`); setOpen(false); form.resetFields(); await resource.reload(); await onCreated?.(row) }
    catch (e) { message.error((e as Error).message) }
    finally { setSaving(false) }
  }
  async function importRows() {
    setSaving(true); setProgress(0)
    try {
      const records = parseCsv(csv), headers = records.shift()?.map(name=>name.trim())
      if (!headers?.length || !records.length) throw new Error('请填写表头和至少一条记录')
      const unknown = headers.filter(name => !fields.some(f => f.name === name.trim()))
      if (unknown.length) throw new Error(`请使用当前页面的导入模板，未识别字段：${unknown.join('、')}`)
      if(new Set(headers.map(name=>name.trim())).size!==headers.length)throw new Error('表头字段重复')
      const missing=fields.filter(f=>f.required!==false&&!headers.includes(f.name))
      if(missing.length)throw new Error(`缺少必填列：${missing.map(f=>f.label).join('、')}`)
      records.forEach((record,index)=>{fields.filter(f=>f.required!==false).forEach(f=>{if(!record[headers.indexOf(f.name)]?.trim())throw new Error(`第 ${index+2} 行缺少${f.label}`)})})
      let count = 0
      for (const record of records) {
        const value: Record<string, unknown> = {}
        headers.forEach((name, i) => value[name.trim()] = fields.find(f => f.name === name.trim())?.type === 'number' ? Number(record[i]) : record[i])
        try { await send(path, scopedRecord(value, scope)) }
        catch (e) { throw new Error(`已导入 ${count} 条；第 ${count + 2} 行失败：${(e as Error).message}`) }
        count++; setProgress(Math.round(count / records.length * 100))
      }
      message.success(`成功导入 ${count} 条记录`); setImporting(false); setCsv('')
    } catch (e) { message.error((e as Error).message) }
    finally { setSaving(false); await resource.reload(); await onCreated?.() }
  }
  return <Card title={title}>
    <ErrorNotice error={resource.error} retry={resource.reload} />
    <div className="entity-toolbar">
      <Input.Search className="entity-search" placeholder={`搜索${title}`} allowClear value={search} onChange={e => setSearch(e.target.value)} />
      <Space wrap>{extra}<Dropdown menu={{ items: [{ key: 'refresh', label: '刷新列表', onClick: resource.reload }, ...allowImport?[{ key: 'import', label: '批量导入', onClick: () => setImporting(true) }]:[]] }}><Button icon={<MoreOutlined />} aria-label={`${title}更多操作`} /></Dropdown><Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建{title}</Button></Space>
    </div>
    <Table filterFields={filterFields} query={search} searchText={searchText} rowKey="id" onRow={onEnter?row=>rowNavigation(()=>onEnter(row),row.name):undefined} dataSource={rows} loading={resource.loading} columns={columns || fields.filter(f => f.type !== 'password').map(f => ({ title: f.label, dataIndex: f.name, render: (value: unknown) => f.options?.find(o => o.value === value)?.label || String(value ?? '—') }))} pagination={{ defaultPageSize:50, showSizeChanger: true }} scroll={{ x: 'max-content' }} locale={{ emptyText: search ? '没有匹配的记录' : `尚未创建${title}` }} />
    <Modal title={`新建${title}`} open={open} onCancel={() => !saving && setOpen(false)} onOk={() => form.submit()} confirmLoading={saving}>
      <Form form={form} layout="vertical" onFinish={create}>{fields.map(f => <Form.Item key={f.name} name={f.name} label={f.label} initialValue={f.initial} rules={[{ required: f.required !== false, whitespace: f.type === undefined, message: `请填写${f.label}` }]}>{f.type === 'select' ? ['grade_id','class_id'].includes(f.name)?<RecordSelect title={f.label} kind={f.name==='grade_id'?'grades':'classes'} records={(f.options||[]).map(o=>({id:String(o.value),name:o.label}))}/>:<Select showSearch optionFilterProp="label" options={f.options} /> : f.type === 'number' ? <InputNumber style={{ width: '100%' }} /> : f.type === 'password' ? <Input.Password autoComplete="new-password" /> : <Input />}</Form.Item>)}{creationFields}</Form>
    </Modal>
    <Modal width={700} title={`批量导入${title}`} open={importing} onCancel={() => !saving && setImporting(false)} onOk={importRows} confirmLoading={saving} okText="导入记录">
      <Typography.Paragraph>下载模板后填写 Excel 或 CSV，每条记录一行。{Object.keys(scope).length ? '记录自动归入当前页面。' : '关联记录使用其ID。'}导入逐条保存，遇到失败会停止并保留成功记录。</Typography.Paragraph>
      <Space wrap>{fields.map(f => <Tag key={f.name}>{f.name} · {f.label}</Tag>)}</Space>
      <Space><Button type="link" onClick={()=>download('/table-import/template?columns='+encodeURIComponent(fields.map(f=>f.name).join(',')),'导入模板.xlsx').catch(e=>message.error(e.message))}>下载 Excel 模板</Button><Button type="link" onClick={()=>download('/table-import/template?columns='+encodeURIComponent(fields.map(f=>f.name).join(','))+'&format=csv','导入模板.csv').catch(e=>message.error(e.message))}>下载 CSV 模板</Button></Space>
      <Upload accept=".csv,.xlsx" maxCount={1} disabled={saving} beforeUpload={async file=>{setSaving(true);try{const body=new FormData();body.append('file',file);const result=await request<{headers:string[];rows:string[][]}>('/table-import/parse',{method:'POST',body});setCsv([result.headers,...result.rows].map(row=>row.map(cell=>'"'+cell.replaceAll('"','""')+'"').join(',')).join('\r\n'))}catch(e){message.error((e as Error).message)}finally{setSaving(false)}return false}}><Button icon={<UploadOutlined />}>读取表格</Button></Upload>
      <Input.TextArea rows={9} value={csv} onChange={e => setCsv(e.target.value)} placeholder={fields.map(f => f.name).join(',')} style={{ marginTop: 16 }} />{saving && <Progress percent={progress} />}
    </Modal>
  </Card>
}

export function parseCsv(input: string) {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false
  const source = input.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i++) { const c = source[i]; if (c === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted } else if (c === ',' && !quoted) { row.push(cell); cell = '' } else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && source[i + 1] === '\n') i++; row.push(cell); if (row.some(v => v.trim())) rows.push(row); row = []; cell = '' } else cell += c }
  if (quoted) throw new Error('CSV引号没有闭合'); row.push(cell); if (row.some(v => v.trim())) rows.push(row); return rows
}
