import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Card, Form, Segmented, Space, Tag, Typography } from 'antd'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { RecordSelect } from './RecordSelect'
import { useReviewWorkspace } from './ReviewWorkspace'
import { announceChanges, send, useResource, type Row } from './api'
import { examPath } from './examNavigation'

type CardConversionProps = {
  projectId: string
  groupId: string
}

function useSchemeChoices(projectId?: string) {
  const schemes = useResource<Row[]>('/score-conversions', [])
  const projects = useResource<Row[]>('/projects', [])
  const projectNames = useMemo(() => new Map(projects.data.map(p => [p.id, p.name])), [projects.data])
  const records = useMemo<Row[]>(
    () =>
      [...schemes.data]
        .sort((a, b) => Number(b.project_id === projectId) - Number(a.project_id === projectId))
        .map(s => ({
          ...s,
          source_name: s.project_id ? projectNames.get(s.project_id) || '其他考试' : '通用模板',
        })),
    [schemes.data, projectId, projectNames],
  )
  return { schemes, projects, records }
}

export function CardConversionFields({ projectId }: { projectId?: string }) {
  const form = Form.useFormInstance()
  const enabled = Boolean(Form.useWatch('conversion_enabled', form))
  const { records } = useSchemeChoices(projectId)

  return (
    <>
      <Form.Item name="conversion_enabled" label="是否赋分" initialValue={false}>
        <Segmented<boolean>
          options={[
            { value: false, label: '不赋分' },
            { value: true, label: '启用赋分' },
          ]}
          onChange={next => {
            if (!next) form?.setFieldValue('conversion_id', undefined)
          }}
        />
      </Form.Item>
      {enabled && (
        <Form.Item name="conversion_id" label="赋分方案" rules={[{ required: true, message: '请选择赋分方案' }]}>
          <RecordSelect
            title="赋分方案"
            records={records}
            label={row => `${row.name}（${row.source_name || '通用模板'}）`}
            columns={[
              { title: '方案名称', dataIndex: 'name' },
              { title: '来源', dataIndex: 'source_name' },
            ]}
          />
        </Form.Item>
      )}
    </>
  )
}

function AdminCardConversion({ projectId, groupId }: CardConversionProps) {
  const data = useResource<{ project: Row; subjects: Row[]; groups: Row[] }>(
    `/conversion-bindings?project_id=${projectId}`,
    { project: { id: projectId }, subjects: [], groups: [] },
  )
  const { schemes, projects, records } = useSchemeChoices(projectId)
  const group = data.data.groups.find(g => g.id === groupId)
  const locked = !!group?.frozen

  const [enabled, setEnabled] = useState(false)
  const [schemeId, setSchemeId] = useState('')
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()

  useEffect(() => {
    if (!group) return
    const hasScheme = Boolean(group.conversion_id && group.conversion_mode !== 'none')
    setEnabled(hasScheme)
    setSchemeId(hasScheme ? group.conversion_id : '')
  }, [group?.id, group?.conversion_id, group?.conversion_mode])

  const reloadAll = async () => {
    await Promise.all([data.reload(), schemes.reload(), projects.reload()])
  }

  async function save() {
    if (locked || busy) return
    setBusy(true)
    try {
      await send(
        '/conversion-bindings',
        {
          kind: 'groups',
          id: groupId,
          mode: enabled ? 'override' : 'none',
          conversion_id: enabled ? schemeId : null,
        },
        'PUT',
      )
      announceChanges(['groups', 'score-conversions'])
      await reloadAll()
      message.success(enabled ? '题卡赋分设置已保存' : '已设为不赋分')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const currentScheme = group?.conversion_id ? records.find(s => s.id === group.conversion_id) : undefined

  return (
    <Card size="small">
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <ErrorNotice error={data.error || schemes.error || projects.error} retry={reloadAll} />

        <div className="conversion-priority-bar">
          <Space wrap size={8}>
            <span className="conversion-priority-label">当前状态</span>
            {group?.conversion_id ? (
              <Tag color="blue">已启用 · {currentScheme?.name || group.conversion_id}</Tag>
            ) : (
              <Tag>不赋分</Tag>
            )}
            {locked ? <Tag color="green">已发布锁定</Tag> : <Tag>未发布 · 可修改</Tag>}
          </Space>
          <Space size={8}>
            <a href={examPath({ projectId, section: 'conversions' })}>管理项目赋分方案</a>
            <Button size="small" loading={data.loading || schemes.loading} onClick={() => void reloadAll()}>
              刷新
            </Button>
          </Space>
        </div>

        {locked && (
          <Alert
            type="warning"
            showIcon
            message="当前题卡成绩已发布锁定"
            description="已发布成绩沿用发布时的赋分快照；如需修改赋分设置，请先在「成绩」中发起成绩复核。"
          />
        )}

        <div className="conversion-rule-grid">
          <div className="conversion-rule-field">
            <span className="conversion-rule-label">是否赋分</span>
            <Segmented<boolean>
              aria-label="是否赋分"
              value={enabled}
              disabled={busy || locked}
              onChange={next => {
                setEnabled(next)
                if (!next) setSchemeId('')
              }}
              options={[
                { value: false, label: '不赋分' },
                { value: true, label: '启用赋分' },
              ]}
            />
          </div>

          {enabled && (
            <div className="conversion-rule-field">
              <span className="conversion-rule-label">赋分方案</span>
              <RecordSelect
                title="赋分方案"
                records={records}
                value={schemeId}
                disabled={busy || locked}
                label={row => `${row.name}（${row.source_name || '通用模板'}）`}
                columns={[
                  { title: '方案名称', dataIndex: 'name' },
                  { title: '来源', dataIndex: 'source_name' },
                ]}
                onChange={setSchemeId}
              />
            </div>
          )}

          <div className="conversion-rule-submit">
            <Button type="primary" loading={busy} disabled={locked || (enabled && !schemeId)} onClick={save}>
              保存设置
            </Button>
          </div>
        </div>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          仅作用于当前题卡；引用其他考试或通用模板时将自动在当前考试项目生成副本。
        </Typography.Text>
      </Space>
    </Card>
  )
}

export function ConversionWorkspace(props: CardConversionProps) {
  const { user } = useReviewWorkspace()
  return user.role === 'admin' ? (
    <AdminCardConversion {...props} />
  ) : (
    <Alert type="info" showIcon message="题卡赋分设置由系统管理员维护" />
  )
}
