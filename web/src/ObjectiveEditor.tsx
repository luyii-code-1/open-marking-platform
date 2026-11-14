import { useRef, useState } from 'react'
import { Alert, App, Collapse, Empty, Form, Input, InputNumber, Modal, Select, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { PlusOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons'
import {questionNumbers} from './mergeQuestions'
import type { Question, Template } from './api'
import { addObjective, applyAnswers, arrangeObjective, answerLetters, parseAnswer } from './objectiveLayout'

const { Text, Title } = Typography
export function ObjectiveEditor({ value, page, readOnly, selected, onChange, onEdit, onSelect }: { value: Template; page: number; readOnly: boolean; selected?: string; onChange: (questions: Question[]) => void; onEdit: (id: string) => void; onSelect: (id: string) => void }) {
  const rows = value.questions.filter(q => q.type !== 'subjective').sort((a, b) => a.number - b.number)
  const [batchOpen, setBatchOpen] = useState(false), [layoutOpen, setLayoutOpen] = useState(false), [answerOpen, setAnswerOpen] = useState(false), [index, setIndex] = useState(0), [pasted, setPasted] = useState(''), [pasteError, setPasteError] = useState('')
  const [batchForm] = Form.useForm(), [layoutForm] = Form.useForm(), keys = useRef<HTMLDivElement>(null), { message } = App.useApp()
  const current = rows[Math.min(index, rows.length - 1)]
  const active = rows.find(q=>q.id===selected)||rows[0]
  const nextNumber = Math.max(0, ...value.questions.flatMap(questionNumbers)) + 1
  const defaults = { columns: 0, order: 'row', startPage: page }
  function changeAnswer(q: Question, text: string) {
    try { const answer = parseAnswer(q, text); onChange(value.questions.map(item => item.id === q.id ? { ...item, answer } : item)) }
    catch (e) { message.warning((e as Error).message) }
  }
  function choose(letter: string) {
    if (!current || readOnly) return
    changeAnswer(current, current.type === 'single' ? letter : current.answer.includes(letter) ? current.answer.filter(a => a !== letter).join('') : [...current.answer, letter].join(''))
    if (current.type === 'single') setIndex(i => Math.min(i + 1, rows.length - 1))
    keys.current?.focus()
  }
  const layoutFields = <div className="editor-form-grid"><Form.Item name="columns" label="每栏客观题列数" rules={[{ required: true }]}><Select options={[{label:'自动适配栏宽',value:0},...Array.from({length:10},(_,i)=>({label:(i+1)+' 列',value:i+1}))]} /></Form.Item><Form.Item name="order" label="题号顺序"><Select options={[{label:'从左到右，逐行排列',value:'row'},{label:'每组五行，逐列排列',value:'column'}]} /></Form.Item><Form.Item name="startPage" label="从哪一面开始" rules={[{ required: true }]}><Select options={Array.from({ length: value.sides }, (_, i) => ({ label: i === 0 ? '正面' : '背面', value: i + 1 }))} /></Form.Item></div>
  return <div className="editor-section">
    <div className="section-actions"><Button type="primary" icon={<PlusOutlined />} disabled={readOnly} onClick={() => { batchForm.setFieldsValue({ ...defaults, numbers: `${nextNumber}-${nextNumber + 19}`, type: 'single', options: 4, points: 2 }); setBatchOpen(true) }}>添加并排版</Button><Button disabled={!rows.length || readOnly} onClick={() => { setIndex(0); setPasted(''); setPasteError(''); setAnswerOpen(true) }}>集中录入答案</Button><Button disabled={!rows.length || readOnly} onClick={() => { layoutForm.setFieldsValue(defaults); setLayoutOpen(true) }}>重新排布</Button></div>
    {!!rows.length && <Text type="secondary">{rows.length} 题 · {rows.reduce((sum, q) => sum + q.points, 0)} 分 · 已录入 {rows.filter(q => q.answer.length).length} 题答案</Text>}
    {!!rows.length && <div className="objective-current"><Space wrap><Text strong>当前题目</Text><Select aria-label="选择题号" value={rows.find(q=>q.id===selected)?.id||rows[0].id} style={{width:130}} options={rows.map(q=>({label:`第${q.number}题`,value:q.id}))} onChange={onSelect}/><Text>答案：{active?.answer.join('')||'待设置'}</Text><InputNumber aria-label="当前题分值" min={0.01} precision={2} disabled={readOnly} value={active?.points} onChange={points=>{if(points!==null&&active)onChange(value.questions.map(q=>q.id===active.id?{...q,points}:q))}}/><Button onClick={()=>onEdit(active.id)}>详细设置</Button></Space><Typography.Paragraph type="secondary">在右侧图卡直接点选答案，逐题设置分值和多选给分方式。集中录入支持粘贴整组答案。</Typography.Paragraph></div>}
    <Collapse items={[{key:'questions',label:`题目明细（${rows.length}题）`,children:<Table rowKey="id" size="middle" dataSource={rows} pagination={{ defaultPageSize:50, showSizeChanger: true }} rowClassName={q => q.id === selected ? 'selected-question-row' : ''} scroll={{ x: 460 }} locale={{ emptyText: <Empty description="批量填写题号、题型和分值，自动生成答题区" /> }} columns={[
      { title: '题号', dataIndex: 'number', width: 64 },
      { title: '题型', dataIndex: 'type', width: 76, render: type => type === 'single' ? '单选' : '多选' },
      { title: '分值', width: 84, render: (_, q) => <InputNumber aria-label={`第${q.number}题分值`} min={0.01} precision={2} disabled={readOnly} value={q.points} onChange={points => { if (points !== null) onChange(value.questions.map(item => item.id === q.id ? { ...item, points } : item)) }} /> },
      { title: '答案', width: 96, render: (_, q) => <Input aria-label={`第${q.number}题答案`} disabled={readOnly} value={q.answer.join('')} placeholder={q.type === 'single' ? 'A' : 'AC'} maxLength={5} onFocus={event => { event.target.select(); onSelect(q.id) }} onChange={event => changeAnswer(q, event.target.value)} /> },
      { title: '区域', width: 72, render: (_, q) => q.regions.length ? q.regions.map(r => r.page === 1 ? '正' : '背').join(' / ') : <Tag color="orange">待框选</Tag> },
      { title: '', width: 72, render: (_, q) => <Button type="link" onClick={() => onEdit(q.id)}>设置</Button> },
    ]} /> }]} />
    <Modal title="批量添加客观题" open={batchOpen} onCancel={() => setBatchOpen(false)} onOk={() => batchForm.submit()} okText="添加并自动排布" width={620}>
      <Form form={batchForm} layout="vertical" onFinish={values => { try { const questions = addObjective(value, values); const first = questions.find(q => !value.questions.some(old => old.id === q.id)); onChange(questions); if (first) onSelect(first.id); setBatchOpen(false); message.success('客观题已添加，可继续录入答案') } catch (e) { message.error((e as Error).message) } }}>
        <Form.Item name="numbers" label="题号" extra="支持连续和跳号，例如 1-20,23,25-30" rules={[{ required: true }]}><Input autoFocus /></Form.Item>
        <div className="editor-form-grid"><Form.Item name="type" label="题型" rules={[{ required: true }]}><Select options={[{ label: '单选题', value: 'single' }, { label: '多选题', value: 'multiple' }]} /></Form.Item><Form.Item name="options" label="选项数" rules={[{ required: true }]}><Select options={[3, 4, 5].map(n => ({ label: `${n} 项`, value: n }))} /></Form.Item></div>
        <Form.Item name="points" label="每题分值" rules={[{ required: true }]}><InputNumber min={0.01} max={1000} precision={2} /></Form.Item>
        {layoutFields}<Text type="secondary">排布会避让已有答题区域，当前面不足时接续背面；空间不足时请调整题数或列数。</Text>
      </Form>
    </Modal>
    <Modal title="重新排布客观题" open={layoutOpen} onCancel={() => setLayoutOpen(false)} onOk={() => layoutForm.submit()} okText="确认排布">
      <Typography.Paragraph>重新安排本题卡全部客观题的答题区，主观题区域保持原位。手工调整过的客观题区域也会重新安排。</Typography.Paragraph>
      <Form form={layoutForm} layout="vertical" onFinish={values => { try { onChange(arrangeObjective(value, rows.map(q => q.id), values)); setLayoutOpen(false) } catch (e) { message.error((e as Error).message) } }}>{layoutFields}</Form>
    </Modal>
    <Modal title="集中录入客观题答案" open={answerOpen} onCancel={() => setAnswerOpen(false)} footer={<Button type="primary" onClick={() => setAnswerOpen(false)}>完成</Button>} afterOpenChange={open => { if (open) keys.current?.focus() }} width={620}>
      {current && <div className="answer-entry" ref={keys} tabIndex={0} onKeyDown={event => {
        if (event.target !== event.currentTarget || event.ctrlKey || event.altKey || event.metaKey) return
        const letter = /^[1-5]$/.test(event.key) ? answerLetters[Number(event.key) - 1] : /^[a-e]$/i.test(event.key) ? event.key.toUpperCase() : ''
        if (letter && answerLetters.slice(0, current.options).includes(letter)) { event.preventDefault(); choose(letter) }
        else if (['Enter', '6', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setIndex(i => Math.min(i + 1, rows.length - 1)) }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex(i => Math.max(0, i - 1)) }
      }}>
        <Text type="secondary">{index + 1} / {rows.length} · {current.type === 'single' ? '单选题' : '多选题'}</Text><Title level={3}>第 {current.number} 题</Title>
        <div className="answer-buttons">{[...answerLetters.slice(0, current.options)].map(letter => <Button size="large" key={letter} type={current.answer.includes(letter) ? 'primary' : 'default'} onClick={() => choose(letter)}>{letter}</Button>)}</div>
        <Text type="secondary">数字 1–5 对应 A–E。单选自动下一题，多选按 Enter 或 6 继续。</Text>
        <Space className="answer-pagination"><Button icon={<LeftOutlined />} disabled={index === 0} onClick={() => { setIndex(i => i - 1); keys.current?.focus() }}>上一题</Button><Button icon={<RightOutlined />} iconPosition="end" disabled={index >= rows.length - 1} onClick={() => { setIndex(i => i + 1); keys.current?.focus() }}>下一题</Button></Space>
      </div>}
      <Collapse items={[{ key: 'paste', label: '粘贴整组答案', children: <Space direction="vertical" size={16} style={{ width: '100%' }}><Text type="secondary">按题号顺序用空格或换行分隔，例如 A BC D；也可每行填写“1: A”。全为单选时支持连续字母。</Text><Input.TextArea rows={6} value={pasted} onChange={event => { setPasted(event.target.value); setPasteError('') }} aria-label="整组答案" />{pasteError && <Alert type="error" message={pasteError} />}<Button onClick={() => { try { onChange(applyAnswers(value.questions, pasted)); setPasteError(''); message.success('答案已校验并填入') } catch (e) { setPasteError((e as Error).message) } }}>校验并填入答案</Button></Space> }]} />
    </Modal>
  </div>
}
