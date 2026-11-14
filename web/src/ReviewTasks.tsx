import { Card, Progress, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ErrorNotice } from './Management'
import { useResource, type Row, type Template, type Question } from './api'
import { useReviewWorkspace } from './ReviewWorkspace'

type ReviewTask = { key: string; template: Template; question: Question; exam: string; subject: string }

function TaskProgress({ task }: { task: ReviewTask }) {
  const resource = useResource<Row>(`/review-progress?template_id=${task.template.id}&question_id=${task.question.id}`, {} as Row)
  if (resource.error) return <Typography.Text type="secondary">进度暂不可用</Typography.Text>
  if (!resource.loaded) return <Typography.Text type="secondary">加载中…</Typography.Text>
  return <div className="review-task-progress"><span>已评 {resource.data.my_completed || 0} / {resource.data.my_total || 0} 份</span><Progress percent={resource.data.my_progress || 0} size="small" showInfo={false} /></div>
}

export function ReviewTasks({ onOpen }: { onOpen: (templateId: string, questionId: string) => void }) {
  const workspace = useReviewWorkspace()
  const templates = useResource<Template[]>('/templates', []), assignments = useResource<Row[]>('/assignments', [])
  const groups = useResource<Row[]>('/groups', []), subjects = useResource<Row[]>('/subjects', []), projects = useResource<Row[]>('/projects', [])
  const rows: ReviewTask[] = []
  for (const template of templates.data) {
    const group = groups.data.find(g => g.id === template.group_id), subject = subjects.data.find(s => s.id === group?.subject_id)
    for (const question of template.questions) {
      if (question.type !== 'subjective' || !assignments.data.some(a => a.template_id === template.id && a.question_id === question.id && [...(a.user_ids || []), ...(a.arbitrator_ids || [])].includes(workspace.user.id))) continue
      rows.push({ key: `${template.id}:${question.id}`, template, question, exam: projects.data.find(p => p.id === subject?.project_id)?.name || template.name, subject: subject?.name || '' })
    }
  }
  for (const record of workspace.records) {
    if (record.status === 'confirmed' || rows.some(r => r.template.id === record.template.id && r.question.id === record.question.id)) continue
    rows.push({ key: `${record.template.id}:${record.question.id}`, template: { ...record.template, questions: [record.question] } as Template, question: record.question, exam: record.template.name, subject: '' })
  }
  return <Card title="我的阅卷任务" extra={<Button onClick={() => { void templates.reload(); void assignments.reload() }}>刷新任务</Button>}>
    <ErrorNotice error={templates.error || assignments.error} />
    <Table<ReviewTask> rowKey="key" dataSource={rows} loading={templates.loading || assignments.loading} pagination={{ defaultPageSize:50, hideOnSinglePage: true }} scroll={{ x: 700 }} locale={{ emptyText: '暂无分配给你的阅卷任务，请联系管理员分配题目。' }} columns={[
      { title: '考试 / 科目', render: (_, row) => <Space direction="vertical" size={2}><Typography.Text strong>{row.exam}</Typography.Text><Typography.Text type="secondary">{[row.subject, row.template.name].filter(Boolean).join(' · ')}</Typography.Text></Space> },
      { title: '评阅题目', width: 170, render: (_, row) => <Space direction="vertical" size={4}><Typography.Text>第 {row.question.number} 题 · {row.question.points} 分</Typography.Text><Tag>{row.question.review_mode === 'double' ? '双评' : '单评'}</Tag></Space> },
      { title: '我的进度', width: 190, render: (_, row) => <TaskProgress task={row} /> },
      { title: '操作', width: 150, render: (_, row) => <Button type="primary" onClick={() => onOpen(row.template.id, row.question.id)}>{workspace.records.some(r => r.template.id === row.template.id && r.question.id === row.question.id && r.status !== 'confirmed') ? '继续阅卷' : '进入阅卷'}</Button> },
    ]} />
  </Card>
}
