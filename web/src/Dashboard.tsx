import { useEffect, useState } from 'react'
import { Alert, Card, Empty, List, Progress, Space, Statistic, Tag, Typography } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './ErrorNotice'
import { useWorkspaceNotifications } from './WorkspaceNotifications'
import { useResource } from './api'

const eventKinds: Record<string, string> = {
  tasks: '评阅任务',
  scores: '评分',
  groups: '题卡',
  projects: '考试项目',
  subjects: '科目',
  'score-conversions': '赋分方案',
  pages: '扫描页',
  jobs: '后台任务',
}

export function Dashboard({ onNavigate, admin }: { onNavigate: (value: string) => void; admin: boolean }) {
  const { exams, events, activityLoaded, activityLoading, activityError, canViewActivity, reloadActivity } = useWorkspaceNotifications()
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    if (!events.length) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setClock(Date.now())
    }, 30000)
    return () => clearInterval(timer)
  }, [events.length])
  const ago = (value: string) => {
    const seconds = Math.max(0, Math.floor((clock - new Date(value.replace(' ', 'T') + 'Z').getTime()) / 1000))
    return seconds < 60 ? `${seconds}秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)}分钟前` : `${Math.floor(seconds / 3600)}小时前`
  }
  const resource = useResource<Record<string, number>>('/dashboard', {})
  const shortcuts: [string, string, string][] = admin
    ? [
        ['exams', '管理考试题卡', '名单、考场与阅卷分配'],
        ['scanner', '打开扫描台', '设备配对、扫描记录与补扫'],
        ['exceptions', '核查异常', '待处理记录与原卷'],
        ['results', '成绩总览', '多次对比与成绩导出'],
      ]
    : [
        ['marking', '阅卷中心', '按考试领取主观题评阅与仲裁任务'],
        ['results', '成绩总览', '查看和导出已授权的发布成绩'],
      ]
  const inProgressExams = exams.filter(e => e.exam_status !== 'completed')
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <ErrorNotice error={resource.error} retry={resource.reload} />
      {admin && (resource.data.exceptions > 0 || resource.data.pending_tasks > 0) && (
        <Alert
          type="info"
          showIcon
          message={[resource.data.exceptions > 0 ? `${resource.data.exceptions} 项异常待核查` : '', resource.data.pending_tasks > 0 ? `${resource.data.pending_tasks} 份作答待评阅` : ''].filter(Boolean).join(' · ')}
          action={
            <Space wrap>
              {resource.data.exceptions > 0 && <Button size="small" onClick={() => onNavigate('exceptions')}>前往异常总览</Button>}
              {resource.data.pending_tasks > 0 && <Button size="small" onClick={() => onNavigate('exams')}>打开考试项目</Button>}
            </Space>
          }
        />
      )}
      <div className="stat-grid">
        {[['projects', '考试项目'], ['groups', '题卡'], ['students', '学生'], ['pending_tasks', '待评作答'], ['exceptions', '待处理异常']].map(([key, label]) => (
          <Card key={key}>
            <Statistic loading={resource.loading} title={label} value={resource.data[key] ?? '—'} />
          </Card>
        ))}
      </div>
      <Card title="快捷操作" extra={<Button onClick={resource.reload} loading={resource.loading}>刷新</Button>}>
        <div className="workflow-grid">
          {shortcuts.map(([key, label, detail]) => (
            <button type="button" className="workflow-item" key={key} onClick={() => onNavigate(key)}>
              <strong>{label}</strong>
              <span className="help-text" style={{ marginTop: 0 }}>{detail}</span>
            </button>
          ))}
        </div>
      </Card>
      {canViewActivity && (
        <>
          <ErrorNotice error={activityError} retry={reloadActivity} />
          <Card title="进行中的考试与阅卷" extra={<Button size="small" loading={activityLoading} onClick={() => void reloadActivity()}>刷新</Button>}>
            <Table
              rowKey="id"
              loading={activityLoading && !activityLoaded}
              dataSource={inProgressExams}
              locale={{ emptyText: activityError ? '无法加载考试进度' : '暂无进行中的考试项目' }}
              columns={[
                { title: '考试', dataIndex: 'name', render: (name: string, row: any) => <a href={`#/exams/${row.id}`}>{name}</a> },
                { title: '已发布题卡', render: (_: unknown, row: any) => `${row.published} / ${row.cards}` },
                { title: '阅卷进度', render: (_: unknown, row: any) => <Progress percent={row.total ? Math.round((100 * row.completed) / row.total) : 0} format={() => `${row.completed} / ${row.total}`} /> },
              ]}
            />
          </Card>
          <Card title="最近操作" extra={<a href="#/settings/audit">查看全部</a>}>
            <List
              size="small"
              loading={activityLoading && !activityLoaded}
              dataSource={events.slice(0, 10)}
              locale={{ emptyText: activityError ? '无法加载操作记录' : '暂无可见操作' }}
              renderItem={(event: any) => (
                <List.Item>
                  <Space wrap>
                    <Typography.Text type="secondary">{ago(event.created)}</Typography.Text>
                    <strong>{event.actor_name || '系统'}</strong>
                    <Tag>{event.action === 'create' ? '新增' : event.action === 'delete' ? '删除' : '更新'}</Tag>
                    <span>{event.detail || eventKinds[event.kind] || event.kind || '记录'}</span>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </>
      )}
      {!resource.loading && !Object.keys(resource.data).length && !resource.error && <Empty description="尚无工作数据" />}
    </Space>
  )
}
