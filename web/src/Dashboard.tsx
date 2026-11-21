import { Alert, Card, Empty, Space, Statistic } from 'antd'
import { Button } from './Button'
import { useResource } from './api'

export function Dashboard({ onNavigate, admin }: { onNavigate: (value: string) => void; admin: boolean }) {
  const resource = useResource<Record<string, number>>('/dashboard', {})
  const shortcuts: [string, string, string][] = admin
    ? [
        ['exams', '管理考试题卡', '名单、考场与阅卷分配'],
        ['scanner', '打开扫描台', '设备配对、扫描记录与补扫'],
        ['exceptions', '核查异常', '待处理记录与原卷'],
        ['results', '查看班级成绩', '班级报表与跨科汇总'],
      ]
    : [
        ['marking', '阅卷中心', '按考试领取主观题评阅与仲裁任务'],
        ['results', '成绩分析', '查看已授权班级的发布成绩、统计分析与试卷讲评'],
      ]
  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    {resource.error && <Alert type="error" showIcon message={resource.error} action={<Button onClick={resource.reload}>重试</Button>} />}
    {admin && (resource.data.exceptions > 0 || resource.data.pending_tasks > 0) && <Alert type="info" showIcon
      message={[resource.data.exceptions > 0 ? `${resource.data.exceptions} 项异常待核查` : '', resource.data.pending_tasks > 0 ? `${resource.data.pending_tasks} 份作答待评阅` : ''].filter(Boolean).join(' · ')}
      action={<Space wrap>{resource.data.exceptions > 0 && <Button size="small" onClick={() => onNavigate('exceptions')}>前往异常总览</Button>}{resource.data.pending_tasks > 0 && <Button size="small" onClick={() => onNavigate('exams')}>打开考试项目</Button>}</Space>} />}
    <div className="stat-grid">{[['projects', '考试项目'], ['groups', '题卡'], ['students', '学生'], ['pending_tasks', '待评作答'], ['exceptions', '待处理异常']].map(([key, label]) => <Card key={key}><Statistic loading={resource.loading} title={label} value={resource.data[key] ?? '—'} /></Card>)}</div>
    <Card title="快捷操作" extra={<Button onClick={resource.reload} loading={resource.loading}>刷新</Button>}><div className="workflow-grid">{shortcuts.map(([key, label, detail]) => <button type="button" className="workflow-item" key={key} onClick={() => onNavigate(key)}><strong>{label}</strong><span className="help-text" style={{ marginTop: 0 }}>{detail}</span></button>)}</div></Card>
    {!resource.loading && !Object.keys(resource.data).length && !resource.error && <Empty description="尚无工作数据" />}
  </Space>
}
