import { MoreOutlined, DownOutlined } from '@ant-design/icons'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, App, Breadcrumb, Card, Checkbox, Collapse, ConfigProvider, Descriptions, Drawer, Dropdown, Empty, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Typography } from 'antd'
import { Button } from './Button'
import zhCN from 'antd/locale/zh_CN'
import { hasScannerHost, scannerCall, watchScanner } from './scanner-bridge'
import { uiTheme } from './uiTheme'
import { Brand } from './Brand'
import './scanner.css'

type Row = Record<string, any> & { id: string }
const statusLabels: Record<string, string> = { open: '采集中', frozen: '待核查', local_paired: '已确认，等待同步', paired: '已同步', pending: '等待上传', uploaded: '已上传', blocked: '待核查', excluded: '已排除' }
function Status({ value }: { value: string }) { return <Tag color={value === 'blocked' || value === 'frozen' ? 'orange' : value === 'paired' || value === 'uploaded' ? 'green' : undefined}>{statusLabels[value] || value}</Tag> }

function Scanner() {
  const [state, setState] = useState<any>(null), [busyKey, setBusyKey] = useState(''), [error, setError] = useState(''), [connection, setConnection] = useState(false)
  const [inProject, setInProject] = useState(false), [subjectId, setSubject] = useState(''), [groupId, setGroup] = useState(''), [batchId, setBatch] = useState(''), [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false), [driver, setDriver] = useState('Twain'), [devices, setDevices] = useState<Row[]>([]), [device, setDevice] = useState(''), [side, setSide] = useState('front')
  const [preview, setPreview] = useState<Row | null>(null), [image, setImage] = useState(''), [question, setQuestion] = useState(''), [previewBusy, setPreviewBusy] = useState(false)
  const [connectForm] = Form.useForm(), [batchForm] = Form.useForm(), { message, modal } = App.useApp()
  const currentBatch = useRef(batchId), currentPage = useRef(page), reloadBusy = useRef(false), mounted = useRef(true)
  currentBatch.current = batchId; currentPage.current = page
  const reload = useCallback(async () => {
    if (reloadBusy.current || !hasScannerHost) return
    reloadBusy.current = true
    try { const next = await scannerCall('state', { batch_id: currentBatch.current, offset: (currentPage.current - 1) * 50 }); if (mounted.current) { setState(next); setError('') } }
    catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { reloadBusy.current = false }
  }, [])
  useEffect(() => {
    mounted.current = true; void reload(); let scheduled: ReturnType<typeof setTimeout> | undefined
    const stop = watchScanner(() => { if (scheduled) return; scheduled = setTimeout(() => { scheduled = undefined; void reload() }, 250) })
    const poll = setInterval(reload, 3000)
    return () => { mounted.current = false; stop(); clearInterval(poll); if (scheduled) clearTimeout(scheduled) }
  }, [reload])
  useEffect(() => { void reload() }, [batchId, page, reload])
  const busy=!!busyKey, activeAction=useRef<symbol|null>(null)
  const actionKey=(method:string,args:Record<string,unknown>={})=>`${method}:${args.project_id||args.page_id||args.batch_id||args.group_id||''}`
  async function action(method: string, args: Record<string, unknown> = {}, completed?: (result: any) => void) {
    if(activeAction.current&&method!=='stop')return
    const token=Symbol(method);activeAction.current=token
    setBusyKey(actionKey(method,args)); setError('')
    try { const result = await scannerCall(method, args); completed?.(result); await reload(); return result }
    catch (e) { message.error((e as Error).message) }
    finally { if(activeAction.current===token){activeAction.current=null;setBusyKey('')} }
  }
  const pack = state?.package, subject = pack?.subjects.find((s: Row) => s.id === subjectId), group = pack?.groups.find((g: Row) => g.id === groupId), batch = state?.batches.find((b: Row) => b.id === batchId)
  const cached = new Map((state?.projects || []).map((p: Row) => [p.id, p]))
  const projects: Row[] = [...new Map([...(state?.catalog.projects || []), ...(state?.projects || [])].map((p: Row) => [p.id, p])).values()] as Row[]
  const locked = busy || !!state?.capturing
  async function openProject(id: string) { await action('openProject', { project_id: id }, () => { setInProject(true); setSubject(''); setGroup(''); setBatch('') }) }
  function openSubject(id: string) {
    setSubject(id); setBatch('')
    const item = pack.subjects.find((s: Row) => s.id === id), groups = pack.groups.filter((g: Row) => g.subject_id === id)
    setGroup(groups.length === 1 && groups[0].id === item.default_group_id ? groups[0].id : '')
  }
  async function showPreview(row: Row, qid = '') {
    setPreview(row); setPreviewBusy(true); setImage(''); setQuestion(qid)
    try { const result = await scannerCall('preview', { batch_id: batchId, page_id: row.id, question_id: qid }); setImage(result.url) }
    catch (e) { message.error((e as Error).message) }
    finally { setPreviewBusy(false) }
  }
  function exclude(row: Row) {
    modal.confirm({ title: batch.capture_mode === 'duplex' ? `排除第${row.sequence}张纸并整张重扫？` : `排除此${row.side === 'front' ? '正' : '背'}面？`, content: '已采集原图保留，已上传页面会在同步时排除。', okText: '排除并保留原图', okButtonProps: { danger: true }, onOk: () => action('exclude', { batch_id: batchId, page_id: row.id }) })
  }
  const crumbs = [
    { title: <Button type="link" disabled={locked} onClick={() => setInProject(false)}>考试项目</Button> },
    ...(inProject && pack ? [{ title: <Button type="link" disabled={locked} onClick={() => { setSubject(''); setGroup(''); setBatch('') }}>{pack.project.name}</Button> }] : []),
    ...(inProject && subject ? [{ title: <Button type="link" disabled={locked} onClick={() => { setGroup(''); setBatch('') }}>{subject.name}</Button> }] : []),
    ...(inProject && group ? [{ title: <Button type="link" disabled={locked} onClick={() => setBatch('')}>{group.name}</Button> }] : []),
    ...(inProject && batch ? [{ title: batch.name }] : []),
  ]
  if (!hasScannerHost) return <main className="scanner-unavailable"><Typography.Title level={3}>扫描工作台</Typography.Title><Typography.Paragraph>请在扫描客户端打开此页面。</Typography.Paragraph></main>
  return <div className="scanner-app">
    <header className="scanner-header"><Space size={16}><Brand /><Typography.Title level={4}>扫描工作台</Typography.Title></Space><Space size={12}><Tag color={state?.online ? 'green' : undefined}>{state?.online ? '已连接' : '离线'}</Tag><Dropdown menu={{ items: [
      { key: 'connect', label: '连接服务器', disabled: locked, onClick: () => { connectForm.setFieldsValue({ server_url: state?.server_url }); setConnection(true) } },
      { key: 'online', label: '打开服务端页面', disabled: !state?.server_url || locked, onClick: () => action('onlinePage') },
      { key: 'offline', label: '打开离线页面', disabled: locked, onClick: () => action('offlinePage') },
    ] }}><Button icon={<DownOutlined />} iconPosition="end">连接设置</Button></Dropdown></Space></header>
    <main className="scanner-content"><Breadcrumb items={crumbs} />
      {!state?.online && <Typography.Paragraph className="scanner-offline" type="secondary">已下载的项目可继续扫描；联网后校验版本并上传。</Typography.Paragraph>}
      {error && <Alert type="error" message={error} />}
      {!state ? <Card loading /> : !inProject || !pack ? <section className="scanner-section"><div className="scanner-title"><div><Typography.Title level={2}>考试项目</Typography.Title><Typography.Text type="secondary">打开本机已下载的考试，或连接服务器下载项目配置。</Typography.Text></div><Button onClick={() => { connectForm.setFieldsValue({ server_url: state.server_url }); setConnection(true) }}>连接服务器</Button></div>
        <Table<Row> rowKey="id" dataSource={projects} locale={{ emptyText: <Empty description="尚未下载考试项目" /> }} pagination={{ pageSize: 10 }} columns={[
          { title: '考试', dataIndex: 'name' }, { title: '本地配置', render: (_, row) => cached.has(row.id) ? <Tag>已下载</Tag> : <Typography.Text type="secondary">未下载</Typography.Text> },
          { title: '操作', width: 240, render: (_, row) => <Space><Button loading={busyKey===actionKey('openProject',{project_id:row.id})} disabled={!cached.has(row.id) || locked} onClick={() => openProject(row.id)}>打开</Button><Button loading={busyKey===actionKey('downloadProject',{project_id:row.id})} disabled={!state.online || locked} onClick={() => action('downloadProject', { project_id: row.id }, () => { setInProject(true); setSubject(''); setGroup(''); setBatch('') })}>{cached.has(row.id) ? '更新配置' : '下载配置'}</Button></Space> },
        ]} /></section> : !subject ? <section className="scanner-section"><div className="scanner-title"><Typography.Title level={2}>{pack.project.name}</Typography.Title><Button loading={busyKey===actionKey('downloadProject',{project_id:pack.project.id})} disabled={!state.online || locked} onClick={() => action('downloadProject', { project_id: pack.project.id })}>更新项目配置</Button></div><Table<Row> rowKey="id" dataSource={pack.subjects} pagination={false} columns={[{ title: '科目', dataIndex: 'name' }, { title: '可扫描题卡组', render: (_, row) => pack.groups.filter((g: Row) => g.subject_id === row.id).length }, { title: '操作', width: 100, render: (_, row) => <Button disabled={locked} onClick={() => openSubject(row.id)}>进入</Button> }]} /></section>
        : !group ? <section className="scanner-section"><Typography.Title level={2}>{subject.name}</Typography.Title><Table<Row> rowKey="id" dataSource={pack.groups.filter((g: Row) => g.subject_id === subject.id)} pagination={{ pageSize: 10 }} columns={[{ title: '题卡组', dataIndex: 'name' }, { title: '题卡', render: (_, row) => row.template.name }, { title: '状态', render: (_, row) => row.frozen ? <Tag>已发布成绩</Tag> : <Tag>可扫描</Tag> }, { title: '操作', width: 100, render: (_, row) => <Button disabled={locked} onClick={() => { setGroup(row.id); setBatch('') }}>进入</Button> }]} /></section>
          : !batch ? <section className="scanner-section"><div className="scanner-title"><div><Typography.Title level={2}>{group.name}</Typography.Title><Typography.Text type="secondary">{group.template.name} · {group.template.paper} · {group.template.sides === 2 ? '双面' : '单面'}</Typography.Text></div><Button type="primary" disabled={locked || group.frozen} onClick={() => { batchForm.resetFields(); batchForm.setFieldsValue({ name: '扫描批次', capture_mode: group.template.sides === 2 ? 'duplex' : 'separate', back_order: 'same' }); setCreating(true) }}>新建扫描批次</Button></div>
            <Table<Row> rowKey="id" dataSource={state.batches.filter((b: Row) => b.group_id === group.id)} pagination={{ pageSize: 10 }} columns={[{ title: '批次', dataIndex: 'name' }, {title:'考场标签',render:(_,row)=><Space wrap>{(row.room_tags||[]).map((t:Row)=><Tag key={t.id}>{t.name}</Tag>)}</Space>},{ title: '考场备注', dataIndex: 'room' }, { title: '同步', render: (_, row) => `${row.uploaded}/${row.total}` }, { title: '状态', dataIndex: 'status', render: value => <Status value={value} /> }, { title: '操作', width: 100, render: (_, row) => <Button disabled={locked} onClick={() => { setBatch(row.id); setPage(1) }}>打开</Button> }]} /></section>
            : <section className="scanner-section"><div className="scanner-title"><div><Space align="center"><Typography.Title level={2}>{batch.name}</Typography.Title><Status value={batch.status} /></Space><Typography.Paragraph type="secondary">{batch.paper} · {batch.sides === 2 ? '双面' : '单面'} · {batch.capture_mode === 'duplex' ? '自动双面' : '分面采集'} · 已上传 {batch.uploaded}/{batch.total}</Typography.Paragraph></div><Space>
              <Button type="primary" loading={busyKey===actionKey('start',{batch_id:batchId})} disabled={locked || !device || batch.status !== 'open'} onClick={() => action('start', { batch_id: batchId, device_id: device, side })}>开始扫描</Button><Button danger loading={busyKey===actionKey('stop')} disabled={!state.capturing} onClick={() => action('stop')}>停止</Button>
              <Dropdown menu={{ items: [
                { key: 'import', label: '导入扫描图像', disabled: locked || batch.status !== 'open', onClick: () => action('import', { batch_id: batchId, side }) },
                { key: 'pair', label: '核对并确认本批次', disabled: locked || batch.status !== 'open', onClick: () => modal.confirm({ title: '已核对本批次纸张与考号？', content: '客户端完成本地配页后，继续上传剩余文件；服务器确认后进入阅卷。', okText: '确认批次', onOk: () => action('pair', { batch_id: batchId }) }) },
                { key: 'upload', label: state.syncing ? '正在同步队列' : '立即同步队列', disabled: busy || state.syncing, onClick: () => action('upload', { batch_id: batchId }) },
                { key: 'refresh', label: '刷新服务端状态', disabled: locked || !state.online, onClick: () => action('refreshBatch', { batch_id: batchId }) },
              ] }}><Button icon={<DownOutlined />} iconPosition="end">更多操作</Button></Dropdown>
            </Space></div>
              {batch.error && <Alert type="warning" message={batch.error} />}
              <Collapse defaultActiveKey={['device']} items={[{ key: 'device', label: '设备设置', children: <Space wrap size={12}><Select aria-label="驱动接口" value={driver} disabled={locked} style={{ width: 130 }} onChange={value => { setDriver(value); setDevices([]); setDevice('') }} options={[{ value: 'Twain', label: 'TWAIN' }, { value: 'Wia', label: 'WIA' }, { value: 'Escl', label: 'eSCL' }]} /><Button loading={busyKey===actionKey('devices')} disabled={locked} onClick={() => action('devices', { driver }, rows => { setDevices(rows); setDevice(rows[0]?.id || '') })}>发现扫描仪</Button><Select aria-label="扫描仪" placeholder="选择扫描仪" disabled={locked} value={device || undefined} style={{ minWidth: 260 }} options={devices.map(d => ({ value: d.id, label: d.name }))} onChange={setDevice} />{batch.capture_mode !== 'duplex' && batch.sides === 2 && <Select aria-label="扫描面" disabled={locked} value={side} onChange={setSide} options={[{ value: 'front', label: '正面' }, { value: 'back', label: '背面' }]} />}</Space> }]} />
              <Typography.Paragraph className="scanner-progress" type="secondary" role="status" aria-live="polite">{state.message || '\u00a0'}</Typography.Paragraph>
              <Table<Row> rowKey="id" dataSource={state.pages} pagination={{ current: page, pageSize: 50, total: state.page_total, showSizeChanger: false, onChange: setPage }} columns={[
                { title: '纸张序号', dataIndex: 'sequence', width: 100 }, { title: '扫描面', dataIndex: 'side', width: 90, render: value => value === 'front' ? '正面' : '背面' }, { title: '考号', dataIndex: 'candidate' }, { title: '状态', dataIndex: 'status', render: value => <Status value={value} /> },
                { title: '核查信息', render: (_, row) => row.error || row.quality }, { title: '操作', width: 110, render: (_, row) => <Space><Button type="link" onClick={() => showPreview(row)}>查看</Button><Dropdown menu={{ items: [{ key: 'retry', label: '重试本地识读', disabled: locked || row.status === 'excluded' || batch.status === 'paired', onClick: () => action('retryPage', { batch_id: batchId, page_id: row.id }) }, { key: 'review', label: '上传原图供核查', disabled: locked || !state.online || row.status !== 'blocked', onClick: () => modal.confirm({ title: '将原图和质量报告送交管理员核查？', okText: '上传待核查原图', onOk: () => action('sendForReview', { batch_id: batchId, page_id: row.id }) }) }, { key: 'exclude', label: batch.capture_mode === 'duplex' ? '排除整张重扫' : '排除此面', danger: true, disabled: locked || row.status === 'excluded' || batch.status === 'paired', onClick: () => exclude(row) }] }}><Button type="text" icon={<MoreOutlined />} aria-label={`第${row.sequence}张扫描图更多操作`} /></Dropdown></Space> },
              ]} />
            </section>}
    </main>
    <Drawer title="连接服务器" open={connection} onClose={() => setConnection(false)} width={420}><Form form={connectForm} layout="vertical" onFinish={values => action('connect', values, () => { connectForm.setFieldValue('pairing_code', ''); setConnection(false); setInProject(false); setSubject(''); setGroup(''); setBatch('') })}>
      <Form.Item name="server_url" label="服务端地址" rules={[{ required: true }]}><Input placeholder="https://服务器地址" /></Form.Item>
      <Typography.Paragraph type="secondary">已登记的设备可直接连接。首次使用时在管理后台生成配对码，再在此处填写完成绑定。</Typography.Paragraph>
      <Form.Item name="pairing_code" label="配对码（首次连接）"><Input autoComplete="one-time-code" maxLength={14}/></Form.Item><Button htmlType="submit" type="primary" loading={busyKey===actionKey('connect')}>连接</Button><Typography.Paragraph style={{marginTop:32}} type="secondary">本机数据目录</Typography.Paragraph><Typography.Text copyable>{state?.storage_path}</Typography.Text>
    </Form></Drawer>
    <Modal title="新建扫描批次" open={creating} onCancel={() => setCreating(false)} onOk={() => batchForm.submit()} confirmLoading={busyKey===actionKey('createBatch',{group_id:groupId})} okText="创建批次"><Form form={batchForm} layout="vertical" onFinish={values => action('createBatch', { ...values, group_id: groupId }, result => { setCreating(false); setBatch(result.id); setPage(1) })}>
      <Form.Item name="name" label="批次名称" rules={[{ required: true, max: 100 }]}><Input maxLength={100} /></Form.Item><Form.Item name="room_tag_ids" label="考场标签"><Select mode="multiple" options={(pack?.room_tags||[]).filter((t:Row)=>!t.archived).map((t:Row)=>({value:t.id,label:t.name}))}/></Form.Item><Form.Item name="room" label="考场备注"><Input maxLength={100} /></Form.Item>
      {group?.template.sides === 2 && <><Form.Item name="capture_mode" label="采集方式"><Select options={[{ value: 'duplex', label: '一次进纸自动双面' }, { value: 'separate', label: '先全部正面，再全部背面' }]} /></Form.Item><Form.Item noStyle shouldUpdate>{() => batchForm.getFieldValue('capture_mode') === 'separate' && <Form.Item name="back_order" label="背面顺序"><Select options={[{ value: 'same', label: '同序' }, { value: 'reverse', label: '逆序' }]} /></Form.Item>}</Form.Item></>}
      {group?.template.sides===2 && <Form.Item noStyle shouldUpdate>{()=>batchForm.getFieldValue("capture_mode")==="duplex" && group.template.layout_version>=3 && <Form.Item name="first_side" label="已校准的双面出图顺序" rules={[{required:true,message:"请选择试扫确认后的出图顺序"}]} extra="先用一张正反面可区分的样张试扫，确认驱动输出顺序；同一批次保持相同放纸方向。"><Select placeholder="选择试扫结果" options={[{label:"正面先出，然后背面",value:"front"},{label:"背面先出，然后正面",value:"back"}]}/></Form.Item>}</Form.Item>}
    </Form></Modal>
    <Drawer title={preview ? `第${preview.sequence}张 · ${preview.side === 'front' ? '正面' : '背面'}` : '页面核查'} open={!!preview} onClose={() => { setPreview(null); setImage('') }} width="min(880px,90vw)">
      {preview && <><Descriptions column={2} items={[{ label: '考号', children: preview.candidate || '—' }, { label: '状态', children: <Status value={preview.status} /> }]} /><Select aria-label="查看整页或切题" value={question} style={{ width: '100%', margin: '20px 0' }} onChange={value => showPreview(preview, value)} options={[{ value: '', label: '整页原图' }, ...(preview.local_cut_available ? (group?.template.questions || []) : []).filter((q: Row) => q.regions.some((r: any) => r.page === (preview.side === 'front' ? 1 : 2))).map((q: Row) => ({ value: q.id, label: `第${q.number}题 · 本地切题` }))]} />{preview.error && <Alert type="warning" message={preview.error} />}{previewBusy ? <Card loading /> : image && <img className="scanner-preview" src={image} alt={question ? '本地切题预览' : '扫描原图预览'} />}</>}
    </Drawer>
  </div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider locale={zhCN} theme={uiTheme}><App><Scanner /></App></ConfigProvider></React.StrictMode>)
