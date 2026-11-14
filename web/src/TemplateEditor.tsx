import { DraftSaver } from './draftSaver'
import {ScoringChanges} from './ScoringChanges'
import { useEffect, useRef, useState } from 'react'
import { Alert, App, Card, Dropdown, Empty, Form, Input, InputNumber, Modal, Radio, Select, Space, Tabs, Tag, Typography, Upload } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { CopyOutlined, DownloadOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons'
import { request, download, newQuestion, send, useResource, type Question, type Row, type Template } from './api'
import { ErrorNotice } from './EntityTable'
import { Paper } from './PrintPaper'
import { TemplateLibrary } from './TemplateLibrary'
import { HierarchyPicker } from './HierarchyPicker'
import { useUnsavedChanges } from './useNavigation'
import { ObjectiveEditor } from './ObjectiveEditor'
import { RichEditor } from './RichEditor'
import { QuestionSettings } from './QuestionSettings'

import { mergeQuestions, splitQuestions, questionNumbers, questionLabel } from './mergeQuestions'
import { uniformSubjectiveWidths } from './sheetRegions'

const { Text } = Typography
const emptyTemplate = (groupId = ''): Template => ({ id: crypto.randomUUID(), name: '新答题卡', group_id: groupId, paper: 'A4', sides: 2, layout_version: 3, sheet_columns: 1, notice_template:'standard-v1', notice_layout:2, column_frame:true, uniform_subjective:true, print_style:'standard-v2', forbidden_regions:[], candidate_length: 9, revision: 0, questions: [] })
const lockedVersion=(t:Template)=>t.status==='published'||t.status==='superseded'
const versionLabel=(t:Template)=>t.status==='superseded'?'历史版本':t.status==='published'?'已发布':'草稿'
const editableCopy=(t:Template):Template=>lockedVersion(t)?structuredClone(t):uniformSubjectiveWidths({
  ...structuredClone(t),layout_version:3,uniform_subjective:true,column_frame:t.column_frame??true,notice_layout:2,notice_template:t.notice_template||'standard-v1',
  print_style:'standard-v2',forbidden_regions:t.forbidden_regions||[],
})
export function TemplateEditor({ groupId }: { groupId?: string }) {
  const templates = useResource<Template[]>('/templates', []), groups = useResource<Row[]>('/groups', [])
  const [value, setValue] = useState<Template>(() => emptyTemplate(groupId)), [questionId, setQuestionId] = useState(''), [page, setPage] = useState(1), [draw, setDraw] = useState(true)
  const [saveAction, setSaveAction] = useState(''), [dirty, setDirty] = useState(false), [pane, setPane] = useState('objective'), [settingsOpen, setSettingsOpen] = useState(false)
  const [answerMode,setAnswerMode]=useState(true),[forbiddenMode,setForbiddenMode]=useState(false)
  const [mergeIds,setMergeIds]=useState<string[]>([])
  const [noteId,setNoteId]=useState('')
  const notes=value.print_notes||[], note=notes.find(n=>n.id===noteId&&n.page===page)
  const initialized = useRef(''), { message, modal } = App.useApp()
  const saverRef=useRef<DraftSaver<Template>|null>(null)
  const [,renderSave]=useState(0)
  if(!saverRef.current)saverRef.current=new DraftSaver(value,({value,request_id,base_version})=>request<Template>(`/groups/${value.group_id}/drafts/${value.id}`,{method:'PUT',body:JSON.stringify({value,request_id,base_version}),signal:AbortSignal.timeout(20000)}),()=>{setValue({...saverRef.current!.value});setDirty(saverRef.current!.dirty);renderSave(n=>n+1)})
  const saver=saverRef.current
  useEffect(()=>{if(saver.savedAt)void templates.reload()},[saver.savedAt])
  useEffect(()=>{if(!dirty||saver.error||saveAction||!value.group_id)return;const timer=setTimeout(()=>{void saver.flush().catch(()=>{})},2000);return()=>clearTimeout(timer)},[value,dirty,saveAction,saver.error])
  const saved = templates.data.filter(t => !groupId || t.group_id === groupId), readOnly = lockedVersion(value)
  const official=groups.data.find(g=>g.id===(groupId||value.group_id))?.template_id
  const saving = !!saveAction || (!!groupId && initialized.current !== groupId)
  const question = value.questions.find(q => q.id === questionId), total = value.questions.reduce((sum, q) => sum + Number(q.points || 0), 0)
  useUnsavedChanges(dirty)
  useEffect(() => {
    if (!groupId || initialized.current === groupId || !templates.loaded || !groups.loaded) return
    const group = groups.data.find(g => g.id === groupId)
    if (!group) return
    initialized.current = groupId
    const existing = saved.find(t => t.id === group.template_id) || saved.find(t => t.status === 'draft')
    saver.load(existing ? editableCopy(existing) : emptyTemplate(groupId))
    if(existing&&!lockedVersion(existing)&&JSON.stringify(existing)!==JSON.stringify(saver.value))saver.edit(saver.value)
  }, [groupId, templates.loaded, groups.loaded, templates.data, groups.data])
  function change(update: Partial<Template>) {
    if (readOnly || saving) return
    saver.edit(uniformSubjectiveWidths({ ...saver.value, ...update }))
  }
  function select(id: string, edit = false) {
    setQuestionId(id);setForbiddenMode(false)
    const q = value.questions.find(q => q.id === id)
    if (q) { setPane(q.type === 'subjective' ? 'subjective' : 'objective'); setAnswerMode(q.type!=='subjective');setDraw(q.type==='subjective'&&!q.parts); if (q.regions[0]) setPage(q.regions[0].page) }
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
    if (patch.number && value.questions.some(q => q.id !== question.id && questionNumbers(q).includes(patch.number!))) { message.warning('该题号已存在'); return }
    change({ questions: value.questions.map(q => q.id === question.id ? { ...q, ...patch } : q) })
    if (patch.type) setPane(patch.type === 'subjective' ? 'subjective' : 'objective')
  }
  function load(template: Template) {
    if(saver.saving)return
    const apply = () => { setDraw(template.questions.some(q=>q.type==='subjective'));saver.load(editableCopy(template)); if(!lockedVersion(template)&&JSON.stringify(template)!==JSON.stringify(saver.value))saver.edit(saver.value); setQuestionId(''); setNoteId('');setMergeIds([]); setPage(1); setSettingsOpen(false); setForbiddenMode(false); setAnswerMode(template.questions.some(q=>q.type!=='subjective')); setPane(template.questions.some(q => q.type !== 'subjective') ? 'objective' : template.questions.length ? 'subjective' : 'setup') }
    if (dirty) modal.confirm({ title: '切换题卡前放弃未保存修改？', onOk: apply }); else apply()
  }
  function removeVersion(){
    const target=value
    modal.confirm({title:'删除「'+target.name+'」？',content:target.id===official?'删除后，请先发布新版本再创建扫描批次。':'删除当前版式及其草稿内容。',okText:'删除',okButtonProps:{danger:true},onOk:async()=>{
      setSaveAction('delete')
      try{
        if(saver.saving||saver.dirty&&target.group_id)await saver.flush()
        if(saved.some(t=>t.id===target.id)||saver.savedAt){
          const version=saver.value
          await request(`/templates/${target.id}?draft_version=${version.draft_version||0}&expected_status=${version.status||'draft'}`,{method:'DELETE'})
        }
        const remaining=saved.filter(t=>t.id!==target.id&&t.group_id===target.group_id)
        saver.load(editableCopy(remaining.find(t=>t.id===official)||remaining.find(t=>t.status==='draft')||emptyTemplate(target.group_id)))
        setQuestionId('');setMergeIds([]);setPage(1);setNoteId('');setSettingsOpen(false)
        await Promise.all([templates.reload(),groups.reload()]);message.success('版式已删除')
      }catch(e){message.error((e as Error).message);throw e}finally{setSaveAction('')}
    }})
  }
  async function save(publish = false) {
    if (readOnly || saving) return
    if (!value.group_id || (groupId && value.group_id !== groupId)) { message.warning('请确认所属题卡'); return }
    setSaveAction(publish ? 'publish' : 'save')
    try {
      if (publish) {
        const check = await send<{ valid: boolean; issues: string[] }>('/templates/check', value)
        if (!check.valid) { modal.warning({ title: '发布前请完善以下内容', content: <ul className="validation-issues">{check.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> }); return }
      }
      if(!dirty&&!saved.some(t=>t.id===value.id))saver.edit(value)
      const stored = await saver.flush()
      if (publish) { saver.load(await send<Template>(`/templates/${stored.id}/publish`,{replace_id:official??null})); message.success('题卡已发布，可以导出打印稿') }
      else message.success('草稿已保存')
      await Promise.all([templates.reload(), groups.reload()])
    } catch (e) { message.error((e as Error).message) }
    finally { setSaveAction('') }
  }
  const setup = <div className="editor-section"><Form layout="vertical" disabled={readOnly || saving}>
    {!groupId && <Form.Item label="所属题卡" required><HierarchyPicker value={value.group_id} onChange={group_id => change({ group_id })} /></Form.Item>}
    <Form.Item label="题卡标题"><Input value={value.name} onChange={event => change({ name: event.target.value })} /></Form.Item>
    <Form.Item label="副标题"><Input value={value.subtitle || ''} onChange={event => change({ subtitle: event.target.value })} /></Form.Item>
    <div className="editor-form-grid"><Form.Item label="纸张"><Select value={value.paper} options={[{ label: 'A4 纵向', value: 'A4' }, { label: 'A3 横向', value: 'A3' }]} onChange={paper => change({ paper, sheet_columns: paper==='A3'?2:1, layout_version:3 })} /></Form.Item><Form.Item label="面数"><Select value={value.sides} options={[{ label: '单面', value: 1 }, { label: '双面', value: 2 }]} onChange={sides => { if (sides === 1 && (value.questions.some(q => q.regions.some(r => r.page === 2))||notes.some(n=>n.page===2)||(value.forbidden_regions||[]).some(r=>r.page===2))) { message.warning('背面已有答题区域，请先调整后再改为单面'); return } change({ sides }); setPage(1) }} /></Form.Item></div>
    {value.paper==='A3' && <Form.Item label="题卡分栏模板"><Select value={value.sheet_columns||2} options={[{label:"2×2 · 正反面各2栏",value:2},{label:"3×3 · 正反面各3栏",value:3}]} onChange={sheet_columns=>change({sheet_columns,layout_version:3})}/><Text type="secondary">内容依次续排到下一栏、下一面。改变模板后请重新排布客观题。</Text></Form.Item>}
    <Form.Item label="分栏底版"><Select value={value.column_frame?'framed':'classic'} options={[{label:'整栏圆角框与边缘提示',value:'framed'},{label:'逐题圆角框',value:'classic'}]} onChange={v=>change({column_frame:v==='framed'})}/></Form.Item>
    <Form.Item label="准考证号位数"><InputNumber min={1} max={readOnly&&value.print_style!=='standard-v2'?20:11} value={value.candidate_length} onChange={length => change({ candidate_length: length || 9 })} /></Form.Item>
    <Form.Item label="内置须知"><Select value={value.notice_template||'none'} options={[{label:'标准模板 · 考生禁填、注意事项与填涂样例',value:'standard-v1'},{label:'不添加',value:'none'}]} onChange={notice_template=>change({notice_template})}/><Text type="secondary">标准模板保留条形码核对及错区扣分说明；扣分文字用于印刷说明，不自动扣分。</Text></Form.Item>
    <Upload disabled={readOnly} accept="image/*" showUploadList={false} beforeUpload={async file => { const data = new FormData(); data.append('file', file); try { const asset = await request<Row>('/assets', { method: 'POST', body: data }); change({ background_assets: { ...value.background_assets, [String(page)]: asset.id } }); message.success('当前面底图已导入') } catch (e) { message.error((e as Error).message) } return false }}><Button disabled={readOnly || saving}>导入当前面题卡底图</Button></Upload>
  </Form><div className="library-actions"><TemplateLibrary disabled={saving||saver.saving} value={value} dirty={dirty||(!saved.some(t=>t.id===value.id)&&!saver.savedAt)} groupId={groupId} onCreated={async template => { await Promise.all([templates.reload(), groups.reload()]); load(template) }} /></div></div>
  function combine(){
    try{
      const q=mergeQuestions(value.questions,mergeIds)
      modal.confirm({title:'合并第 '+questionLabel(q)+' 题？',content:'合并后共 '+q.points+' 分，每份答卷只录一个总分。评阅方式、评分步长和双评允许差值沿用第 '+q.number+' 题的设置。',onOk:()=>{
        change({questions:value.questions.flatMap(row=>row.id===q.id?[q]:mergeIds.includes(row.id)?[]:[row])})
        setQuestionId(q.id);setMergeIds([]);setDraw(false);setPage(q.regions[0].page)
      }})
    }catch(e){message.warning((e as Error).message)}
  }
  const subjective = value.questions.filter(q => q.type === 'subjective').sort((a, b) => a.number - b.number)
  return <div className="template-workspace">
    <ErrorNotice error={templates.error || groups.error} retry={() => { void templates.reload(); void groups.reload() }} />
    <Card className="template-action-bar"><div className="template-actions">
      <Space wrap><Select disabled={saving||saver.saving} className="template-select" showSearch optionFilterProp="label" placeholder="选择版式草稿" value={value.id || undefined} options={[...saved.filter(t=>t.id!==value.id),value].map(t => ({ label: `${t.name} · ${versionLabel(t)}`, value: t.id }))} onChange={id => { const item = saved.find(t => t.id === id); if (item) load(item) }} /><Dropdown menu={{ items: [
        { key: 'new', label: '新建版式草稿', icon: <PlusOutlined />, onClick: () => load(emptyTemplate(groupId)) },
        { key: 'copy', label: '复制为新草稿', icon: <CopyOutlined />, disabled: !value.id, onClick: () => load({ ...structuredClone(value), id: crypto.randomUUID(), draft_version:0, name: `${value.name}（副本）`, status: 'draft', revision: 0, layout_version:3, sheet_columns:value.paper==='A3'?(value.sheet_columns||2):1, notice_template:value.notice_template||'standard-v1', print_style:'standard-v2', forbidden_regions:value.forbidden_regions||[], group_id: groupId || value.group_id, questions: value.questions.map(q => ({ ...q, id: crypto.randomUUID() })) }) },
        {key:'delete',label:'删除当前版式',danger:true,onClick:removeVersion},
      ] }}><Button disabled={saving||saver.saving}>题卡操作</Button></Dropdown></Space>
      <Space wrap><Text type="secondary">{value.questions.length} 题 · {total} 分</Text><Tag color={readOnly ? 'green' : dirty ? 'orange' : 'default'}>{readOnly ? versionLabel(value) : saver.saving ? '正在保存…' : saver.error ? '保存失败' : dirty ? '等待自动保存' : saver.savedAt ? '已保存 '+new Date(saver.savedAt).toLocaleTimeString() : '草稿'}</Tag><Button icon={<SaveOutlined />} disabled={readOnly || saving} loading={saveAction === 'save'} onClick={() => save()}>保存草稿</Button><Button type="primary" disabled={readOnly || saving} loading={saveAction === 'publish'} onClick={() => modal.confirm({ title: official?'替换当前发布版本？':'发布这张题卡？', content: official?'将用「'+value.name+'」替换「'+(saved.find(t=>t.id===official)?.name||'当前版本')+'」。新扫描批次使用新版，已有答卷仍关联原版本。':'发布后可打印并开始扫描。', onOk: () => save(true) })}>审查发布</Button>{value.status==='published'&&<ScoringChanges template={value} onSaved={async()=>{const next=await request<Template[]>('/templates');const t=next.find(t=>t.id===value.id);if(t)load(t);await templates.reload();await groups.reload()}}/>}<Button icon={<DownloadOutlined />} disabled={!value.id || dirty || !readOnly} aria-label="导出打印PDF" onClick={async () => { try { await download(`/templates/${value.id}/pdf`, `${value.name}.pdf`) } catch (e) { message.error((e as Error).message) } }}>打印稿</Button></Space>
    </div></Card>
    {saver.error&&<Alert type="error" showIcon message="草稿未保存" description={saver.error} action={<Space><Button onClick={()=>void saver.flush().catch(()=>{})}>重试保存</Button><Button onClick={()=>modal.confirm({title:"重新载入服务器草稿？",content:"当前未保存的修改将被替换。",onOk:async()=>{const rows=await request<Template[]>('/templates');const latest=rows.find(t=>t.id===value.id);if(!latest)throw new Error("服务器尚无该草稿，请重试保存");saver.load(editableCopy(latest));await templates.reload()}})}>重新载入</Button></Space>}/>}
    <div className="template-workbench">
      <Card className="template-config"><Tabs activeKey={pane} onChange={key=>{setPane(key);setForbiddenMode(false);setAnswerMode(key==='objective');setDraw(key==='subjective');if(key==='subjective'&&question?.type!=='subjective')setQuestionId(subjective[0]?.id||'')}} items={[
        { key: 'setup', label: '底版', children: setup },
        { key: 'objective', label: '选择题', children: <ObjectiveEditor value={value} page={page} readOnly={readOnly || saving} selected={questionId} onChange={questions => change({ questions, layout_version:3 })} onSelect={id => select(id)} onEdit={id => select(id, true)} /> },
        { key: 'subjective', label: '主观题', children: <div className="editor-section"><Space wrap><Button icon={<PlusOutlined />} disabled={readOnly||saving} onClick={() => { const q = newQuestion(Math.max(0, ...value.questions.flatMap(questionNumbers)) + 1); change({ questions: [...value.questions, q] }); setQuestionId(q.id); setDraw(true); setAnswerMode(false); setForbiddenMode(false) }}>添加主观题并框选</Button><Button disabled={readOnly||saving||mergeIds.length<2} onClick={combine}>合并题目</Button></Space><Text type="secondary">选中题号，在对应栏内从上往下拖出作答范围。</Text><Table<Question> rowSelection={readOnly?undefined:{selectedRowKeys:mergeIds,onChange:keys=>setMergeIds(keys.map(String)),getCheckboxProps:q=>({disabled:!!q.parts||saving})}} rowClassName={q=>q.id===questionId?'selected-question-row':''} onRow={q=>({onClick:()=>{setQuestionId(q.id);setDraw(!q.parts);if(q.regions.length)setPage(q.regions[0].page)}})} rowKey="id" size="middle" dataSource={subjective} pagination={{ defaultPageSize:50 }} locale={{ emptyText: <Empty description="添加主观题后，在预览中框选答题区域" /> }} columns={[{ title: '题号', render:(_,q)=>questionLabel(q) }, { title: '分值', render:(_,q)=><InputNumber aria-label={'第'+q.number+'题分值'} disabled={readOnly||saving||!!q.parts} min={0.01} precision={2} value={q.points} onChange={points=>{if(points!==null)change({questions:value.questions.map(item=>item.id===q.id?{...item,points}:item)})}}/> }, { title: '区域', render: (_, q) => q.regions.length ? `${q.regions.length} 个` : '待框选' }, { title: '', render: (_, q) => <Button type="link" onClick={() => select(q.id, true)}>设置</Button> }]} /></div> },
        { key:'notes',label:'版面文字',children:<div className="editor-section">
          <Text>点击网格添加题号或提示，也可拖出文字框。拖动文字框移动，拖右下角调整大小。</Text>
          {!!notes.filter(n=>n.page===page).length&&<Select aria-label="当前面的文字框" placeholder="选择文字框" value={note?.id} onChange={setNoteId} options={notes.filter(n=>n.page===page).map((n,i)=>({value:n.id,label:new DOMParser().parseFromString(n.html,'text/html').body.textContent?.trim().slice(0,35)||('文字框 '+(i+1))}))}/>}
          {note&&<><RichEditor key={note.id} readOnly={readOnly||saving} value={note.html} onChange={html=>change({print_notes:notes.map(n=>n.id===note.id?{...n,html}:n)})}/><Button danger disabled={readOnly||saving} onClick={()=>{change({print_notes:notes.filter(n=>n.id!==note.id)});setNoteId('')}}>删除文字框</Button></>}
        </div>}
      ]} /></Card>
      <Card className="template-preview" title={pane==='notes'?'文字排版网格':'题卡画布'} extra={<Space wrap><Radio.Group value={page} onChange={event => setPage(event.target.value)} options={Array.from({ length: value.sides }, (_, i) => ({ label: i === 0 ? '正面' : '背面', value: i + 1 }))} />{!readOnly && pane!=='notes' && <Radio.Group value={forbiddenMode?'forbidden':answerMode?'answer':draw?'draw':'move'} onChange={event=>{setForbiddenMode(event.target.value==='forbidden');setAnswerMode(event.target.value==='answer');setDraw(event.target.value==='draw')}} options={[...(pane==='objective'?[{label:'设答案',value:'answer'}]:[]),...(pane==='subjective'?[{label:'框选题区',value:'draw'}]:[]),{label:'移动',value:'move'},...(pane==='setup'?[{label:'禁答区',value:'forbidden'}]:[])]} />}</Space>}>
        <Paper noteMode={pane==='notes'} selectedNote={noteId} onNoteSelect={setNoteId} onNoteRegion={(region,id)=>{
          if(id){change({print_notes:notes.map(n=>n.id===id?{...n,...region}:n)});return}
          const added={...region,id:crypto.randomUUID(),html:'<p>文字</p>'}
          change({print_notes:[...notes,added]});setNoteId(added.id)
        }} value={value} page={page} selected={questionId} draw={draw&&!answerMode&&!forbiddenMode&&!question?.parts} forbiddenMode={forbiddenMode} onForbidden={forbidden_regions=>change({forbidden_regions})} answerMode={answerMode} readOnly={readOnly || saving} onAnswer={answerOnCard} onSelect={(id,targetPage)=>{setQuestionId(id);const q=value.questions.find(q=>q.id===id);if(q){setPane(q.type==='subjective'?'subjective':'objective');if(q.type==='subjective')setAnswerMode(false)}if(targetPage)setPage(targetPage)}} onRegion={(id, region, index) => change({ questions: value.questions.map(q => q.id === id ? { ...q, regions: index === undefined ? [...q.regions, region] : q.regions.map((r, i) => i === index ? region : r) } : q) })} />
        {!readOnly && pane!=='notes' && <Text type="secondary" className="preview-selection">{forbiddenMode?'禁答区保存到当前题卡，与打印稿一致。':answerMode?'点选图卡选项，或按1–5/A–E设答案；单选自动下一题，多选按Enter继续。':question?`当前选择第 ${question.number} 题 · 在预览上拖动可${draw?'添加答题区':'移动已有区域'}`:''}</Text>}
      </Card>
    </div>
    <QuestionSettings onSplit={()=>{if(!question?.parts)return;change({questions:value.questions.flatMap(q=>q.id===question.id?splitQuestions(q):[q])});setSettingsOpen(false);setMergeIds([])}} question={question} open={settingsOpen} readOnly={readOnly || saving} onClose={() => setSettingsOpen(false)} onChange={patchQuestion} onDraw={() => { setForbiddenMode(false); setDraw(true); setAnswerMode(false); setSettingsOpen(false) }} onDelete={() => { if (!question) return; change({ questions: value.questions.filter(q => q.id !== question.id) }); setQuestionId(''); setSettingsOpen(false) }} />
  </div>
}
