import { useMemo, useState } from 'react'
import { ArrowRightOutlined } from '@ant-design/icons'
import { Card, Empty, Input, Segmented, Space, Tabs, Tag, Typography } from 'antd'
import { Table } from './DataTable'
import { Button } from './Button'
import { ErrorNotice } from './EntityTable'
import { MultipleRecordSelect, RecordSelect } from './RecordSelect'
import { ExportPreviewModal, FilterSummaryBar, type FilterChip, type ReportColumn } from './ReportToolkit'
import { ClassTags, DEFAULT_CLASS_TAGS, gradeColor } from './SchoolTags'
import { MultiTagPicker } from './TagPicker'
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

function formatCell(value: unknown, row: Row, key: string, metric: string, showConversionFlow = true) {
  if (key === 'answer') {
    const label = value === null || value === undefined ? '未设' : String(value)
    return <Tag color={label === '未设' ? 'default' : 'green'}>{label}</Tag>
  }
  if (key.startsWith('opt_') && key !== 'opt_blank') {
    const letter = key.slice(4)
    const isCorrect = Array.isArray(row._option_meta?.answers) && row._option_meta.answers.includes(letter)
    const textVal = value === null || value === undefined || value === '' ? '—' : String(value)
    return isCorrect && textVal !== '—' ? <Tag color="green">{textVal}</Tag> : <span className="numeric-cell">{textVal}</span>
  }
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
  if (
    showConversionFlow &&
    metric === 'converted' &&
    typeof value === 'number' &&
    key !== 'rank' &&
    row._raw &&
    typeof row._raw[key] === 'number'
  ) {
    const rawVal = row._raw[key] as number
    const delta = Math.round((value - rawVal) * 100) / 100
    const deltaLabel = delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : '±0'
    const tone = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : 'is-flat'
    return (
      <span className="conversion-score-flow numeric-cell" title={`原始分 ${rawVal}，赋分变化 ${deltaLabel}，赋分后 ${value}`}>
        <span className="conversion-raw">{rawVal}</span>
        <span className="conversion-link" aria-hidden="true">
          <span className="conversion-line" />
          <span className={`conversion-delta ${tone}`}>{deltaLabel}</span>
          <ArrowRightOutlined className="conversion-arrow" />
        </span>
        <strong className="conversion-final">{value}</strong>
      </span>
    )
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
            <RecordSelect title="考试项目" records={projects.data.filter(p => p.category !== 'statistics')} value={chosen} onChange={setChosen} />
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
  const [view, setView] = useState<'totals' | 'items' | 'options'>('totals')
  const [metric, setMetric] = useState<'raw' | 'converted'>('raw')
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [exporting, setExporting] = useState(false)

  const activeMetric = view === 'totals' ? metric : 'raw'
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
      const identity = c.key === 'candidate_number' || c.key === 'name' || c.key === 'subject' || c.key === 'number'
      const isMeta = identity || c.key === 'grade' || c.key === 'class_name' || c.key === 'status' || c.key === 'group' || c.key === 'question_type' || c.key === 'answer'
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
          {!gradeId && (data.data.options.grades || []).length > 0 && (
            <Space wrap align="center">
              <Typography.Text type="secondary">年级</Typography.Text>
              <MultiTagPicker
                compact
                aria-label="年级"
                options={(data.data.options.grades || []).map(g => ({ value: g.id, label: g.name, color: gradeColor(g.name) }))}
                value={filters.grade_ids}
                onChange={ids => change('grade_ids', ids)}
              />
            </Space>
          )}
          {!subjectId && (data.data.options.subjects || []).length > 0 && (
            <Space wrap align="center">
              <Typography.Text type="secondary">科目</Typography.Text>
              <MultiTagPicker
                compact
                showSelectAll
                aria-label="科目"
                options={(data.data.options.subjects || []).map(s => ({ value: s.id, label: s.name }))}
                value={filters.subject_ids}
                onChange={ids => change('subject_ids', ids)}
              />
            </Space>
          )}
          {(data.data.options.statuses || []).length > 0 && (
            <Space wrap align="center">
              <Typography.Text type="secondary">成绩状态</Typography.Text>
              <MultiTagPicker
                compact
                aria-label="成绩状态"
                options={(data.data.options.statuses || []).map(r => ({ value: r.id, label: r.name }))}
                value={filters.statuses || []}
                onChange={ids => change('statuses', ids)}
              />
            </Space>
          )}
          <Space wrap align="start">
            <MultipleRecordSelect
              title="班级"
              records={data.data.options.classes || []}
              value={filters.class_ids}
              onChange={ids => change('class_ids', ids)}
              fields={[
                {
                  key: 'grade',
                  label: '年级',
                  options: [...new Set((data.data.options.classes || []).map(c => String(c.grade_name || '')).filter(Boolean))].map(value => ({
                    value,
                    label: value,
                  })),
                  values: c => [c.grade_name || ''],
                },
                {
                  key: 'tag',
                  label: '班级标签',
                  options: [
                    ...new Set(
                      [...DEFAULT_CLASS_TAGS, ...(data.data.options.classes || []).flatMap(c => (Array.isArray(c.tags) ? c.tags.map(String) : []))].filter(
                        Boolean,
                      ),
                    ),
                  ].map(value => ({ value, label: value })),
                  values: c => c.tags || [],
                },
              ]}
              columns={[
                { title: '班级', render: (_, c) => c.class_name || c.name },
                { title: '年级', render: (_, c) => c.grade_name || '—' },
                { title: '标签', render: (_, c) => <ClassTags tags={c.tags} /> },
              ]}
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
            summary={data.loaded ? (view === 'options' ? `共 ${data.data.total} 道客观题` : `共 ${data.data.total} 名学生`) : undefined}
          />
        </Space>
      </Card>

      <Card>
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <ErrorNotice error={data.error} retry={data.reload} />
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {view === 'options'
              ? '按当前可见班级与筛选条件统计各客观题选项分布及正答率（绿色高亮为标准答案选项）。'
              : groupId
                ? '当前题卡自身成绩，总分按可见范围混合排名；默认裸分，小题分始终显示原始得分，同分并列跳号。'
                : '汇总已发布成绩，同一学生同科多份题卡按异常卷处理；默认裸分，小题分始终显示原始得分，同分并列跳号。'}
          </Typography.Text>
          <Table
          query=""
          columnChooser
          exportable={false}
          rowKey={view === 'options' ? 'row_key' : 'student_id'}
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
                  setView(v as 'totals' | 'items' | 'options')
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
                      { value: 'raw', label: '原始分（裸分）' },
                      { value: 'converted', label: '赋分模式' },
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
          rowKey={view === 'options' ? 'row_key' : 'student_id'}
          filenameBase={view === 'options' ? '选项分布' : '成绩'}
          renderCell={(value, row, key) => formatCell(value, row, key, activeMetric, false)}
        />
      )}
    </Space>
  )
}
