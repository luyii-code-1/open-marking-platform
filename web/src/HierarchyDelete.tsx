import { useEffect, useRef, useState } from 'react'
import { Alert, App, Checkbox, Descriptions, Dropdown, Input, Modal, Progress, Space, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { MoreOutlined } from '@ant-design/icons'
import { announceChanges, download, request, send, type Row } from './api'

export function HierarchyDelete({ kind, target, onDeleted }: { kind: 'projects' | 'subjects' | 'groups'; target: Row; onDeleted: () => void | Promise<unknown> }) {
  const [plan, setPlan] = useState<Row | null>(null), [reason, setReason] = useState(''), [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const { message } = App.useApp(), label = ({ projects: '考试项目', subjects: '科目', groups: '题卡' })[kind]
  const [job, setJob] = useState<Row | null>(null), done = useRef(''), callback = useRef(onDeleted)
  callback.current = onDeleted
  const executing = !!plan && plan.status !== 'preview', jobId = plan?.job_id
  useEffect(() => {
    if (!jobId) return
    let active = true, loading = false
    async function poll() {
      if (loading) return
      loading = true
      try {
        const current = await request<Row>(`/jobs/${jobId}`)
        if (!active) return
        setJob(current); setError(current.error_detail || '')
        if (current.status === 'completed' && done.current !== jobId) {
          done.current = jobId; setPlan(null)
          announceChanges(['projects', 'subjects', 'groups', 'templates', 'scan-batches', 'submissions', 'assignments', 'tasks', 'review-progress', 'exceptions', 'results', 'analysis', 'jobs', 'archives', 'dashboard'])
          message.success('归档及扫描图片清理完成，业务记录已删除'); await callback.current()
        }
      } catch (e) { if (active) setError((e as Error).message) }
      finally { loading = false }
    }
    void poll(); const timer = setInterval(poll, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [jobId, message])
  async function preview() {
    setBusy(true); setError(''); setAccepted(false); setJob(null)
    try { setPlan(await send<Row>(`/${kind}/${target.id}/deletion-preview`)) }
    catch (e) { message.error((e as Error).message) }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (!plan || !accepted || !reason.trim()) return
    setBusy(true); setError('')
    try {
      setPlan(await send<Row>(`/deletion-plans/${plan.id}/confirm`, { confirm: true, reason: reason.trim() }))
    } catch (e) { setError((e as Error).message); setAccepted(false) }
    finally { setBusy(false) }
  }
  return <>
    <Dropdown menu={{ items: [{ key: 'delete', label: `删除${label}`, danger: true, onClick: preview }] }}><Button type="text" icon={<MoreOutlined />} loading={busy} aria-label={`${target.name}更多操作`} /></Dropdown>
    <Modal title={executing ? `删除任务 · ${plan.target.name}` : `删除${label} · ${target.name}`} width={720} styles={{body:{maxHeight:'70vh',overflowY:'auto'}}} open={!!plan} onCancel={() => !busy && setPlan(null)} confirmLoading={busy} onOk={confirm} okText="归档后清理并删除" okButtonProps={{ danger: true, disabled: !accepted || !reason.trim() || !!plan?.blockers?.length || !plan || plan.expires_at < Date.now() / 1000 }} cancelButtonProps={{ disabled: busy }} maskClosable={!busy} footer={executing ? <Button onClick={() => setPlan(null)}>关闭</Button> : undefined}>
      {plan && <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{plan.path.join(' / ')}</Typography.Text>
        {executing ? <>
          <Alert type={job?.status === 'failed' ? 'error' : 'info'} showIcon message={job?.status === 'failed' ? '删除任务中断，请核查后重试。业务记录保留，考试暂停写入。' : '正在生成归档、校验并清理扫描图片，完成后移除业务记录。'} description="关闭此窗口后任务仍会继续，可从考试的更多操作中重新查看。" />
          <Typography.Text>{job?.phase || '等待执行'}{job?.progress_total ? ` · ${job.progress_current || 0}/${job.progress_total}` : ''}</Typography.Text>
          <Progress percent={job?.progress_total ? Math.round(100 * (job.progress_current || 0) / job.progress_total) : 0} status={job?.status === 'failed' ? 'exception' : 'active'} />
          {error && <Alert type="warning" message={error} />}
          {job?.status === 'failed' && <Button loading={busy} onClick={async () => { setBusy(true); try { setJob(await send<Row>(`/jobs/${job.id}/retry`)); setError('') } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>重试原任务</Button>}
          {plan.archive_id && <Button onClick={async () => { try { await download(`/archives/${plan.archive_id}/download`, '考试归档.zip') } catch (e) { setError((e as Error).message) } }}>下载本次归档</Button>}
        </> : <>
        <Alert type="warning" showIcon message="以下业务记录将从日常功能中移除，已领取的相关阅卷任务也将失效。" />
        <Table rowKey="kind" size="middle" pagination={false} dataSource={plan.counts} columns={[{ title: '涉及记录', dataIndex: 'label' }, { title: '数量', dataIndex: 'count', width: 100 }]} />
        <Descriptions size="small" column={2} items={[
          { label: '永久退役题目编号', children: plan.question_count },
          { label: '保留评分流水', children: plan.retained_score_history },
          { label: '取消待执行后台任务', children: plan.cancel_pending_jobs },
          { label: '清除重阅队列', children: plan.runtime_regrades },
          { label: '失效文件释放清单', children: plan.invalidate_release_plans },
          { label: '保留项目归档', children: plan.retained_archives },
          { label: '清理扫描页', children: plan.scan_pages },
        ]} />
        <Typography.Paragraph type="secondary">确认后将暂停本考试写入，生成并校验最新项目归档，再清理以上范围内的本地及远端扫描图片。原始评分记录、审计、永久编号与共享底图保留，归档可从“归档文件”下载。清理中断可重试。</Typography.Paragraph>
        <Button onClick={async () => { try { await download(`/deletion-plans/${plan.id}/manifest`, '删除影响清单.json') } catch (e) { setError((e as Error).message) } }}>下载完整影响清单</Button>
        {plan.blockers.map((item: Row) => <Alert key={item.id} type="warning" message={item.reason} />)}
        {plan.expires_at < Date.now() / 1000 && <Alert type="warning" message="预览已过期，请重新预览。" />}
        {error && <Alert type="error" message={error} action={<Button onClick={preview} disabled={busy}>重新预览</Button>} />}
        <div style={{ width: '100%' }}><Typography.Paragraph>删除原因</Typography.Paragraph><Input.TextArea value={reason} onChange={event => setReason(event.target.value)} rows={2} maxLength={1000} /></div>
        <Checkbox checked={accepted} onChange={event => setAccepted(event.target.checked)}>已核对以上范围，确认删除“{target.name}”</Checkbox>
        <Typography.Text type="secondary">预览有效期10分钟；数据发生变化时需重新预览。</Typography.Text>
        </>}
      </Space>}
    </Modal>
  </>
}
