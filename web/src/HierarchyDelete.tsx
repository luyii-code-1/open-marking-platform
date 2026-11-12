import { useState } from 'react'
import { Alert, App, Button, Checkbox, Descriptions, Dropdown, Input, Modal, Space, Table, Typography } from 'antd'
import { MoreOutlined } from '@ant-design/icons'
import { announceChanges, download, send, type Row } from './api'

export function HierarchyDelete({ kind, target, onDeleted }: { kind: 'projects' | 'subjects' | 'groups'; target: Row; onDeleted: () => void | Promise<unknown> }) {
  const [plan, setPlan] = useState<Row | null>(null), [reason, setReason] = useState(''), [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const { message } = App.useApp(), label = ({ projects: '考试项目', subjects: '科目', groups: '题卡组' })[kind]
  async function preview() {
    setBusy(true); setError(''); setAccepted(false)
    try { setPlan(await send<Row>(`/${kind}/${target.id}/deletion-preview`)) }
    catch (e) { message.error((e as Error).message) }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (!plan || !accepted || !reason.trim()) return
    setBusy(true); setError('')
    try {
      await send(`/deletion-plans/${plan.id}/confirm`, { confirm: true, reason: reason.trim() })
      setPlan(null)
      announceChanges(['projects', 'subjects', 'groups', 'templates', 'scan-batches', 'submissions', 'assignments', 'tasks', 'review-progress', 'exceptions', 'results', 'analysis', 'jobs', 'archives', 'dashboard'])
      message.success(`${label}已删除`); await onDeleted()
    } catch (e) { setError((e as Error).message); setAccepted(false) }
    finally { setBusy(false) }
  }
  return <>
    <Dropdown menu={{ items: [{ key: 'delete', label: `删除${label}`, danger: true, onClick: preview }] }}><Button type="text" icon={<MoreOutlined />} loading={busy} aria-label={`${target.name}更多操作`} /></Dropdown>
    <Modal title={`删除${label} · ${target.name}`} width={720} styles={{body:{maxHeight:'70vh',overflowY:'auto'}}} open={!!plan} onCancel={() => !busy && setPlan(null)} confirmLoading={busy} onOk={confirm} okText="确认删除以上范围" okButtonProps={{ danger: true, disabled: !accepted || !reason.trim() || !!plan?.blockers?.length || !plan || plan.expires_at < Date.now() / 1000 }} cancelButtonProps={{ disabled: busy }} maskClosable={!busy}>
      {plan && <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{plan.path.join(' / ')}</Typography.Text>
        <Alert type="warning" showIcon message="以下业务记录将从日常功能中移除，已领取的相关阅卷任务也将失效。" />
        <Table rowKey="kind" size="middle" pagination={false} dataSource={plan.counts} columns={[{ title: '涉及记录', dataIndex: 'label' }, { title: '数量', dataIndex: 'count', width: 100 }]} />
        <Descriptions size="small" column={2} items={[
          { label: '永久退役题目编号', children: plan.question_count },
          { label: '保留评分流水', children: plan.retained_score_history },
          { label: '取消待执行后台任务', children: plan.cancel_pending_jobs },
          { label: '清除重阅队列', children: plan.runtime_regrades },
          { label: '失效文件释放清单', children: plan.invalidate_release_plans },
          { label: '保留项目归档', children: plan.retained_archives },
        ]} />
        <Typography.Paragraph type="secondary">扫描文件、原始评分记录、审计与永久编号保留，本次操作不释放文件空间。需要归档或释放空间时，请先在考试项目中完成相应操作；已有归档仍可从“归档文件”下载。</Typography.Paragraph>
        <Button onClick={async () => { try { await download(`/deletion-plans/${plan.id}/manifest`, '删除影响清单.json') } catch (e) { setError((e as Error).message) } }}>下载完整影响清单</Button>
        {plan.blockers.map((item: Row) => <Alert key={item.id} type="warning" message={item.reason} />)}
        {plan.expires_at < Date.now() / 1000 && <Alert type="warning" message="预览已过期，请重新预览。" />}
        {error && <Alert type="error" message={error} action={<Button onClick={preview} disabled={busy}>重新预览</Button>} />}
        <div style={{ width: '100%' }}><Typography.Paragraph>删除原因</Typography.Paragraph><Input.TextArea value={reason} onChange={event => setReason(event.target.value)} rows={2} maxLength={1000} /></div>
        <Checkbox checked={accepted} onChange={event => setAccepted(event.target.checked)}>已核对以上范围，确认删除“{target.name}”</Checkbox>
        <Typography.Text type="secondary">预览有效期10分钟；数据发生变化时需重新预览。</Typography.Text>
      </Space>}
    </Modal>
  </>
}
