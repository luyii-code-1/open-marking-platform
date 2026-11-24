import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Checkbox, Modal, Radio, Space, Spin, Tag, Typography } from 'antd'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { send, type Row } from './api'

type RefItem = {
  kind: string
  kind_label: string
  id: string
  name: string
  reason?: string
  action?: string
}

type DeletePlan = {
  kind: string
  kind_label: string
  targets: RefItem[]
  cascade_deletes: RefItem[]
  cascade_unlinks: RefItem[]
  blockers: RefItem[]
  can_delete: boolean
  requires_cascade: boolean
}

function ReferenceList({ items, tone }: { items: RefItem[]; tone: 'blocker' | 'delete' | 'unlink' }) {
  const shown = items.slice(0, 100)
  return (
    <div className={`delete-ref-list is-${tone}`}>
      {shown.map((item, idx) => (
        <div key={`${item.kind}:${item.id}:${idx}`} className="delete-ref-item">
          <div className="delete-ref-head">
            <Tag color={tone === 'blocker' ? 'error' : tone === 'delete' ? 'warning' : 'blue'} style={{ marginInlineEnd: 0 }}>
              {item.kind_label}
            </Tag>
            <span className="delete-ref-name">{item.name}</span>
          </div>
          {(item.reason || item.action) && (
            <Typography.Text type={tone === 'blocker' ? 'danger' : 'secondary'} className="delete-ref-note">
              {item.reason || item.action}
            </Typography.Text>
          )}
        </div>
      ))}
      {items.length > shown.length && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          仅展示前 {shown.length} 项，共 {items.length} 项。
        </Typography.Text>
      )}
    </div>
  )
}

export function DeleteRecordsModal({
  kind,
  ids,
  open,
  onClose,
  onDeleted,
}: {
  kind: string
  ids: string[]
  open: boolean
  onClose: () => void
  onDeleted: () => Promise<unknown>
}) {
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [plan, setPlan] = useState<DeletePlan | null>(null)
  const [mode, setMode] = useState<'unlink' | 'cascade'>('unlink')
  const [confirmed, setConfirmed] = useState(false)
  const [forceDelete, setForceDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()

  const loadPreview = useCallback(async (targetMode: 'unlink' | 'cascade' = mode) => {
    if (!open || !ids.length) return
    setLoading(true)
    setLoadError('')
    setConfirmed(false)
    setForceDelete(false)
    try {
      const value = await send<DeletePlan>(`/records/${kind}/delete-preview`, { ids, mode: targetMode })
      setPlan(value)
    } catch (e) {
      setPlan(null)
      setLoadError(e instanceof Error ? e.message : '加载引用关系失败')
    } finally {
      setLoading(false)
    }
  }, [open, kind, ids.join(','), mode])

  useEffect(() => {
    if (open) void loadPreview(mode)
    else {
      setPlan(null)
      setLoadError('')
      setConfirmed(false)
      setForceDelete(false)
      setMode('unlink')
    }
  }, [open, mode, loadPreview])

  async function execute() {
    if (!plan || busy) return
    const isForce = plan.blockers.length > 0
    if (isForce && !forceDelete) return
    if (!isForce && !plan.can_delete) return
    if (!isForce && plan.requires_cascade && !confirmed) return
    setBusy(true)
    try {
      const result = await send<{ deleted: number; cascaded_deletes: number; cascaded_unlinks: number; forced?: boolean }>(`/records/${kind}/delete`, {
        ids,
        cascade: plan.requires_cascade || isForce,
        mode,
        force: isForce && forceDelete,
      })
      const extras = [
        result.forced ? '强制删除' : '',
        result.cascaded_deletes ? `连带删除 ${result.cascaded_deletes} 项基础资料` : '',
        result.cascaded_unlinks ? `解除 ${result.cascaded_unlinks} 项关联绑定` : '',
      ]
        .filter(Boolean)
        .join('，')
      message.success(`已删除 ${result.deleted} 条${plan.kind_label}${extras ? `（${extras}）` : ''}`)
      onClose()
      await onDeleted()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败')
      await loadPreview(mode)
    } finally {
      setBusy(false)
    }
  }

  const title = plan
    ? ids.length > 1
      ? `核对批量删除 ${plan.kind_label}（${ids.length} 项）`
      : `核对删除${plan.kind_label}`
    : '核对引用与删除'

  const hasBlockers = !!plan && plan.blockers.length > 0
  const okDisabled = loading || !plan || (hasBlockers ? !forceDelete : !plan.can_delete || (plan.requires_cascade && !confirmed))

  return (
    <Modal
      title={title}
      open={open}
      width={660}
      onCancel={() => !busy && onClose()}
      onOk={() => void execute()}
      okText={hasBlockers ? '确认强制删除' : plan?.requires_cascade ? (mode === 'unlink' ? '确认解绑并删除' : '确认链式删除') : '确认删除'}
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ danger: true, disabled: okDisabled }}
      cancelButtonProps={{ disabled: busy }}
      maskClosable={!busy}
      closable={!busy}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <ErrorNotice error={loadError} retry={() => loadPreview(mode)} />
        <div>
          <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
            处理方式
          </Typography.Text>
          <Radio.Group
            value={mode}
            disabled={loading || busy}
            onChange={e => setMode(e.target.value)}
            options={[
              { value: 'unlink', label: '解绑并删除目标（仅移除关联，保留附属子内容）' },
              { value: 'cascade', label: '链式删除（连同附属子内容一并删除）' },
            ]}
          />
        </div>
        {loading && (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <Spin tip="正在检查关联引用…" />
          </div>
        )}
        {!loading && plan && (
          <>
            <div className="delete-target-box">
              <Typography.Text strong>
                待删除{plan.kind_label}（{plan.targets.length} 项）
              </Typography.Text>
              <Space wrap size={[6, 6]} style={{ marginTop: 6 }}>
                {plan.targets.slice(0, 12).map(t => (
                  <Tag key={t.id} style={{ marginInlineEnd: 0 }}>
                    {t.name}
                  </Tag>
                ))}
                {plan.targets.length > 12 && <Tag>其余 {plan.targets.length - 12} 项</Tag>}
              </Space>
            </div>

            {plan.blockers.length > 0 ? (
              <>
                <Alert
                  type="error"
                  showIcon
                  message={`存在 ${plan.blockers.length} 项受保护的考试业务引用，默认不可删除`}
                  description="考试题卡、答卷、评分记录及已发布成绩受保护；如确需清理测试账号或强制移除，请勾选下方强制删除确认。"
                />
                <ReferenceList items={plan.blockers} tone="blocker" />
                <Checkbox checked={forceDelete} onChange={e => setForceDelete(e.target.checked)}>
                  <Typography.Text type="danger" strong>
                    强制删除：我已核对受保护引用，确认强制删除所选记录并清理其关联任务与绑定
                  </Typography.Text>
                </Checkbox>
              </>
            ) : plan.requires_cascade ? (
              <>
                <Alert
                  type="warning"
                  showIcon
                  message={mode === 'unlink' ? '检测到关联引用，确认后将仅解除绑定并删除目标记录' : '检测到关联引用，确认后将执行链式删除'}
                  description={
                    mode === 'unlink'
                      ? '所选目标将被删除，以下关联对象中的绑定/标签将被自动移除，附属子内容保留，审计记录保留。'
                      : '以下基础资料将被连带删除，关联绑定将被自动解除，审计记录保留。'
                  }
                />
                {plan.cascade_deletes.length > 0 && (
                  <div>
                    <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
                      将连带删除的基础资料（{plan.cascade_deletes.length} 项）
                    </Typography.Text>
                    <ReferenceList items={plan.cascade_deletes} tone="delete" />
                  </div>
                )}
                {plan.cascade_unlinks.length > 0 && (
                  <div>
                    <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
                      将自动解除的关联绑定（{plan.cascade_unlinks.length} 项）
                    </Typography.Text>
                    <ReferenceList items={plan.cascade_unlinks} tone="unlink" />
                  </div>
                )}
                <Checkbox checked={confirmed} onChange={e => setConfirmed(e.target.checked)}>
                  {mode === 'unlink' ? '我已核对以上影响范围，确认解绑并删除' : '我已核对以上关联明细，确认执行链式删除'}
                </Checkbox>
              </>
            ) : (
              <Alert type="info" showIcon message="未发现关联引用，确认后将直接删除所选记录（审计记录保留）。" />
            )}
          </>
        )}
      </Space>
    </Modal>
  )
}

export function DeleteRecord({ kind, row, reload }: { kind: string; row: Row; reload: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button danger type="link" onClick={() => setOpen(true)}>
        删除
      </Button>
      <DeleteRecordsModal kind={kind} ids={[row.id]} open={open} onClose={() => setOpen(false)} onDeleted={reload} />
    </>
  )
}

export function BatchDeleteButton({
  kind,
  ids,
  onDeleted,
  label = '批量删除',
}: {
  kind: string
  ids: string[]
  onDeleted: () => Promise<unknown>
  label?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button danger size="small" disabled={!ids.length} onClick={() => setOpen(true)}>
        {label}（{ids.length}）
      </Button>
      <DeleteRecordsModal kind={kind} ids={ids} open={open} onClose={() => setOpen(false)} onDeleted={onDeleted} />
    </>
  )
}
