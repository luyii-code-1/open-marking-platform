import { useEffect, useState } from 'react'
import { Alert, App, Card, Checkbox, Descriptions, Empty, Modal, Popconfirm, Select, Space, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { useFileJobs } from './FileJobs'
import { downloadArchive, request, send, useResource, type Row } from './api'
import { readExamContext, rememberExamContext } from './examNavigation'
import { useAction } from './useAction'

const bytes = (value: number) => (value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(2)} MB`)

const jobTitles: Record<string, string> = {
  'archive-project': '生成归档',
  'preview-release': '核对文件清单',
  'release-project': '清理扫描文件',
  'restore-archive': '恢复扫描文件',
}

const jobStatusMeta: Record<string, { text: string; color: string }> = {
  pending: { text: '等待中', color: 'default' },
  running: { text: '进行中', color: 'processing' },
  failed: { text: '失败', color: 'error' },
  completed: { text: '已完成', color: 'success' },
}

export function ArchiveManager({ projectId }: { projectId?: string }) {
  const projects = useResource<Row[]>('/projects', [])
  const archives = useResource<Row[]>('/archives', [])
  const [selectedProject, setSelectedProject] = useState(() => projectId || readExamContext().projectId || '')
  const project = projectId || selectedProject
  const [mode, setMode] = useState('all')
  const [plan, setPlan] = useState<Row | null>(null)
  const [outcome, setOutcome] = useState<any>(null)
  const { message } = App.useApp()

  function setProject(next: string) {
    setSelectedProject(next)
    if (next) rememberExamContext({ projectId: next })
  }

  const usage = useResource<any>(project ? `/projects/${project}/files` : null, null)
  const [deleting, setDeleting] = useState<any>(null)
  const jobs = useFileJobs(project)
  const action = useAction()
  const busy = action.busy
  const [acknowledged, setAcknowledged] = useState(false)
  const purged = !!projects.data.find(p => p.id === project)?.scans_purged

  useEffect(() => {
    setPlan(null)
    setOutcome(null)
    setAcknowledged(false)
  }, [project])

  const deletedProjects = [
    ...new Map(
      archives.data.filter(a => a.project_deleted).map(a => [a.project_id, { id: a.project_id, name: `${a.project_name || a.project_id}（已删除）` }]),
    ).values(),
  ]
  const projectOptions = [...projects.data, ...deletedProjects.filter(p => !projects.data.some(active => active.id === p.id))]
  const projectDeleted = archives.data.some(a => a.project_id === project && a.project_deleted)

  useEffect(() => {
    const job = jobs.finished
    if (!job || job.cancelled_by_deletion) return
    void archives.reload()
    void projects.reload()
    void usage.reload()
    if (job.status === 'failed') {
      message.error(job.error_detail || '任务失败，可核查后重试')
      return
    }
    if (job.kind === 'preview-release') {
      setPlan(job.result)
      setOutcome(null)
      setAcknowledged(false)
    } else if (job.kind === 'release-project') {
      void request<Row>(`/release-plans/${job.payload.plan_id}`)
        .then(value => {
          setPlan(value)
          setOutcome(job.result)
        })
        .catch(e => message.error(e.message))
    } else {
      message.success(job.kind === 'archive-project' ? '归档已生成并校验，可下载' : `已恢复 ${job.result?.restored_files || 0} 个文件`)
    }
  }, [jobs.finished])

  const scoped = archives.data.filter(a => !project || a.project_id === project).sort((a, b) => b.created_at - a.created_at)
  const projectName = (id: string) =>
    projectOptions.find(p => p.id === id)?.name || archives.data.find(a => a.project_id === id)?.project_name || id

  async function enqueue(key: string, path: string, body?: unknown) {
    await action.run(key, async () => {
      try {
        await jobs.submit(path, body)
        message.success('后台任务已提交，进度会自动更新')
      } catch (e) {
        message.error((e as Error).message)
      }
    })
  }

  async function create() {
    await enqueue('archive', `/projects/${project}/archive-jobs`)
  }

  async function preview(id: string, targetProject = project) {
    if (!targetProject) return
    setOutcome(null)
    await enqueue(`preview:${id}`, `/projects/${targetProject}/release-preview-jobs`, { archive_id: id, mode })
  }

  async function previewPurge() {
    setOutcome(null)
    await enqueue('purge-preview', `/projects/${project}/release-preview-jobs`, { action: 'purge', mode: 'all' })
  }

  async function release() {
    if (!plan || busy) return
    const id = plan.id
    setPlan(null)
    await enqueue('release', `/projects/${project}/release-jobs`, { plan_id: id, confirm: true })
  }

  async function restore(id: string) {
    await enqueue(`restore:${id}`, `/archives/${id}/restore-jobs`)
  }

  async function download(id: string) {
    await action.run(`download:${id}`, async () => {
      try {
        await downloadArchive(id, '考试归档.zip')
      } catch (e) {
        message.error((e as Error).message)
      }
    })
  }

  const refreshAll = () => {
    void projects.reload()
    void archives.reload()
    if (project) void usage.reload()
  }

  const tableRows = [
    ...jobs.rows
      .filter(j => ['pending', 'running', 'failed'].includes(j.status) || (['preview-release', 'release-project'].includes(j.kind) && j.status === 'completed'))
      .slice(0, 20)
      .map(j => ({ ...j, __job: true })),
    ...scoped,
  ]

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <ErrorNotice error={projects.error || archives.error || jobs.error} retry={refreshAll} />

          <Space wrap align="center">
            {!projectId && (
              <Select
                aria-label="选择考试项目"
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 280, maxWidth: '100%' }}
                placeholder="选择考试项目"
                disabled={busy}
                value={projectOptions.some(p => p.id === project) ? project : undefined}
                onChange={v => setProject(v || '')}
                options={projectOptions.map(p => ({ label: p.name, value: p.id }))}
              />
            )}
            {!projectDeleted && (
              <>
                <Button type="primary" loading={action.pending === 'archive'} disabled={busy || !project || jobs.active || purged} onClick={create}>
                  生成项目归档
                </Button>
                <Select
                  aria-label="释放范围"
                  style={{ width: 240, maxWidth: '100%' }}
                  disabled={busy || purged}
                  value={mode}
                  onChange={setMode}
                  options={[
                    { label: '释放本地及远端扫描文件', value: 'all' },
                    { label: '仅释放本地活动扫描文件', value: 'local' },
                  ]}
                />
                <Button
                  danger
                  disabled={busy || !project || jobs.active || purged}
                  loading={action.pending === 'purge-preview'}
                  onClick={previewPurge}
                >
                  直接清理扫描文件
                </Button>
              </>
            )}
            <Button disabled={busy} loading={archives.loading || projects.loading} onClick={refreshAll}>
              刷新
            </Button>
          </Space>

          {!project && (
            <Alert type="info" showIcon message="请选择上方考试项目以核算空间、生成归档、预览释放或清理扫描文件；下方展示已有归档记录。" />
          )}
          {purged && <Alert type="info" showIcon message="本考试扫描文件已清理，成绩查询、统计与导出保留。已有归档仍可下载。" />}
          {projectDeleted && <Alert type="info" showIcon message="原考试项目已删除，已有归档保留，可在此下载。" />}
          {!projectDeleted && (
            <Typography.Text type="secondary">
              归档、清单核对、释放和恢复均在后台执行。归档后释放可在需要查看原卷时回取文件；直接清理仅保留成绩查询与导出。
            </Typography.Text>
          )}
        </Space>
      </Card>

      {project && (
        <Card
          size="small"
          title={`空间占用摘要 · ${projectName(project)}`}
          extra={
            <Button size="small" loading={usage.loading} onClick={() => void usage.reload()}>
              重新核算
            </Button>
          }
        >
          <ErrorNotice error={usage.error} retry={usage.reload} />
          {usage.data ? (
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 3 }}
              items={[
                { label: '本地占用', children: <span className="numeric-cell">{bytes(usage.data.local_bytes)}</span> },
                {
                  label: '远端登记占用',
                  children: (
                    <Space size={6} wrap>
                      <span className="numeric-cell">{bytes(usage.data.remote_bytes)}</span>
                      {usage.data.unknown_remote_files > 0 && (
                        <Tag color="warning">另有 {usage.data.unknown_remote_files} 个历史文件大小待核对</Tag>
                      )}
                    </Space>
                  ),
                },
                { label: '核算时间', children: new Date(usage.data.checked_at * 1000).toLocaleString() },
              ]}
            />
          ) : (
            !usage.error && <Typography.Text type="secondary">正在核算当前项目文件占用…</Typography.Text>
          )}
        </Card>
      )}

      <Card title="归档包与后台任务">
        <Table<Row>
          rowKey="id"
          loading={archives.loading}
          dataSource={tableRows}
          locale={{ emptyText: <Empty description={project ? '当前考试项目暂无归档或后台任务' : '暂无归档记录'} /> }}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: '记录 / 任务状态',
              render: (_, row) => {
                if (row.__job) {
                  const meta = jobStatusMeta[row.status] || { text: row.status, color: 'default' }
                  return (
                    <Space size={6} wrap>
                      <Tag color={meta.color}>{meta.text}</Tag>
                      <span>{jobTitles[row.kind] || row.kind}</span>
                      {row.phase && <Typography.Text type="secondary">{row.phase}</Typography.Text>}
                    </Space>
                  )
                }
                return (
                  <Space size={6}>
                    <Tag>归档包</Tag>
                    {row.project_deleted && <Tag color="default">所属项目已删除</Tag>}
                  </Space>
                )
              },
            },
            ...(!projectId
              ? [
                  {
                    title: '考试项目',
                    dataIndex: 'project_id',
                    render: (id: string) => (
                      <Button type="link" onClick={() => setProject(id)}>
                        {projectName(id)}
                      </Button>
                    ),
                  },
                ]
              : []),
            {
              title: '创建时间',
              dataIndex: 'created_at',
              render: value => (value ? new Date(value * 1000).toLocaleString() : '—'),
            },
            {
              title: '归档大小',
              dataIndex: 'size',
              align: 'right',
              render: value => (value === undefined ? '—' : <span className="numeric-cell">{bytes(value)}</span>),
            },
            {
              title: '扫描及题卡文件',
              dataIndex: 'asset_count',
              align: 'right',
              render: (value, row) => {
                if (value !== undefined) return <span className="numeric-cell">{value}</span>
                if (row.__job && row.progress_total) {
                  return <span className="numeric-cell">{`${row.progress_current || 0}/${row.progress_total}`}</span>
                }
                return '—'
              },
            },
            {
              title: 'SHA-256',
              dataIndex: 'sha256',
              ellipsis: true,
              render: value => (value ? <Typography.Text code>{String(value).slice(0, 16)}…</Typography.Text> : '—'),
            },
            {
              title: '操作',
              render: (_, row) => {
                if (row.__job) {
                  return (
                    <Space wrap>
                      {row.status === 'failed' && (
                        <Button disabled={jobs.active} onClick={() => jobs.retry(row.id).catch(e => message.error(e.message))}>
                          重试任务
                        </Button>
                      )}
                      {row.status === 'completed' && <Button onClick={() => jobs.inspect(row)}>查看结果</Button>}
                      {row.error_detail && <Typography.Text type="danger">{row.error_detail}</Typography.Text>}
                    </Space>
                  )
                }
                const rowDeleted = !!row.project_deleted
                const rowPurged = !!projects.data.find(p => p.id === row.project_id)?.scans_purged
                return (
                  <Space wrap>
                    <Button disabled={busy} loading={action.pending === `download:${row.id}`} onClick={() => download(row.id)}>
                      下载归档
                    </Button>
                    {!rowDeleted && (
                      <>
                        <Button
                          disabled={busy || jobs.active || rowDeleted || rowPurged}
                          loading={action.pending === `preview:${row.id}`}
                          onClick={() => {
                            if (!project) setProject(row.project_id)
                            void preview(row.id, row.project_id)
                          }}
                        >
                          预览释放
                        </Button>
                        <Popconfirm
                          title="从此归档恢复扫描文件？"
                          description="逐项校验；现有文件与归档不一致时不会覆盖，当前评分记录保留。"
                          onConfirm={() => {
                            if (!project) setProject(row.project_id)
                            void restore(row.id)
                          }}
                        >
                          <Button disabled={busy || jobs.active || rowDeleted || rowPurged} loading={action.pending === `restore:${row.id}`}>
                            恢复扫描文件
                          </Button>
                        </Popconfirm>
                      </>
                    )}
                    <Button
                      danger
                      disabled={busy || jobs.active}
                      onClick={async () => {
                        try {
                          setDeleting(await send(`/archives/${row.id}/delete-preview`))
                        } catch (e) {
                          message.error((e as Error).message)
                        }
                      }}
                    >
                      删除归档包
                    </Button>
                  </Space>
                )
              },
            },
          ]}
        />
      </Card>

      <Modal
        title="核对归档包删除"
        open={!!deleting}
        onCancel={() => !busy && setDeleting(null)}
        confirmLoading={action.pending === 'delete-archive'}
        okText="确认删除归档包"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: !deleting }}
        cancelButtonProps={{ disabled: busy }}
        maskClosable={!busy}
        onOk={async () => {
          if (!deleting) return
          await action.run('delete-archive', async () => {
            try {
              await send(`/archives/${deleting.id}/package`, { confirm: true, sha256: deleting.sha256 }, 'DELETE')
              setDeleting(null)
              await Promise.all([archives.reload(), usage.reload()])
              message.success('归档包已删除')
            } catch (e) {
              message.error((e as Error).message)
            }
          })
        }}
      >
        {deleting && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message="删除后将移除该归档 ZIP 包"
              description="评分和成绩保留；若当前考试仍依赖此归档进行原卷回取，需先恢复或清理原卷。"
            />
            <Descriptions
              size="small"
              column={1}
              bordered
              items={[
                { label: '所属考试', children: projectName(deleting.project_id) },
                { label: '释放大小', children: <span className="numeric-cell">{bytes(deleting.size || 0)}</span> },
                { label: 'SHA-256 摘要', children: deleting.sha256 ? <Typography.Text code>{deleting.sha256}</Typography.Text> : '—' },
              ]}
            />
          </Space>
        )}
      </Modal>

      <Modal
        width={900}
        title={`核对扫描文件清单并确认 · ${project ? projectName(project) : ''}`}
        open={!!plan}
        onCancel={() => !busy && setPlan(null)}
        maskClosable={!busy}
        closable={!busy}
        confirmLoading={action.pending === 'release'}
        onOk={outcome?.status === 'completed' ? () => setPlan(null) : release}
        okText={
          outcome?.status === 'completed'
            ? '完成'
            : outcome?.status === 'partial'
              ? '重试未完成文件'
              : plan?.action === 'purge'
                ? '确认直接清理扫描文件'
                : '确认释放清单中的扫描文件'
        }
        cancelText="取消"
        okButtonProps={{
          danger: outcome?.status !== 'completed',
          disabled:
            outcome?.status !== 'completed' &&
            (!plan?.can_confirm ||
              jobs.active ||
              (plan?.action === 'purge' && !acknowledged) ||
              (plan?.status === 'preview' && plan.expires_at < Date.now() / 1000)),
        }}
        cancelButtonProps={{ disabled: busy }}
      >
        {plan && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2 }}
              bordered
              items={[
                { label: '清理范围', children: plan.mode === 'all' ? '本地及远端' : '仅本地' },
                { label: '扫描文件总数', children: <span className="numeric-cell">{plan.file_count}</span> },
                { label: '本地活动文件大小', children: <span className="numeric-cell">{bytes(plan.local_bytes)}</span> },
                { label: '远端文件数', children: <span className="numeric-cell">{plan.remote_files}</span> },
              ]}
            />
            {plan.file_count > 100 && (
              <Alert
                type="info"
                showIcon
                message={`以下清单仅展示前 100 项（共 ${plan.file_count} 项），清单生成后 10 分钟内可确认；成绩、评分记录、统计、题卡资产和审计保留。`}
              />
            )}
            {plan.file_count <= 100 && (
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                清单共 {plan.file_count} 项，生成后 10 分钟内可确认。成绩、评分记录、统计、题卡资产和审计保留。
              </Typography.Paragraph>
            )}
            {plan.action === 'purge' && (
              <>
                <Alert
                  type="warning"
                  showIcon
                  message="直接清理不生成归档"
                  description="将删除本地及远端原始扫描图、校正图和切片包。清理后，本考试仅保留成绩查询与导出，无法查看原卷、重新识别或复核。已有归档可另行下载保存。"
                />
                <Checkbox checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}>
                  我已核对清单，确认只保留成绩并清理扫描文件
                </Checkbox>
              </>
            )}
            {plan.status === 'preview' && plan.expires_at < Date.now() / 1000 && <Alert type="warning" showIcon message="清单已过期，请重新预览。" />}
            <Table
              rowKey="relative"
              size="small"
              dataSource={plan.files}
              pagination={{ defaultPageSize: 50 }}
              columns={[
                { title: '考号', dataIndex: 'candidate_number', render: value => value || '未识读' },
                { title: '面', dataIndex: 'side', render: value => (value === 'front' ? '正面' : value === 'back' ? '背面' : '—') },
                { title: '序号', dataIndex: 'sequence' },
                { title: '文件类型', dataIndex: 'relative', render: value => (value.endsWith('.image') ? '原始图' : '校正图') },
                { title: '大小', dataIndex: 'size', align: 'right', render: bytes },
              ]}
            />
          </Space>
        )}
        {outcome && (
          <Alert
            style={{ marginTop: 12 }}
            type={outcome.status === 'completed' ? 'success' : 'warning'}
            showIcon
            message={outcome.status === 'completed' ? `已处理 ${outcome.released_files} 项` : `${outcome.failed.length} 项未完成，可重试`}
            description={outcome.status === 'partial' ? outcome.failed.slice(0, 10).map((f: any) => `${f.relative}：${f.error}`).join('；') : undefined}
          />
        )}
      </Modal>
    </Space>
  )
}
