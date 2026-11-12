import { useEffect, useRef, useState } from 'react'
import { App, Button, Card, Dropdown, Empty, Form, Input, InputNumber, Modal, Radio, Select, Space, Table, Tabs, Tag, Typography, Upload } from 'antd'
import { CopyOutlined, DownloadOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons'
import { request, download, newQuestion, send, useResource, type Question, type Row, type Template } from './api'
import { ErrorNotice } from './EntityTable'
import { Paper } from './PrintPaper'
import { TemplateLibrary } from './TemplateLibrary'
import { HierarchyPicker } from './HierarchyPicker'
import { useUnsavedChanges } from './useNavigation'
import { ObjectiveEditor } from './ObjectiveEditor'
import { QuestionSettings } from './QuestionSettings'

const { Text } = Typography
const emptyTemplate = (groupId = ''): Template => ({ id: '', name: '新答题卡', group_id: groupId, paper: 'A4', sides: 2, candidate_length: 8, revision: 0, questions: [] })
export function TemplateEditor({ groupId }: { groupId?: string }) {
  const templates = useResource<Template[]>('/templates', []), groups = useResource<Row[]>('/groups', [])
  const [value, setValue] = useState<Template>(() => emptyTemplate(groupId)), [questionId, setQuestionId] = useState(''), [page, setPage] = useState(1), [draw, setDraw] = useState(true)
  const [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false), [pane, setPane] = useState('objective'), [settingsOpen, setSettingsOpen] = useState(false)
  const [answerMode,setAnswerMode]=useState(true)
  const initialized = useRef(''), { message, modal } = App.useApp()
  const saved = templates.data.filter(t => !groupId || t.group_id === groupId), readOnly = value.status === 'published'
  const question = value.questions.find(q => q.id === questionId), total = value.questions.reduce((sum, q) => sum + Number(q.points || 0), 0)
  useUnsavedChanges(dirty)
  useEffect(() => {
    if (!groupId || initialized.current === groupId || !templates.loaded || !groups.loaded) return
    const group = groups.data.find(g => g.id === groupId)
    if (!group) return
    initialized.current = groupId
    const existing = saved.find(t => t.id === group.template_id) || saved.find(t => t.status === 'draft')
    setValue(existing ? structuredClone(existing) : emptyTemplate(groupId)); setDirty(false)
  }, [groupId, templates.loaded, groups.loaded, templates.data, groups.data])
  function change(update: Partial<Template>) {
    if (readOnly) return
    setValue(v => ({ ...v, ...update })); setDirty(true)
  }
  function select(id: string, edit = false) {
    setQuestionId(id)
    const q = value.questions.find(q => q.id === id)
    if (q) { setPane(q.type === 'subjective' ? 'subjective' : 'objective'); if (q.regions[0]) setPage(q.regions[0].page) }
    if (edit) setSettingsOpen(true)
  }
  function answerOnCard(id:string,letter:string){
    const q=value.questions.find(q=>q.id===id);if(!q||readOnly)return
    const answer=q.type==='single'?[letter]:q.answer.includes(letter)?q.answer.filter(a=>a!==letter):[...q.answer,letter].sort()
    change({questions:value.questions.map(item=>item.id===id?{...item,answer}:item)})
    const rows=value.questions.filter(item=>item.type!=='subjective').sort((a,b)=>a.number-b.number),index=rows.findIndex(item=>item.id===id)
    if(q.type==='single')select(rows[Math.min(index+1,rows.length-1)].id);else setQuestionId(id)
  }
  function patchQuestion(patch: Partial<Question>) {
    if (!question) return
    if (patch.number && value.questions.some(q => q.id !== question.id && q.number === patch.number)) { message.warning('该题号已存在'); return }
    change({ questions: value.questions.map(q => q.id === question.id ? { ...q, ...patch } : q) })
    if (patch.type) setPane(patch.type === 'subjective' ? 'subjective' : 'objective')
  }
  function load(template: Template) {
    const apply = () => { setValue(structuredClone(template)); setQuestionId(''); setPage(1); setDirty(false); setSettingsOpen(false); setAnswerMode(template.questions.some(q=>q.type!=='subjective')); setPane(template.questions.some(q => q.type !== 'subjective') ? 'objective' : template.questions.length ? 'subjective' : 'setup') }
    if (dirty) modal.confirm({ title: '切换题卡前放弃未保存修改？', onOk: apply }); else apply()
  }
  async function save(publish = false) {
    if (readOnly) return
    if (!value.group_id || (groupId && value.group_id !== groupId)) { message.warning('请确认所属题卡组'); return }
    setSaving(true)
    try {
      if (publish) {
        const check = await send<{ valid: boolean; issues: string[] }>('/templates/check', value)
        if (!check.valid) { modal.warning({ title: '发布前请完善以下内容', content: <ul className="validation-issues">{check.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> }); return }
      }
      const stored = await send<Template>(value.id ? `/templates/${value.id}` : '/templates', value, value.id ? 'PUT' : 'POST')
      setValue(stored); setDirty(false)
      if (publish) { setValue(await send<Template>(`/templates/${stored.id}/publish`)); message.success('题卡已发布，可以导出打印稿') }
      else message.success('草稿已保存')
      await Promise.all([templates.reload(), groups.reload()])
    } catch (e) { message.error((e as Error).message) }
    finally { setSaving(false) }
  }
  const setup = <div className="editor-section"><Form layout="vertical" disabled={readOnly}>
    {!groupId && <Form.Item label="所属题卡组" required><HierarchyPicker value={value.group_id} onChange={group_id => change({ group_id })} /></Form.Item>}
    <Form.Item label="题卡标题"><Input value={value.name} onChange={event => change({ name: event.target.value })} /></Form.Item>
    <Form.Item label="副标题"><Input value={value.subtitle || ''} onChange={event => change({ subtitle: event.target.value })} /></Form.Item>
    <div className="editor-form-grid"><Form.Item label="纸张"><Select value={value.paper} options={[{ label: 'A4 纵向', value: 'A4' }, { label: 'A3 横向', value: 'A3' }]} onChange={paper => change({ paper })} /></Form.Item><Form.Item label="面数"><Select value={value.sides} options={[{ label: '单面', value: 1 }, { label: '双面', value: 2 }]} onChange={sides => { if (sides === 1 && value.questions.some(q => q.regions.some(r => r.page === 2))) { message.warning('背面已有答题区域，请先调整后再改为单面'); return } change({ sides }); setPage(1) }} /></Form.Item></div>
    <Form.Item label="准考证号位数"><InputNumber min={1} max={20} value={value.candidate_length} onChange={length => change({ candidate_length: length || 8 })} /></Form.Item>
    <Upload disabled={readOnly} accept="image/*" showUploadList={false} beforeUpload={async file => { const data = new FormData(); data.append('file', file); try { const asset = await request<Row>('/assets', { method: 'POST', body: data }); change({ background_assets: { ...value.background_assets, [String(page)]: asset.id } }); message.success('当前面底图已导入') } catch (e) { message.error((e as Error).message) } return false }}><Button disabled={readOnly}>导入当前面题卡底图</Button></Upload>
  </Form><div className="library-actions"><TemplateLibrary value={value} dirty={dirty} groupId={groupId} onCreated={async template => { await Promise.all([templates.reload(), groups.reload()]); load(template) }} /></div></div>
  const subjective = value.questions.filter(q => q.type === 'subjective').sort((a, b) => a.number - b.number)
  return <div className="template-workspace">
    <ErrorNotice error={templates.error || groups.error} retry={() => { void templates.reload(); void groups.reload() }} />
    <Card className="template-action-bar"><div className="template-actions">
      <Space wrap><Select className="template-select" showSearch optionFilterProp="label" placeholder="切换题卡" value={value.id || undefined} options={saved.map(t => ({ label: `${t.name} · ${t.status === 'published' ? '已发布' : '草稿'}`, value: t.id }))} onChange={id => { const item = saved.find(t => t.id === id); if (item) load(item) }} /><Dropdown menu={{ items: [
        { key: 'new', label: '新建题卡', icon: <PlusOutlined />, onClick: () => load(emptyTemplate(groupId)) },
        { key: 'copy', label: '复制为新草稿', icon: <CopyOutlined />, disabled: !value.id, onClick: () => load({ ...structuredClone(value), id: '', name: `${value.name}（副本）`, status: 'draft', revision: 0, group_id: groupId || value.group_id, questions: value.questions.map(q => ({ ...q, id: crypto.randomUUID() })) }) },
      ] }}><Button>题卡操作</Button></Dropdown></Space>
      <Space wrap><Text type="secondary">{value.questions.length} 题 · {total} 分</Text><Tag color={readOnly ? 'green' : dirty ? 'orange' : 'default'}>{readOnly ? '已发布' : dirty ? '未保存' : '草稿'}</Tag><Button icon={<SaveOutlined />} disabled={readOnly} loading={saving} onClick={() => save()}>保存草稿</Button><Button type="primary" disabled={readOnly} loading={saving} onClick={() => modal.confirm({ title: '审查并发布题卡？', content: '发布后固定版式与评分定义，后续修改需复制为新草稿。', onOk: () => save(true) })}>审查发布</Button><Button icon={<DownloadOutlined />} disabled={!value.id || dirty || !readOnly} aria-label="导出打印PDF" onClick={async () => { try { await download(`/templates/${value.id}/pdf`, `${value.name}.pdf`) } catch (e) { message.error((e as Error).message) } }}>打印稿</Button></Space>
    </div></Card>
    <div className="template-workbench">
      <Card className="template-config"><Tabs activeKey={pane} onChange={key=>{setPane(key);setAnswerMode(key==='objective')}} items={[
        { key: 'setup', label: '题卡设置', children: setup },
        { key: 'objective', label: '客观题', children: <ObjectiveEditor value={value} page={page} readOnly={readOnly} selected={questionId} onChange={questions => change({ questions })} onSelect={id => select(id)} onEdit={id => select(id, true)} /> },
        { key: 'subjective', label: '主观题', children: <div className="editor-section"><Button icon={<PlusOutlined />} disabled={readOnly} onClick={() => { const q = newQuestion(Math.max(0, ...value.questions.map(q => q.number)) + 1); change({ questions: [...value.questions, q] }); setQuestionId(q.id); setSettingsOpen(true) }}>添加主观题</Button><Table rowKey="id" size="middle" dataSource={subjective} pagination={{ defaultPageSize: 10 }} locale={{ emptyText: <Empty description="添加主观题后，在预览中框选答题区域" /> }} columns={[{ title: '题号', dataIndex: 'number' }, { title: '分值', dataIndex: 'points' }, { title: '区域', render: (_, q) => q.regions.length ? `${q.regions.length} 个` : '待框选' }, { title: '', render: (_, q) => <Button type="link" onClick={() => select(q.id, true)}>设置</Button> }]} /></div> },
      ]} /></Card>
      <Card className="template-preview" title="打印预览" extra={<Space wrap><Radio.Group value={page} onChange={event => setPage(event.target.value)} options={Array.from({ length: value.sides }, (_, i) => ({ label: i === 0 ? '正面' : '背面', value: i + 1 }))} />{!readOnly && <Radio.Group value={answerMode?'answer':draw?'draw':'move'} onChange={event=>{setAnswerMode(event.target.value==='answer');setDraw(event.target.value==='draw')}} options={[{label:'设答案',value:'answer'},{label:'框选',value:'draw'},{label:'移动',value:'move'}]} />}</Space>}>
        <Paper value={value} page={page} selected={questionId} draw={draw&&!answerMode} answerMode={answerMode} readOnly={readOnly} onAnswer={answerOnCard} onSelect={(id,targetPage)=>{setQuestionId(id);const q=value.questions.find(q=>q.id===id);if(q)setPane(q.type==='subjective'?'subjective':'objective');if(targetPage)setPage(targetPage)}} onRegion={(id, region, index) => change({ questions: value.questions.map(q => q.id === id ? { ...q, regions: index === undefined ? [...q.regions, region] : q.regions.map((r, i) => i === index ? region : r) } : q) })} />
        {!readOnly && <Text type="secondary" className="preview-selection">{answerMode?'点选图卡选项，或按1–5/A–E设答案；单选自动下一题，多选按Enter继续。':question?`当前选择第 ${question.number} 题 · 在预览上拖动可${draw?'添加答题区':'移动已有区域'}`:''}</Text>}
      </Card>
    </div>
    <QuestionSettings question={question} open={settingsOpen} readOnly={readOnly} onClose={() => setSettingsOpen(false)} onChange={patchQuestion} onDraw={() => { setDraw(true); setAnswerMode(false); setSettingsOpen(false) }} onDelete={() => { if (!question) return; change({ questions: value.questions.filter(q => q.id !== question.id) }); setQuestionId(''); setSettingsOpen(false) }} />
  </div>
}
