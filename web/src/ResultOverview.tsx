import { useEffect, useMemo, useState } from 'react'
import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined } from '@ant-design/icons'
import { Alert, Card, Checkbox, Drawer, Empty, Select, Space, Typography } from 'antd'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { ComparisonChart, ComparisonExport } from './ComparisonPresentation'
import { MultipleRecordSelect, RecordSelect } from './RecordSelect'
import { FilterSummaryBar, type FilterChip } from './ReportToolkit'
import { useResource, type Row } from './api'
import { resultState } from './resultFilterParams'
import { rowNavigation } from './rowNavigation'
import './result-overview.css'

const kinds = [
  { value: 'subject', label: '科目' },
  { value: 'grade', label: '年级' },
  { value: 'class', label: '班级' },
  { value: 'card', label: '题卡' },
]

const scopeLabel = (row: Row) =>
  [row.project, row.subject, row.grade, row.label !== row.subject && row.label !== row.grade ? row.label : ''].filter(Boolean).join(' · ')

const formatValue = (number: unknown) => (number === undefined || number === null ? '—' : String(number))

function ScopeDetail({ scope, groupId, onClose }: { scope: Row; groupId?: string; onClose: () => void }) {
  const params = new URLSearchParams({ scope_id: scope.id, project_id: scope.project_id })
  if (groupId) params.set('group_id', groupId)
  const data = useResource<Row | null>(`/analysis/overview/detail?${params}`, null)
  return (
    <Drawer open onClose={onClose} title={`${scopeLabel(scope)} · 成绩明细`} width="min(940px, 96vw)">
      <ErrorNotice error={data.error} retry={data.reload} />
      <Table<Row>
        bordered
        rowKey={r => `${r.group_id}:${r.student_id}`}
        loading={data.loading}
        dataSource={data.data?.students || []}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '姓名', dataIndex: 'name' },
          { title: '准考证号', dataIndex: 'candidate_number' },
          { title: '班级', dataIndex: 'class_name' },
          { title: '题卡', dataIndex: 'card' },
          { title: '成绩', dataIndex: 'total', align: 'right', render: (v, r) => (r.status === 'completed' ? formatValue(v) : '—') },
          { title: '满分', dataIndex: 'full_score', align: 'right' },
          { title: '状态', dataIndex: 'status', render: s => resultState[s] || s },
        ]}
      />
    </Drawer>
  )
}

export function ResultOverview({ projectId, groupId, onOpenExam }: { projectId?: string; groupId?: string; onOpenExam: (id: string) => void }) {
  const [detail, setDetail] = useState<Row | null>(null)
  const scopeParams = new URLSearchParams()
  if (groupId) scopeParams.set('group_id', groupId)
  const resource = useResource<{ scopes: Row[] }>(`/analysis/overview?${scopeParams}`, { scopes: [] })
  const [kind, setKind] = useState(groupId ? 'card' : 'subject')
  const [project, setProject] = useState(projectId || '')
  const [subject, setSubject] = useState('')
  const [grade, setGrade] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [crossSubject, setCrossSubject] = useState(false)
  const [exporting, setExporting] = useState('')
  const [exportIds, setExportIds] = useState<string[]>([])

  const scopes = resource.data.scopes
  const anchor = scopes.find(r => r.kind === 'card' && r.group_ids.includes(groupId))
  useEffect(() => {
    if (anchor) {
      setProject(anchor.project_id)
      setSubject(anchor.subject)
      setKind('card')
    }
  }, [groupId, anchor?.id])
  useEffect(() => {
    if (projectId) setProject(projectId)
  }, [projectId])

  const options = (key: string) =>
    [...new Set(scopes.map(r => r[key]).filter(Boolean))].map(v => ({
      value: v,
      label: key === 'project_id' ? scopes.find(r => r.project_id === v)?.project : v,
    }))

  const visible = useMemo(
    () =>
      scopes.filter(
        r =>
          r.kind === kind &&
          (!project || r.project_id === project) &&
          (!subject || r.subject === subject) &&
          (!grade || r.grade === grade),
      ),
    [scopes, kind, project, subject, grade],
  )

  const compared = selected.map(id => scopes.find(r => r.id === id)).filter((r): r is Row => !!r)
  const comparisonSubject = subject || compared[0]?.subject
  const comparable = scopes.filter(r => r.kind === kind && (crossSubject || !comparisonSubject || r.subject === comparisonSubject))

  function exportRows(format: string, ids: string[]) {
    if (!ids.length) return
    setExportIds(ids)
    setExporting(format)
  }

  function moveSelected(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= selected.length) return
    setSelected(ids => {
      const next = [...ids]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const filterChips = useMemo<FilterChip[]>(() => {
    const chips: FilterChip[] = []
    if (!projectId && !groupId && project) {
      const label = options('project_id').find(o => o.value === project)?.label || project
      chips.push({ key: 'project', label: `考试：${label}`, onRemove: () => setProject('') })
    }
    if (!groupId && subject) {
      chips.push({ key: 'subject', label: `科目：${subject}`, onRemove: () => { setSubject(''); setSelected([]) } })
    }
    if (!groupId && grade && kind !== 'subject') {
      chips.push({ key: 'grade', label: `年级：${grade}`, onRemove: () => setGrade('') })
    }
    return chips
  }, [projectId, groupId, project, subject, grade, kind, scopes])

  const resetFilters = () => {
    if (!projectId && !groupId) setProject('')
    if (!groupId) {
      setSubject('')
      setGrade('')
    }
  }

  const columns = [
    {
      title: '考试',
      dataIndex: 'project',
      render: (name: string, row: Row) => (
        <Button type="link" onClick={() => onOpenExam(row.project_id)}>
          {name}
        </Button>
      ),
    },
    { title: '科目', dataIndex: 'subject' },
    { title: '年级', dataIndex: 'grade', render: formatValue },
    {
      title: '统计范围',
      dataIndex: 'label',
      render: (name: string, row: Row) => (
        <Button type="link" onClick={() => setDetail(row)}>
          {name}
        </Button>
      ),
    },
    { title: '应考份次', dataIndex: 'records', align: 'right' as const },
    { title: '已结分', dataIndex: 'completed', align: 'right' as const },
    { title: '待结分', dataIndex: 'pending', align: 'right' as const },
    { title: '缺考', dataIndex: 'absent', align: 'right' as const },
    { title: '未扫描', dataIndex: 'unscanned', align: 'right' as const },
    { title: '统计份数', dataIndex: 'analyzed', align: 'right' as const },
    { title: '平均分', dataIndex: 'average', align: 'right' as const, render: formatValue },
    { title: '满分', dataIndex: 'full_score', align: 'right' as const, render: formatValue },
    { title: '平均得分率%', dataIndex: 'score_rate', align: 'right' as const, render: formatValue },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {detail && <ScopeDetail key={detail.id} scope={detail} groupId={groupId} onClose={() => setDetail(null)} />}
      <Card
        title="多次对比"
        extra={
          <Button onClick={() => void resource.reload()} loading={resource.loading}>
            刷新
          </Button>
        }
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space wrap>
            <Select
              aria-label="概览维度"
              value={kind}
              options={groupId ? kinds.filter(k => ['class', 'card'].includes(k.value)) : kinds}
              onChange={next => {
                setKind(next)
                setSelected([])
                if (next === 'subject') setGrade('')
              }}
            />
            {!projectId && !groupId && (
              <RecordSelect
                title="考试项目"
                records={options('project_id').map(o => ({ id: o.value, name: o.label }))}
                value={project}
                onChange={setProject}
              />
            )}
            {!groupId && (
              <RecordSelect
                title="科目"
                records={options('subject').map(o => ({ id: o.value, name: o.label }))}
                value={subject}
                onChange={next => {
                  setSubject(next)
                  setSelected([])
                }}
              />
            )}
            {!groupId && (
              <RecordSelect
                title="年级"
                disabled={kind === 'subject'}
                records={options('grade').map(o => ({ id: o.value, name: o.label }))}
                value={grade}
                onChange={setGrade}
              />
            )}
            <Button
              disabled={!visible.length}
              onClick={() =>
                setSelected(
                  visible.filter(r => crossSubject || r.subject === (comparisonSubject || visible[0]?.subject)).map(r => r.id),
                )
              }
            >
              对比当前范围
            </Button>
            <Button disabled={!visible.length || !!exporting} loading={exporting === 'csv'} onClick={() => exportRows('csv', visible.map(r => r.id))}>
              导出预览（CSV）
            </Button>
            <Button disabled={!visible.length || !!exporting} loading={exporting === 'xlsx'} onClick={() => exportRows('xlsx', visible.map(r => r.id))}>
              导出预览（Excel）
            </Button>
          </Space>
          <FilterSummaryBar
            chips={filterChips}
            onReset={resetFilters}
            summary={resource.loaded ? `当前筛选共 ${visible.length} 个范围，已选 ${selected.length} 项用于对比` : undefined}
          />
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            平均分按已完成评分的实考答卷计算，缺考、未扫描和待结分单列。同一学生同科多份题卡记录按异常处理，排除统计；不同满分的范围可用得分率对比。
          </Typography.Paragraph>
        </Space>
      </Card>

      <ErrorNotice error={resource.error} retry={resource.reload} />

      <Card>
        <Table<Row>
          loading={resource.loading}
          onRow={r => rowNavigation(() => setDetail(r), scopeLabel(r))}
          rowKey="id"
          dataSource={visible}
          columns={columns}
          locale={{ emptyText: resource.error ? '无法加载范围数据' : '暂无可对比的已发布成绩范围' }}
          scroll={{ x: 'max-content' }}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: keys => {
              const rows = scopes.filter(r => keys.includes(r.id))
              const first = rows[0]?.subject
              setSelected(rows.filter(r => crossSubject || r.subject === first).map(r => r.id))
            },
            getCheckboxProps: r => ({ disabled: !crossSubject && !!comparisonSubject && r.subject !== comparisonSubject }),
          }}
        />
      </Card>

      <Card
        title="范围对比"
        extra={
          <Space>
            <Button disabled={!compared.length || !!exporting} onClick={() => exportRows('xlsx', selected)}>
              导出对比表
            </Button>
            <Button disabled={!selected.length} onClick={() => setSelected([])}>
              清空对比
            </Button>
          </Space>
        }
      >
        <Space wrap style={{ width: '100%', marginBottom: 12 }}>
          {!groupId && (
            <Checkbox
              checked={crossSubject}
              onChange={event => {
                setCrossSubject(event.target.checked)
                if (!event.target.checked) {
                  const first = compared[0]?.subject
                  setSelected(compared.filter(r => r.subject === first).map(r => r.id))
                }
              }}
            >
              允许跨科目对比
            </Checkbox>
          )}
          <MultipleRecordSelect
            title="对比范围"
            records={comparable.map(r => ({ ...r, name: scopeLabel(r) }))}
            value={selected}
            onChange={setSelected}
            fields={(['project', 'subject', 'grade', 'class_name'] as const).map(key => ({
              key,
              label: { project: '考试', subject: '科目', grade: '年级', class_name: '班级' }[key],
              options: [...new Set(comparable.map(r => r[key]).filter(Boolean))].map(val => ({ value: val, label: val })),
              values: r => (r[key] ? [r[key]] : []),
            }))}
          />
        </Space>
        {!compared.length ? (
          <Empty description="请在上方勾选或选择要对比的统计范围" />
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <ComparisonChart rows={compared} />
            <Table<Row>
              onRow={r => rowNavigation(() => setDetail(r), scopeLabel(r))}
              rowKey="id"
              dataSource={compared}
              pagination={false}
              columns={[
                {
                  title: '顺序与调整',
                  width: 156,
                  render: (_, r) => {
                    const index = selected.indexOf(r.id)
                    return (
                      <Space size={4}>
                        <span className="numeric-cell" style={{ minWidth: 20, display: 'inline-block' }}>
                          {index + 1}
                        </span>
                        <Button
                          size="small"
                          type="text"
                          icon={<ArrowUpOutlined />}
                          aria-label={`上移第 ${index + 1} 项`}
                          disabled={index <= 0}
                          onClick={() => moveSelected(index, -1)}
                        />
                        <Button
                          size="small"
                          type="text"
                          icon={<ArrowDownOutlined />}
                          aria-label={`下移第 ${index + 1} 项`}
                          disabled={index < 0 || index >= selected.length - 1}
                          onClick={() => moveSelected(index, 1)}
                        />
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<CloseOutlined />}
                          aria-label={`移除第 ${index + 1} 项`}
                          onClick={() => setSelected(ids => ids.filter(id => id !== r.id))}
                        />
                      </Space>
                    )
                  },
                },
                ...columns,
              ]}
              scroll={{ x: 'max-content' }}
            />
          </Space>
        )}
      </Card>

      {!!exportIds.length && (
        <ComparisonExport
          key={`${exportIds.join(',')}:${exporting}`}
          ids={exportIds}
          initialFormat={exporting}
          onClose={() => {
            setExportIds([])
            setExporting('')
          }}
        />
      )}
    </Space>
  )
}
