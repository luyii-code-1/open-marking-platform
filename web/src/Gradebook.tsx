import { useMemo, useState } from 'react'
import { Card, Empty, Input, Segmented, Select, Space, Tabs, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { MultipleRecordSelect, RecordSelect } from './RecordSelect'
import { ExportPreviewModal, FilterSummaryBar, type FilterChip, type ReportColumn } from './ReportToolkit'
import { useResource, type Row } from './api'

type Scope = { projectId?: string; subjectId?: string; gradeId?: string; groupId?: string }
type Report = { rows: Row[]; columns: ReportColumn[]; total: number; version: string; options: Record<string, Row[]> }
const blank: Report = { rows: [], columns: [], total: 0, version: '', options: {} }

const statusColors: Record<string, string> = {
  已完成: 'green',
  待结分: 'processing',
  缺考: 'warning',
  未扫描: 'default',
  同科答卷重复: 'error',
}

const numericKeys = new Set(['total', 'rank'])

function formatCell(value: unknown, row: Row, key: string, metric: string) {
  if (key === 'status') {
    const label = value === null || value === undefined ? '—' : String(value)
    return <Tag color={statusColors[label] || 'default'}>{label}</Tag>
  }
  if (key === 'note') {
    const text = value === null || value === undefined ? '' : String(value)
    return text ? <Typography.Text type="warning">{text}</Typography.Text> : '—'
  }
  if (value === null || value === undefined || value === '') {
    if (metric === 'converted' && row.note && String(row.note).includes('未配置赋分')) {
      return <Typography.Text type="secondary">未配置</Typography.Text>
    }
    return '—'
  }
  return <span className={typeof value === 'number' || numericKeys.has(key) ? 'numeric-cell' : undefined}>{String(value)}</span>
}

export function Gradebook({ projectId, subjectId, gradeId, groupId }: Scope) {
  const projects = useResource<Row[]>(projectId ? null : '/projects', [])
  const [chosen, setChosen] = useState('')
  const project = projectId || chosen
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {!projectId && (
        <Card>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <ErrorNotice error={projects.error} retry={projects.reload} />
            <RecordSelect title="考试项目" records={projects.data} value={chosen} onChange={setChosen} />
          </Space>
        </Card>
      )}
      {project ? (
        <GradebookScope
          key={[project, subjectId, gradeId, groupId].join(':')}
          projectId={project}
          subjectId={subjectId}
          gradeId={gradeId}
          groupId={groupId}
        />
      ) : (
        <Card>
          <Empty description="选择考试项目查看或导出成绩" />
        </Card>
      )}
    </Space>
  )
}

function GradebookScope({ projectId, subjectId, gradeId, groupId }: Scope) {
  const [view, setView] = useState<'totals' | 'items'>('totals')
  const [metric, setMetric] = useState<'raw' | 'converted'>('raw')
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [exporting, setExporting] = useState(false)

  const activeMetric = view === 'items' ? 'raw' : metric
  const baseParams = useMemo(() => {
    const params = new URLSearchParams({ project_id: projectId!, view, metric: activeMetric, q })
    if (subjectId) params.set('subject_id', subjectId)
    if (gradeId) params.set('grade_id', gradeId)
    if (groupId) params.set('group_id', groupId)
    Object.entries(filters).forEach(([key, ids]) => {
      if (ids.length) params.set(key, ids.join(','))
    })
    return params
  }, [projectId, view, activeMetric, q, subjectId, gradeId, groupId, filters])

  const queryParams = new URLSearchParams(baseParams)
  queryParams.set('page', String(page))
  const data = useResource<Report>(`/gradebook?${queryParams}`, blank)

  const change = (key: string, ids: string[]) => {
    setFilters(current => ({ ...current, [key]: ids }))
    setPage(1)
  }

  const resetAll = () => {
    setFilters({})
    setText('')
    setQ('')
    setPage(1)
  }

  const filterChips = useMemo<FilterChip[]>(() => {
    const groups: [string, string, Row[]][] = [
      ['subject_ids', '科目', data.data.options.subjects || []],
      ['grade_ids', '年级', data.data.options.grades || []],
      ['class_ids', '班级', data.data.options.classes || []],
      ['student_ids', '学生', data.data.options.students || []],
      ['group_ids', '题卡', data.data.options.groups || []],
      ['statuses', '状态', data.data.options.statuses || []],
    ]
    const chips: FilterChip[] = groups.flatMap(([key, label, options]) =>
      (filters[key] || []).map(id => ({
        key: `${key}:${id}`,
        label: `${label}：${options.find(o => o.id === id)?.name || id}`,
        onRemove: () => change(key, (filters[key] || []).filter(v => v !== id)),
      })),
    )
    if (q.trim()) {
      chips.push({
        key: 'q',
        label: `关键词：${q.trim()}`,
        onRemove: () => {
          setText('')
          setQ('')
          setPage(1)
        },
      })
    }
    return chips
  }, [filters, data.data.options, q])

  const columns = useMemo(() => {
    const cols = data.data.columns
    const pinIdentity = cols.length > 7
    return cols.map(c => {
      const identity = c.key === 'candidate_number' || c.key === 'name'
      const isMeta = identity || c.key === 'grade' || c.key === 'class_name' || c.key === 'status'
      return {
        key: c.key,
        title: c.label,
        dataIndex: c.key,
        sorter: false as const,
        fixed: pinIdentity && identity ? ('left' as const) : undefined,
        width: c.key === 'candidate_number' ? 132 : c.key === 'name' ? 104 : c.key === 'status' ? 116 : c.key === 'note' ? 220 : undefined,
        align: !isMeta && c.key !== 'note' ? ('right' as const) : ('left' as const),
        ellipsis: c.key === 'note',
        render: (value: unknown, row: Row) => formatCell(value, row, c.key, activeMetric),
      }
    })
  }, [data.data.columns, activeMetric])

  const searchPending = text.trim() !== q.trim()

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small">
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space wrap align="start">
            {!subjectId && (
              <MultipleRecordSelect
                title="科目"
                records={data.data.options.subjects || []}
                value={filters.subject_ids}
                onChange={ids => change('subject_ids', ids)}
              />
            )}
            {!gradeId && (
              <MultipleRecordSelect
                title="年级"
                records={data.data.options.grades || []}
                value={filters.grade_ids}
                onChange={ids => change('grade_ids', ids)}
              />
            )}
            <MultipleRecordSelect
              title="班级"
              records={data.data.options.classes || []}
              value={filters.class_ids}
              onChange={ids => change('class_ids', ids)}
            />
            <MultipleRecordSelect
              title="学生"
              records={data.data.options.students || []}
              value={filters.student_ids}
              onChange={ids => change('student_ids', ids)}
            />
            {!groupId && (
              <MultipleRecordSelect
                title="题卡"
                records={data.data.options.groups || []}
                value={filters.group_ids}
                onChange={ids => change('group_ids', ids)}
              />
            )}
            <Select
              mode="multiple"
              allowClear
              maxTagCount="responsive"
              aria-label="成绩状态"
              placeholder="成绩状态"
              style={{ minWidth: 160 }}
              value={filters.statuses || []}
              onChange={ids => change('statuses', ids)}
              options={(data.data.options.statuses || []).map(r => ({ value: r.id, label: r.name }))}
            />
            <Input.Search
              aria-label="搜索考生"
              placeholder="姓名或准考证号"
              style={{ width: 230 }}
              value={text}
              onChange={e => {
                const next = e.target.value
                setText(next)
                if (!next && q) {
                  setQ('')
                  setPage(1)
                }
              }}
              onSearch={value => {
                setQ(value)
                setPage(1)
              }}
              allowClear
            />
            {searchPending && (
              <Button type="primary" onClick={() => { setQ(text); setPage(1) }}>
                查询
              </Button>
            )}
            {filterChips.length > 0 && <Button onClick={resetAll}>重置条件</Button>}
          </Space>
          <FilterSummaryBar
            chips={filterChips}
            onReset={resetAll}
            summary={data.loaded ? `共 ${data.data.total} 名学生` : undefined}
          />
        </Space>
      </Card>

      <Card>
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <ErrorNotice error={data.error} retry={data.reload} />
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {groupId
              ? '当前题卡自身成绩，总分按可见范围混合排名；默认裸分，小题分始终显示原始得分，同分并列跳号。'
              : '汇总已发布成绩，同一学生同科多份题卡按异常卷处理；默认裸分，小题分始终显示原始得分，同分并列跳号。'}
          </Typography.Text>
          <Table
          query=""
          columnChooser
          rowKey="student_id"
          loading={data.loading}
          dataSource={data.loading ? [] : data.data.rows}
          columns={columns}
          locale={{
            emptyText: filterChips.length ? (
              <Empty description="当前筛选条件下暂无成绩记录">
                <Button onClick={resetAll}>重置条件</Button>
              </Empty>
            ) : (
              <Empty description={groupId ? '当前题卡暂无成绩数据' : '当前范围暂无已发布成绩'} />
            ),
          }}
          toolbar={
            <div className="gradebook-toolbar">
              <Tabs
                size="small"
                activeKey={view}
                onChange={v => {
                  setView(v as 'totals' | 'items')
                  setPage(1)
                }}
                items={[
                  { key: 'totals', label: groupId ? (metric === 'converted' ? '总分（赋分）' : '总分（裸分）') : '概览成绩' },
                  { key: 'items', label: '小题分' },
                ]}
              />
              <Space wrap>
                {view === 'totals' && (
                  <Segmented<'raw' | 'converted'>
                    aria-label="总分口径"
                    value={metric}
                    onChange={v => {
                      setMetric(v)
                      setPage(1)
                    }}
                    options={[
                      { value: 'raw', label: '裸分' },
                      { value: 'converted', label: '赋分' },
                    ]}
                  />
                )}
                <Button loading={data.loading} onClick={() => void data.reload()}>
                  刷新
                </Button>
                <Button type="primary" disabled={!data.loaded || data.loading || !!data.error} onClick={() => setExporting(true)}>
                  导出与预览
                </Button>
              </Space>
            </div>
          }
          pagination={{ current: page, pageSize: 50, total: data.data.total, onChange: setPage, showSizeChanger: false }}
        />
        </Space>
      </Card>

      {exporting && (
        <ExportPreviewModal
          key={baseParams.toString()}
          title="导出配置与预览"
          open
          onClose={() => setExporting(false)}
          columns={data.data.columns}
          previewPath="/gradebook"
          baseParams={baseParams}
          rowKey="student_id"
          filenameBase="成绩"
          renderCell={(value, row, key) => formatCell(value, row, key, activeMetric)}
        />
      )}
    </Space>
  )
}
