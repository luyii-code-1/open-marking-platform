import {useEffect} from 'react'
import {questionLabel} from './mergeQuestions'
import { Alert, Card, Progress, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ErrorNotice } from './Management'
import { useResource, watchChanges, type Row, type Template, type Question } from './api'
import { useReviewWorkspace } from './ReviewWorkspace'

type ReviewTask = { key: string; template: Template; question: Question; exam: string; subject: string }

function TaskProgress({ progress }: { progress?: Row }) {
  if (!progress) return <Typography.Text type="secondary">加载进度…</Typography.Text>
  const total=(progress.ordinary_total||0)+(progress.arbitration_total||0),done=(progress.ordinary_completed||0)+(progress.arbitration_completed||0)
  return <div className="review-task-progress"><span>阅卷 {progress.ordinary_completed||0} / {progress.ordinary_total||0} · 仲裁 {progress.arbitration_completed||0} / {progress.arbitration_total||0}</span><Progress percent={total?Math.round(done/total*100):0} size="small" showInfo={false}/>{progress.arbitration_pending>0?<Tag color="orange">待仲裁 {progress.arbitration_pending} 份</Tag>:progress.ordinary_pending>0?<Tag>待阅卷 {progress.ordinary_pending} 份</Tag>:<Typography.Text type="secondary">已完成{progress.can_arbitrate?' · 持续检查新仲裁':''}</Typography.Text>}</div>
}

export function ReviewTasks({ onOpen }: { onOpen: (templateId: string, questionId: string) => void }) {
  const workspace = useReviewWorkspace()
  const progress=useResource<Row[]>('/review-task-progress',[])
  useEffect(()=>{const refresh=()=>{if(!document.hidden&&navigator.onLine)void progress.reload()},timer=setInterval(refresh,15000),unwatch=watchChanges(roots=>{if(!roots||roots.some(root=>['tasks','assignments','review-results'].includes(root)))refresh()});window.addEventListener('focus',refresh);return()=>{clearInterval(timer);unwatch();window.removeEventListener('focus',refresh)}},[progress.reload])
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
  const status=(row:ReviewTask)=>progress.data.find(p=>p.template_id===row.template.id&&p.question_id===row.question.id)
  rows.sort((a,b)=>(status(b)?.arbitration_pending||0)-(status(a)?.arbitration_pending||0))
  const pendingArbitrations=progress.data.reduce((sum,p)=>sum+(p.arbitration_pending||0),0)
  return <Card title="我的阅卷任务" extra={<Button onClick={() => { void templates.reload(); void assignments.reload();void progress.reload() }}>刷新任务</Button>}>
    <ErrorNotice error={templates.error || assignments.error || progress.error} />
    {pendingArbitrations>0&&<Alert type="warning" showIcon message={`有 ${pendingArbitrations} 份答卷待仲裁，进入题目后优先处理仲裁。`} style={{marginBottom:16}}/>}
    <Table<ReviewTask> rowKey="key" dataSource={rows} loading={templates.loading || assignments.loading} pagination={{ defaultPageSize:50, hideOnSinglePage: true }} scroll={{ x: 700 }} locale={{ emptyText: '暂无分配给你的阅卷任务，请联系管理员分配题目。' }} columns={[
      { title: '考试 / 科目', render: (_, row) => <Space direction="vertical" size={2}><Typography.Text strong>{row.exam}</Typography.Text><Typography.Text type="secondary">{[row.subject, row.template.name].filter(Boolean).join(' · ')}</Typography.Text></Space> },
      { title: '评阅题目', width: 170, render: (_, row) => <Space direction="vertical" size={4}><Typography.Text>第 {questionLabel(row.question)} 题 · {row.question.points} 分</Typography.Text><Tag>{row.question.review_mode === 'double' ? '双评' : '单评'}</Tag></Space> },
      { title: '我的进度', width: 190, render: (_, row) => <TaskProgress progress={status(row)} /> },
      { title: '操作', width: 150, render: (_, row) => <Button type="primary" onClick={() => onOpen(row.template.id, row.question.id)}>{(status(row)?.arbitration_pending||0)>0?'进入仲裁':workspace.records.some(r => r.template.id === row.template.id && r.question.id === row.question.id && r.status !== 'confirmed')?'继续阅卷':status(row)&&!status(row)?.ordinary_pending?status(row)?.can_arbitrate?'检查仲裁':'查看任务':'进入阅卷'}</Button> },
    ]} />
  </Card>
}
