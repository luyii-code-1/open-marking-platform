import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Card, Select, Space, Steps, Tabs, Tag, Typography } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { RecordSelect } from './RecordSelect'
import { Conversions } from './Conversions'
import { useReviewWorkspace } from './ReviewWorkspace'
import { announceChanges, send, useResource, type Row } from './api'

type ScopeProps = { projectId: string; subjectId?: string; gradeId?: string; groupId?: string }

function resolveDirectRule(
  kind: string,
  target: string,
  grade: string,
  data: { project: Row; subjects: Row[]; groups: Row[] },
): { mode: 'inherit' | 'override' | 'none'; scheme: string } {
  if (!target) return { mode: 'inherit', scheme: '' }
  if (kind === 'projects') {
    const p = data.project
    const mode = p.conversion_mode || (p.conversion_id ? 'override' : 'inherit')
    return { mode: mode as 'inherit' | 'override' | 'none', scheme: p.conversion_id || '' }
  }
  if (kind === 'subjects') {
    const sub = data.subjects.find(s => s.id === target)
    if (!sub) return { mode: 'inherit', scheme: '' }
    if (grade) {
      const mapping = sub.grade_conversions || {}
      if (Object.prototype.hasOwnProperty.call(mapping, grade)) {
        const val = mapping[grade]
        return val ? { mode: 'override', scheme: val } : { mode: 'none', scheme: '' }
      }
      return { mode: 'inherit', scheme: '' }
    }
    const mode = sub.conversion_mode || (sub.conversion_id ? 'override' : 'inherit')
    return { mode: mode as 'inherit' | 'override' | 'none', scheme: sub.conversion_id || '' }
  }
  const grp = data.groups.find(g => g.id === target)
  if (!grp) return { mode: 'inherit', scheme: '' }
  const mode = grp.conversion_mode || (grp.conversion_id ? 'override' : 'inherit')
  return { mode: mode as 'inherit' | 'override' | 'none', scheme: grp.conversion_id || '' }
}

function sourceTag(group: Row) {
  if (group.frozen) {
    return group.conversion_id ? <Tag color="green">发布快照</Tag> : <Tag>发布时未配置</Tag>
  }
  const source = group.conversion_source || '考试项目'
  if (source === '题卡') return <Tag color="blue">题卡指定</Tag>
  if (source === '年级') return <Tag color="cyan">年级继承</Tag>
  if (source === '科目') return <Tag color="geekblue">科目继承</Tag>
  return <Tag>考试项目默认</Tag>
}

function AdminConversionWorkspace({ projectId, subjectId, gradeId, groupId }: ScopeProps) {
  const data = useResource<{ project: Row; subjects: Row[]; groups: Row[] }>(
    `/conversion-bindings?project_id=${projectId}`,
    { project: { id: projectId }, subjects: [], groups: [] },
  )
  const schemes = useResource<Row[]>('/score-conversions', [])
  const grades = useResource<Row[]>('/grades', [])

  const [kind, setKind] = useState(groupId ? 'groups' : subjectId ? 'subjects' : 'projects')
  const [target, setTarget] = useState(groupId || subjectId || projectId)
  const [grade, setGrade] = useState(gradeId || '')
  const [mode, setMode] = useState<'inherit' | 'override' | 'none'>('inherit')
  const [scheme, setScheme] = useState('')
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()

  useEffect(() => {
    const nextKind = groupId ? 'groups' : subjectId ? 'subjects' : 'projects'
    setKind(nextKind)
    setTarget(groupId || subjectId || projectId)
    setGrade(gradeId || '')
  }, [projectId, subjectId, gradeId, groupId])

  useEffect(() => {
    const direct = resolveDirectRule(kind, target, kind === 'subjects' ? grade : '', data.data)
    setMode(direct.mode)
    setScheme(direct.scheme)
  }, [kind, target, grade, data.data])

  const groupLabel = (g: Row) =>
    [data.data.subjects.find(s => s.id === g.subject_id)?.name, grades.data.find(item => item.id === g.grade_id)?.name, g.name]
      .filter(Boolean)
      .join(' · ')

  const records = useMemo(() => {
    if (kind === 'projects') return [data.data.project]
    if (kind === 'subjects') return data.data.subjects.filter(s => !subjectId || s.id === subjectId)
    return data.data.groups
      .filter(g => (!subjectId || g.subject_id === subjectId) && (!gradeId || g.grade_id === gradeId) && (!groupId || g.id === groupId))
      .map(g => ({ ...g, name: groupLabel(g) }))
  }, [kind, data.data, subjectId, gradeId, groupId, grades.data])

  const scopedGroups = useMemo(
    () =>
      data.data.groups
        .filter(g => (!subjectId || g.subject_id === subjectId) && (!gradeId || g.grade_id === gradeId) && (!groupId || g.id === groupId))
        .map(g => ({ ...g, displayName: groupLabel(g) })),
    [data.data, subjectId, gradeId, groupId, grades.data],
  )

  const selectedGroup = kind === 'groups' ? data.data.groups.find(g => g.id === target) : undefined
  const targetLocked = !!selectedGroup?.frozen

  const reloadAll = async () => {
    await Promise.all([data.reload(), schemes.reload(), grades.reload()])
  }

  async function save() {
    setBusy(true)
    try {
      await send(
        '/conversion-bindings',
        {
          kind,
          id: target,
          grade_id: kind === 'subjects' ? grade : undefined,
          mode,
          conversion_id: mode === 'override' ? scheme : null,
        },
        'PUT',
      )
      announceChanges(['groups', 'projects', 'subjects', 'score-conversions'])
      await data.reload()
      message.success('赋分标准已保存')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const activeStep = groupId || kind === 'groups' ? 3 : gradeId || (kind === 'subjects' && grade) ? 2 : subjectId || kind === 'subjects' ? 1 : 0
  const modeOptions =
    kind === 'projects'
      ? [
          { value: 'inherit', label: '未配置默认（不赋分）' },
          { value: 'override', label: '指定项目默认方案' },
          { value: 'none', label: '明确停用赋分' },
        ]
      : [
          { value: 'inherit', label: '继承上级' },
          { value: 'override', label: '指定方案' },
          { value: 'none', label: '停用赋分（不赋分）' },
        ]

  return (
    <Tabs
      items={[
        {
          key: 'bindings',
          label: '赋分标准与分配',
          children: (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <ErrorNotice error={data.error || schemes.error || grades.error} retry={reloadAll} />
              <Card size="small">
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <Steps
                    size="small"
                    current={activeStep}
                    items={[
                      { title: '考试项目默认' },
                      { title: '科目默认' },
                      { title: '科目内年级' },
                      { title: '题卡指定（最高优先级）' },
                    ]}
                  />
                  <Typography.Text type="secondary">
                    按「题卡 &gt; 科目内年级 &gt; 科目 &gt; 考试项目」顺序生效；引用其他考试或通用模板时将在当前项目生成副本。已发布成绩保持发布快照锁定，复核并重新发布后才应用新标准。
                  </Typography.Text>
                </Space>
              </Card>

              <Card
                title="配置赋分规则"
                extra={
                  <Button size="small" loading={data.loading || schemes.loading} onClick={() => void reloadAll()}>
                    刷新
                  </Button>
                }
              >
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space wrap align="center">
                    <Select
                      aria-label="分配层级"
                      value={kind}
                      disabled={busy || !!groupId}
                      onChange={v => {
                        setKind(v)
                        setTarget(v === 'projects' ? projectId : v === 'subjects' ? subjectId || '' : groupId || '')
                        setGrade(v === 'subjects' ? gradeId || '' : '')
                      }}
                      options={[
                        ...(!subjectId && !groupId ? [{ value: 'projects', label: '考试项目默认' }] : []),
                        ...(!groupId ? [{ value: 'subjects', label: '科目 / 年级' }] : []),
                        { value: 'groups', label: '题卡' },
                      ]}
                    />
                    <RecordSelect title="适用对象" records={records} value={target} disabled={busy || !!groupId || (kind === 'subjects' && !!subjectId)} onChange={setTarget} />
                    {kind === 'subjects' && (
                      <RecordSelect
                        title="年级（留空为科目默认）"
                        records={grades.data}
                        value={grade}
                        disabled={busy || !!gradeId}
                        onChange={setGrade}
                      />
                    )}
                    <Select aria-label="继承方式" value={mode} disabled={busy || targetLocked} onChange={setMode} options={modeOptions} />
                    {mode === 'override' && (
                      <RecordSelect
                        title="赋分方案"
                        records={schemes.data}
                        value={scheme}
                        disabled={busy || targetLocked}
                        onChange={setScheme}
                      />
                    )}
                    <Button
                      type="primary"
                      loading={busy}
                      disabled={!target || targetLocked || (mode === 'override' && !scheme)}
                      onClick={save}
                    >
                      保存标准
                    </Button>
                  </Space>
                  {targetLocked && (
                    <Alert
                      type="warning"
                      showIcon
                      message="当前题卡成绩已发布锁定"
                      description="已发布成绩沿用发布时的赋分快照；如需更换方案，请先在「成绩」中发起成绩复核。"
                    />
                  )}
                </Space>
              </Card>

              <Card title="当前题卡生效标准">
                <Table<Row>
                  rowKey="id"
                  loading={data.loading}
                  dataSource={scopedGroups}
                  locale={{ emptyText: '当前范围暂无题卡' }}
                  columns={[
                    { title: '题卡', dataIndex: 'displayName' },
                    {
                      title: '生效方案',
                      render: (_, g) => {
                        if (g.conversion_id) {
                          return schemes.data.find(s => s.id === g.conversion_id)?.name || g.conversion_id
                        }
                        return <Typography.Text type="secondary">未配置赋分（停用或未设置）</Typography.Text>
                      },
                    },
                    { title: '规则来源', render: (_, g) => sourceTag(g) },
                    {
                      title: '发布锁定',
                      render: (_, g) => (g.frozen ? <Tag color="green">已发布锁定</Tag> : <Tag>未发布 · 可调整</Tag>),
                    },
                  ]}
                />
              </Card>
            </Space>
          ),
        },
        { key: 'schemes', label: '方案与模板库', children: <Conversions projectId={projectId} /> },
      ]}
    />
  )
}

export function ConversionWorkspace(props: ScopeProps) {
  const { user } = useReviewWorkspace()
  return user.role === 'admin' ? <AdminConversionWorkspace {...props} /> : <Alert type="info" message="赋分标准由系统管理员维护" />
}
