import { useEffect, useState } from 'react'
import { App, Collapse, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { PlusOutlined } from '@ant-design/icons'
import { AnswerEntry } from './AnswerEntry'
import { questionNumbers } from './mergeQuestions'
import { TagPicker } from './TagPicker'
import type { Question, Template } from './api'
import { addObjective, arrangeObjective, parseAnswer } from './objectiveLayout'

const { Text } = Typography
export function ObjectiveEditor({ value, page, readOnly, selected, onChange, onEdit, onSelect }: { value: Template; page: number; readOnly: boolean; selected?: string; onChange: (questions: Question[]) => void; onEdit: (id: string) => void; onSelect: (id: string) => void }) {
  const rows = value.questions.filter(q => q.type !== 'subjective').sort((a, b) => a.number - b.number)
  const [batchOpen, setBatchOpen] = useState(false), [layoutOpen, setLayoutOpen] = useState(false), [answerOpen, setAnswerOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [batchPoints, setBatchPoints] = useState<number | null>(2)
  const [batchForm] = Form.useForm(), [layoutForm] = Form.useForm(), { message } = App.useApp()
  const active = rows.find(q => q.id === selected) || rows[0]
  const nextNumber = Math.max(0, ...value.questions.flatMap(questionNumbers)) + 1
  const defaults = { columns: 0, order: 'row', startPage: page }

  useEffect(() => {
    setSelectedIds(prev => prev.filter(id => rows.some(r => r.id === id)))
  }, [value.id, rows.length])

  function changeAnswer(q: Question, text: string) {
    try {
      const answer = parseAnswer(q, text)
      onChange(value.questions.map(item => (item.id === q.id ? { ...item, answer } : item)))
    } catch (e) {
      message.warning((e as Error).message)
    }
  }

  function applyBatchPoints() {
    if (!selectedIds.length || batchPoints == null || batchPoints <= 0) return
    const idSet = new Set(selectedIds)
    onChange(value.questions.map(q => (idSet.has(q.id) ? { ...q, points: batchPoints } : q)))
    message.success(`已将 ${selectedIds.length} 道选择题分值设为 ${batchPoints} 分`)
  }

  function applyBatchType(nextType: 'single' | 'multiple') {
    if (!selectedIds.length) return
    const idSet = new Set(selectedIds)
    onChange(
      value.questions.map(q =>
        idSet.has(q.id)
          ? { ...q, type: nextType, answer: nextType === 'single' ? q.answer.slice(0, 1) : q.answer }
          : q,
      ),
    )
    message.success(`已将 ${selectedIds.length} 题设为${nextType === 'single' ? '单选题' : '多选题'}`)
  }

  function deleteSelected() {
    if (!selectedIds.length) return
    const idSet = new Set(selectedIds)
    onChange(value.questions.filter(q => !idSet.has(q.id)))
    setSelectedIds([])
    message.success(`已删除 ${idSet.size} 道选择题`)
  }

  const layoutFields = (
    <>
      <div className="editor-form-grid">
        <Form.Item name="columns" label="每栏客观题列数" rules={[{ required: true }]}>
          <Select options={[{ label: '自动适配栏宽', value: 0 }, ...Array.from({ length: 10 }, (_, i) => ({ label: `${i + 1} 列`, value: i + 1 }))]} />
        </Form.Item>
        <Form.Item name="order" label="题号顺序">
          <Select options={[{ label: '从左到右，逐行排列', value: 'row' }, { label: '每组五行，逐列排列', value: 'column' }]} />
        </Form.Item>
      </div>
      <Form.Item name="startPage" label="从哪一面开始" rules={[{ required: true }]}>
        <TagPicker compact options={Array.from({ length: value.sides }, (_, i) => ({ label: i === 0 ? '正面' : '背面', value: i + 1 }))} />
      </Form.Item>
    </>
  )

  return (
    <div className="editor-section">
      <div className="section-actions">
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          disabled={readOnly}
          onClick={() => {
            batchForm.setFieldsValue({ ...defaults, numbers: `${nextNumber}-${nextNumber + 19}`, type: 'single', options: 4, points: 2 })
            setBatchOpen(true)
          }}
        >
          添加并排版
        </Button>
        <Button size="small" disabled={!rows.length || readOnly} onClick={() => setAnswerOpen(true)}>
          集中录入答案
        </Button>
        <Button
          size="small"
          disabled={!rows.length || readOnly}
          onClick={() => {
            layoutForm.setFieldsValue(defaults)
            setLayoutOpen(true)
          }}
        >
          重新排布
        </Button>
      </div>
      {!!rows.length && (
        <Space wrap size={8} style={{ justifyContent: 'space-between', width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {rows.length} 题 · {rows.reduce((sum, q) => sum + q.points, 0)} 分 · 已设答案 {rows.filter(q => q.answer.length).length} 题
          </Text>
          {active && (
            <Button size="small" type="link" style={{ paddingInline: 0 }} onClick={() => onEdit(active.id)}>
              第{active.number}题详细设置
            </Button>
          )}
        </Space>
      )}
      {!readOnly && selectedIds.length > 0 && (
        <div className="question-batch-bar">
          <Space wrap size={6}>
            <Text style={{ fontSize: 12 }}>已选 {selectedIds.length} 题</Text>
            <InputNumber
              size="small"
              min={0.01}
              precision={2}
              value={batchPoints}
              onChange={setBatchPoints}
              style={{ width: 64 }}
              aria-label="批量分值"
            />
            <Button size="small" onClick={applyBatchPoints}>设分</Button>
            <Button size="small" onClick={() => applyBatchType('single')}>单选</Button>
            <Button size="small" onClick={() => applyBatchType('multiple')}>多选</Button>
            <Popconfirm title={`删除选中的 ${selectedIds.length} 道选择题？`} onConfirm={deleteSelected}>
              <Button size="small" danger>删除</Button>
            </Popconfirm>
            <Button size="small" type="text" onClick={() => setSelectedIds([])}>取消</Button>
          </Space>
        </div>
      )}
      <Collapse
        defaultActiveKey={['questions']}
        size="small"
        items={[
          {
            key: 'questions',
            label: `题目明细（${rows.length}题）`,
            children: (
              <Table
                rowKey="id"
                size="small"
                columnChooser={false}
                exportable={false}
                dataSource={rows}
                pagination={rows.length > 50 ? { defaultPageSize: 50, size: 'small' } : false}
                rowSelection={
                  readOnly
                    ? undefined
                    : {
                        columnWidth: 32,
                        selectedRowKeys: selectedIds,
                        onChange: keys => setSelectedIds(keys.map(String)),
                      }
                }
                rowClassName={q => (q.id === selected ? 'selected-question-row' : '')}
                onRow={q => ({ onClick: () => onSelect(q.id) })}
                locale={{ emptyText: <Empty description="批量填写题号、题型和分值，自动生成答题区" /> }}
                columns={[
                  {
                    title: '题号',
                    dataIndex: 'number',
                    width: 66,
                    render: (num: number, q: Question) => (
                      <Space size={4}>
                        <span>{num}</span>
                        {q.type === 'multiple' && <Tag color="blue" style={{ marginInlineEnd: 0, fontSize: 11, paddingInline: 4, lineHeight: '16px' }}>多</Tag>}
                      </Space>
                    ),
                  },
                  {
                    title: '分值',
                    width: 72,
                    render: (_: unknown, q: Question) => (
                      <InputNumber
                        size="small"
                        aria-label={`第${q.number}题分值`}
                        min={0.01}
                        precision={2}
                        disabled={readOnly}
                        value={q.points}
                        onClick={e => e.stopPropagation()}
                        onChange={points => {
                          if (points !== null) onChange(value.questions.map(item => (item.id === q.id ? { ...item, points } : item)))
                        }}
                      />
                    ),
                  },
                  {
                    title: '答案',
                    width: 78,
                    render: (_: unknown, q: Question) => (
                      <Input
                        size="small"
                        aria-label={`第${q.number}题答案`}
                        disabled={readOnly}
                        value={q.answer.join('')}
                        placeholder={q.type === 'single' ? 'A' : 'AC'}
                        maxLength={7}
                        onClick={e => e.stopPropagation()}
                        onFocus={event => {
                          event.target.select()
                          onSelect(q.id)
                        }}
                        onChange={event => changeAnswer(q, event.target.value)}
                      />
                    ),
                  },
                  {
                    title: '',
                    width: 48,
                    render: (_: unknown, q: Question) => (
                      <Button
                        size="small"
                        type="link"
                        style={{ paddingInline: 2 }}
                        onClick={e => {
                          e.stopPropagation()
                          onEdit(q.id)
                        }}
                      >
                        设置
                      </Button>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <Modal title="批量添加客观题" open={batchOpen} onCancel={() => setBatchOpen(false)} onOk={() => batchForm.submit()} okText="添加并自动排布" width={560}>
        <Form
          form={batchForm}
          layout="vertical"
          onFinish={values => {
            try {
              const questions = addObjective(value, values)
              const first = questions.find(q => !value.questions.some(old => old.id === q.id))
              onChange(questions)
              if (first) onSelect(first.id)
              setBatchOpen(false)
              message.success('客观题已添加，可继续录入答案')
            } catch (e) {
              message.error((e as Error).message)
            }
          }}
        >
          <Form.Item name="numbers" label="题号" extra="支持连续和跳号，例如 1-20,23,25-30" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <div className="editor-form-grid">
            <Form.Item name="type" label="题型" rules={[{ required: true }]}>
              <TagPicker compact options={[{ label: '单选题', value: 'single' }, { label: '多选题', value: 'multiple' }]} />
            </Form.Item>
            <Form.Item name="options" label="选项数" rules={[{ required: true }]}>
              <TagPicker compact options={[3, 4, 5, 6, 7].map(n => ({ label: `${n} 项`, value: n }))} />
            </Form.Item>
          </div>
          <Form.Item name="points" label="每题分值" rules={[{ required: true }]}>
            <InputNumber min={0.01} max={1000} precision={2} />
          </Form.Item>
          {layoutFields}
          <Text type="secondary">排布会避让已有答题区域，当前面不足时接续背面；空间不足时请调整题数或列数。</Text>
        </Form>
      </Modal>
      <Modal title="重新排布客观题" open={layoutOpen} onCancel={() => setLayoutOpen(false)} onOk={() => layoutForm.submit()} okText="确认排布">
        <Typography.Paragraph>重新安排本题卡全部客观题的答题区，主观题区域保持原位。手工调整过的客观题区域也会重新安排。</Typography.Paragraph>
        <Form
          form={layoutForm}
          layout="vertical"
          onFinish={values => {
            try {
              onChange(arrangeObjective(value, rows.map(q => q.id), values))
              setLayoutOpen(false)
            } catch (e) {
              message.error((e as Error).message)
            }
          }}
        >
          {layoutFields}
        </Form>
      </Modal>
      <Modal title="集中录入客观题答案" open={answerOpen} onCancel={() => setAnswerOpen(false)} footer={<Button type="primary" onClick={() => setAnswerOpen(false)}>完成</Button>} width={620}>
        <AnswerEntry
          active={answerOpen}
          questions={rows}
          readOnly={readOnly}
          onChange={next => {
            const answers = new Map(next.map(question => [question.id, question.answer]))
            onChange(value.questions.map(question => (answers.has(question.id) ? { ...question, answer: answers.get(question.id)! } : question)))
          }}
        />
      </Modal>
    </div>
  )
}
