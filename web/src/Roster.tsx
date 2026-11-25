import { useEffect, useState } from 'react'
import { Alert, App, Card, Checkbox, Modal, Popconfirm, Space, Statistic, Tag, Typography, Upload } from 'antd'
import { DownloadOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons'
import { Table } from './DataTable'
import { Button } from './Button'
import { download, request, send, useResource, type Row } from './api'
import { HierarchyPicker } from './HierarchyPicker'
import { ErrorNotice } from './EntityTable'
import { RecordPicker } from './RecordPicker'
import { ClassTags, gradeColor } from './SchoolTags'
import { TagPicker } from './TagPicker'
import type { FilterValues } from './recordFilters'

type CandidateList = {
  group_id: string
  grade_id?: string
  classes: Row[]
  students: Row[]
  roster_count: number
  tag_options?: string[]
  tag_colors?: Record<string, string>
}
type ImportReport = {
  preview_sha: string
  total_rows: number
  duplicates: number
  matched_count: number
  students: Row[]
  errors: any[]
  warnings: any[]
}

export function Roster({ groupId, statistics = false }: { groupId?: string; statistics?: boolean }) {
  const groups = useResource<Row[]>('/groups', [])
  const grades = useResource<Row[]>('/grades', [])
  const [selectedGroup, setGroup] = useState(groupId || '')
  const group = groupId || selectedGroup
  const [gradeId, setGrade] = useState<string>()
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()
  const resource = useResource<any>(group ? `/groups/${group}/roster` : null, null)
  const current = groups.data.find(g => g.id === group)
  const [importOpen, setImportOpen] = useState(false)
  const [file, setFile] = useState<File>()
  const [report, setReport] = useState<ImportReport>()
  const [confirmed, setConfirmed] = useState(false)
  const [importError, setImportError] = useState('')
  const [adding, setAdding] = useState(false)
  const [checked, setChecked] = useState<string[]>([])
  const [rosterFilters, setRosterFilters] = useState<FilterValues>({})
  const applyRosterTagFilter = (tagName: string) => {
    setRosterFilters(prev => {
      const cur = prev.tag || []
      return { ...prev, tag: cur.includes(tagName) ? cur : [...cur, tagName] }
    })
  }
  const candidates = useResource<CandidateList | null>(adding && group ? `/groups/${group}/roster/candidates` : null, null)
  const data = resource.data?.group_id === group ? resource.data : null
  const frozen = !!current?.frozen
  const mode = data?.mode || current?.roster_mode || 'open'

  useEffect(() => {
    setGrade(current?.grade_id)
    setImportOpen(false)
    setAdding(false)
    setChecked([])
    setFile(undefined)
    setReport(undefined)
    setImportError('')
  }, [group, current?.grade_id])

  async function refresh() {
    await Promise.all([groups.reload(), resource.reload()])
  }

  async function saveGrade() {
    if (!gradeId) return
    setBusy(true)
    try {
      await send(`/groups/${group}/grade`, { grade_id: gradeId }, 'PUT')
      await refresh()
      message.success('所属年级已保存')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeStudents(ids: string[]) {
    if (!ids.length) return
    setBusy(true)
    try {
      const result = await send<{ removed: number; retained_submissions: number; count: number }>(`/groups/${group}/roster/remove-students`, {
        student_ids: ids,
        confirm_retained: true,
      })
      setChecked([])
      await refresh()
      message.success(
        `已移出 ${result.removed} 名应考学生${result.retained_submissions ? `，${result.retained_submissions} 份已有答卷${statistics ? '' : '及其评分、成绩'}继续保留` : ''}`,
      )
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function preview(next: File) {
    setFile(next)
    setReport(undefined)
    setConfirmed(false)
    setImportError('')
    setBusy(true)
    try {
      const body = new FormData()
      body.append('file', next)
      const prev = await request<ImportReport>(`/groups/${group}/roster/import`, { method: 'POST', body })
      setReport(prev)
      if (prev.matched_count && !prev.errors.length && !prev.warnings.length) {
        body.append('action', 'import')
        body.append('preview_sha', prev.preview_sha)
        await request(`/groups/${group}/roster/import`, { method: 'POST', body })
        await refresh()
        setImportOpen(false)
        setAdding(false)
        message.success('应考名单已保存')
      }
    } catch (e) {
      setImportError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!file || !report) return
    setBusy(true)
    setImportError('')
    try {
      const body = new FormData()
      body.append('file', file)
      body.append('action', 'import')
      body.append('preview_sha', report.preview_sha)
      body.append('confirm_warnings', String(confirmed))
      const result = await request<{ expected_students: number }>(`/groups/${group}/roster/import`, { method: 'POST', body })
      await refresh()
      setImportOpen(false)
      setAdding(false)
      message.success(`已导入 ${result.expected_students} 名应考学生`)
    } catch (e) {
      setImportError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const rosterStudents: Row[] = data?.students || []
  const tagColors: Record<string, string> = data?.tag_colors || candidates.data?.tag_colors || {}
  const candidateData = candidates.data?.group_id === group ? candidates.data : null
  const rosterGrades = [...new Map(rosterStudents.map(s => [String(s.grade_id || s.grade || ''), s.grade || '未设置年级'])).entries()]
    .filter(([value]) => value)
    .map(([value, label]) => ({ value, label }))
  const rosterClasses = [
    ...new Map(rosterStudents.map(s => [s.class_id, { value: s.class_id, label: [s.grade, s.class_name].filter(Boolean).join(' · ') }])).values(),
  ]
  const rosterTags = [...new Set(rosterStudents.flatMap(s => (Array.isArray(s.tags) ? s.tags.map(String) : [])))].map(value => ({
    value,
    label: value,
  }))
  const candidateTags = (candidateData?.tag_options || []).map(value => ({ value, label: value }))
  const issues = report ? [...report.errors.map(v => ({ ...v, type: '需修正' })), ...report.warnings.map(v => ({ ...v, type: '需确认' }))] : []

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!groupId && <HierarchyPicker value={group} onChange={setGroup} />}
      <ErrorNotice error={groups.error || grades.error || resource.error} retry={refresh} />
      {group && (
        <>
          <Card
            title="应考名单"
            extra={
              <Space wrap>
                <Button type="primary" icon={<PlusOutlined />} disabled={busy || frozen} onClick={() => setAdding(true)}>
                  添加名单
                </Button>
                <Button disabled={busy} onClick={refresh}>
                  刷新
                </Button>
              </Space>
            }
          >
            <div className="roster-summary">
              <Statistic title="应考学生" value={rosterStudents.length} />
              <div>
                <Tag color={mode === 'open' ? 'cyan' : 'blue'}>
                  {mode === 'open' ? '开放扫入' : mode === 'selected' ? '指定名单' : '年级全体'}
                </Tag>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  {rosterStudents.length === 0
                    ? '默认保持空白：扫描答题卡时将自动识别并把考生纳入当前名单；也可点击「添加名单」按标签筛选或通过 Excel 导入。'
                    : mode === 'open'
                      ? '当前允许扫描自动纳入新考生，也可通过「添加名单」按标签筛选或导入补充。'
                      : '已指定固定应考名单，学生资料与标签实时关联。'}
                </Typography.Paragraph>
              </div>
            </div>
          </Card>

          <Card title="所属年级">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <TagPicker
                disabled={busy || frozen}
                value={gradeId}
                onChange={setGrade}
                aria-label="全局年级"
                options={grades.data
                  .filter(g => !g.archived || g.id === current?.grade_id)
                  .map(g => ({ label: g.name, value: g.id, color: gradeColor(g.name) }))}
              />
              <div>
                <Button disabled={busy || frozen || !gradeId || gradeId === current?.grade_id} loading={busy} onClick={saveGrade}>
                  保存所属年级
                </Button>
              </div>
            </Space>
          </Card>

          <Card
            title="应考学生"
            extra={
              <Popconfirm
                title={`移出所选 ${checked.length} 名应考学生？`}
                description={statistics?'仅调整当前题卡的应考名单，已有答卷继续保留。':'仅调整当前题卡的应考名单，已有答卷、评分和成绩继续保留。'}
                onConfirm={() => removeStudents(checked)}
              >
                <Button danger disabled={busy || frozen || !checked.length}>
                  移出所选（{checked.length}）
                </Button>
              </Popconfirm>
            }
          >
            <Table<Row>
              rowKey="id"
              loading={resource.loading}
              dataSource={rosterStudents}
              searchText={s => [s.grade, s.class_name, ...(s.tags || [])]}
              rowSelection={{
                selectedRowKeys: checked,
                onChange: keys => setChecked(keys.map(String)),
                getCheckboxProps: () => ({ disabled: busy || frozen }),
              }}
              filterFields={[
                { key: 'tag', label: '标签', options: rosterTags, values: s => s.tags || [] },
                { key: 'grade', label: '年级', options: rosterGrades, values: s => [String(s.grade_id || s.grade || '')] },
                { key: 'class', label: '班级', options: rosterClasses, values: s => [s.class_id] },
                {
                  key: 'status',
                  label: '采集状态',
                  options: [
                    { value: 'unscanned', label: '未扫描' },
                    { value: 'scanned', label: '已扫描' },
                    { value: 'absent', label: '已确认缺考' },
                  ],
                  values: s => [s.status],
                },
              ]}
              filterValues={rosterFilters}
              onFilterValuesChange={setRosterFilters}
              pagination={{ defaultPageSize: 50, showSizeChanger: true }}
              locale={{ emptyText: '当前名单为空（开放扫入模式，扫入即自动加入，或点击上方「添加名单」）' }}
              columns={[
                { title: '准考证号', dataIndex: 'candidate_number' },
                { title: '姓名', dataIndex: 'name' },
                { title: '年级', dataIndex: 'grade' },
                { title: '班级', dataIndex: 'class_name' },
                { title: '标签', width: 220, render: (_, s) => <ClassTags tags={s.tags} colorMap={tagColors} onTagClick={applyRosterTagFilter} /> },
                {
                  title: '采集状态',
                  dataIndex: 'status',
                  render: value => (
                    <Tag
                      color={value === 'scanned' ? 'green' : undefined}
                      style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                      onClick={e => {
                        e.stopPropagation()
                        setRosterFilters(prev => {
                          const cur = prev.status || []
                          return { ...prev, status: cur.includes(value) ? cur : [...cur, value] }
                        })
                      }}
                    >
                      {value === 'unscanned' ? '未扫描' : value === 'absent' ? '已确认缺考' : '已扫描'}
                    </Tag>
                  ),
                },
                {
                  title: '操作',
                  key: 'actions',
                  className: 'row-actions',
                  render: (_, student) => (
                    <Popconfirm
                      title={`将 ${student.name} 移出应考名单？`}
                      description={statistics?'仅调整当前题卡的应考名单，已有答卷继续保留。':'仅调整当前题卡的应考名单，已有答卷、评分和成绩继续保留。'}
                      onConfirm={() => removeStudents([student.id])}
                    >
                      <Button danger disabled={busy || frozen}>
                        移出名单
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </Card>

          <RecordPicker<Row>
            title="添加应考名单"
            open={adding}
            onClose={() => setAdding(false)}
            value={[]}
            loading={candidates.loading || (adding && !candidates.loaded)}
            records={candidateData?.students || []}
            columns={[
              { title: '准考证号', dataIndex: 'candidate_number' },
              { title: '姓名', dataIndex: 'name' },
              { title: '年级', dataIndex: 'grade' },
              { title: '班级', dataIndex: 'class_name' },
              { title: '标签', width: 220, render: (_, s) => <ClassTags tags={s.tags} colorMap={tagColors} /> },
              { title: '当前状态', dataIndex: 'in_roster', render: value => <Tag color={value ? 'green' : undefined}>{value ? '已在名单' : '可添加'}</Tag> },
            ]}
            fields={[
              { key: 'tag', label: '标签（年级/选科/自定义）', options: candidateTags, values: s => s.tags || [] },
              { key: 'class', label: '行政班', options: (candidateData?.classes || []).map(c => ({ value: c.id, label: c.name })), values: s => [s.class_id] },
              {
                key: 'membership',
                label: '名单状态',
                options: [
                  { value: 'available', label: '未在名单' },
                  { value: 'included', label: '已在名单' },
                ],
                values: s => [s.in_roster ? 'included' : 'available'],
              },
            ]}
            extra={
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {candidates.error ? (
                  <Alert type="error" showIcon message={candidates.error} action={<Button onClick={candidates.reload}>重试</Button>} />
                ) : (
                  <Space wrap align="center">
                    <Typography.Text type="secondary">支持按标签（年级、班级层次、选科、自定义标签）筛选批量勾选，或直接从表格导入：</Typography.Text>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      disabled={busy}
                      onClick={() => download(`/groups/${group}/roster/template`, '应考名单模板.xlsx').catch(e => message.error(e.message))}
                    >
                      下载 Excel 模板
                    </Button>
                    <Button
                      size="small"
                      icon={<UploadOutlined />}
                      disabled={busy || frozen || !current?.grade_id}
                      onClick={() => {
                        setFile(undefined)
                        setReport(undefined)
                        setImportError('')
                        setConfirmed(false)
                        setImportOpen(true)
                      }}
                    >
                      {rosterStudents.length > 0 ? '重新导入名单（覆盖）' : '批量导入名单'}
                    </Button>
                  </Space>
                )}
              </Space>
            }
            label={s => `${s.name}（${s.candidate_number}）`}
            onChange={async ids => {
              if (!ids.length) return
              setBusy(true)
              try {
                const outcome = await send<{ count: number; added: number }>('/groups/' + group + '/roster/add-students', { student_ids: ids })
                await refresh()
                message[outcome.added ? 'success' : 'info'](outcome.added ? `已添加 ${outcome.added} 名学生` : '所选学生均已在应考名单中')
              } catch (e) {
                message.error((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
            importer={{
              templateUrl: '/selection/students/template',
              templateName: '应考学生匹配模板.xlsx',
              upload: async f => {
                const body = new FormData()
                body.append('file', f)
                return (await request<{ ids: string[] }>('/selection/students/match', { method: 'POST', body })).ids
              },
            }}
          />

          <Modal
            title="批量导入应考名单"
            width={860}
            open={importOpen}
            onCancel={() => !busy && setImportOpen(false)}
            okText="确认导入"
            onOk={apply}
            confirmLoading={busy}
            okButtonProps={{ disabled: !report || report.errors.length > 0 || !report.matched_count || (report.warnings.length > 0 && !confirmed) }}
          >
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                填写模板中的准考证号，可选填姓名。上传后自动关联全局学生并覆盖当前应考名单，重复行合并。
              </Typography.Paragraph>
              <Space wrap>
                <Upload
                  accept=".xlsx,.csv"
                  showUploadList={false}
                  disabled={busy}
                  beforeUpload={next => {
                    void preview(next)
                    return false
                  }}
                >
                  <Button icon={<UploadOutlined />} disabled={busy} loading={busy}>
                    选择表格文件
                  </Button>
                </Upload>
                <Button
                  icon={<DownloadOutlined />}
                  disabled={busy}
                  onClick={() => download(`/groups/${group}/roster/template`, '应考名单模板.xlsx').catch(e => message.error(e.message))}
                >
                  下载 Excel 模板
                </Button>
                {file && <Typography.Text>{file.name}</Typography.Text>}
              </Space>
              {importError && (
                <Alert
                  type="error"
                  showIcon
                  message={importError}
                  action={
                    file && (
                      <Button disabled={busy} onClick={() => preview(file)}>
                        重新预览
                      </Button>
                    )
                  }
                />
              )}
              {report && (
                <>
                  <Space size={24} wrap>
                    <Statistic title="数据行" value={report.total_rows} />
                    <Statistic title="匹配学生" value={report.matched_count} />
                    <Statistic title="合并重复行" value={report.duplicates} />
                  </Space>
                  {report.errors.length > 0 && (
                    <Alert type="error" showIcon message={`有 ${report.errors.length} 行需要修正，请维护全局学生或修改表格后重新上传。`} />
                  )}
                  {issues.length > 0 ? (
                    <Table
                      size="small"
                      rowKey={(_, i) => String(i)}
                      dataSource={issues}
                      pagination={{ defaultPageSize: 50 }}
                      scroll={{ x: 'max-content' }}
                      columns={[
                        { title: '行', dataIndex: 'row' },
                        { title: '准考证号', dataIndex: 'candidate_number' },
                        { title: '表格姓名', dataIndex: 'name' },
                        { title: '当前姓名', dataIndex: 'actual_name' },
                        { title: '处理', dataIndex: 'type' },
                        { title: '说明', dataIndex: 'reason' },
                      ]}
                    />
                  ) : (
                    <Alert type="success" showIcon message="全部匹配。" />
                  )}
                  {report.warnings.length > 0 && (
                    <Checkbox checked={confirmed} onChange={event => setConfirmed(event.target.checked)}>
                      已核对跨年级或姓名差异记录，按匹配的全局学生导入
                    </Checkbox>
                  )}
                </>
              )}
            </Space>
          </Modal>
        </>
      )}
    </Space>
  )
}
