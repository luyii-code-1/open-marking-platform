import type { Row } from './api'

const kindLabels: Record<string, string> = {
  'process-page': '答卷识别',
  'objective-reprocess': '客观题重识别',
  mirror: '云端同步',
  'archive-project': '生成归档',
  'preview-release': '核对释放清单',
  'release-project': '清理扫描文件',
  'restore-archive': '恢复扫描文件',
  'delete-hierarchy': '删除考试记录',
  'scheduled-backup': '定时备份',
}

const statusLabels: Record<string, string> = {
  pending: '等待中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
}

const statusColors: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  completed: 'success',
  failed: 'error',
}

export function jobKindLabel(kind?: string) {
  return (kind && kindLabels[kind]) || kind || '后台任务'
}

export function jobStatusLabel(status?: string) {
  return (status && statusLabels[status]) || status || '未知'
}

export function jobStatusColor(status?: string) {
  return (status && statusColors[status]) || 'default'
}

export function jobDetailText(job: Row) {
  if (job.status === 'failed') {
    return job.error_detail || (job.phase && job.phase !== '开始执行' ? `${job.phase}失败` : '执行失败，请核查后重试')
  }
  if (job.status === 'running') {
    const phase = job.phase && job.phase !== '开始执行' ? job.phase : '处理中'
    return job.progress_total ? `${phase}（${job.progress_current || 0}/${job.progress_total}）` : phase
  }
  if (job.status === 'pending') {
    return job.error_detail || '等待执行'
  }
  return job.phase || '已完成'
}
