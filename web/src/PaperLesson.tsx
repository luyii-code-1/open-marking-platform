import { useEffect, useMemo, useState } from 'react'
import { Alert, Empty, Input, Segmented, Select, Space, Spin, Tabs } from 'antd'
import {
  ArrowLeftOutlined,
  BarChartOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  LeftOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { Button } from './Button'
import { ClassChart, DifficultyTag, QuestionResult, type Comparison, type Question } from './LessonStatistics'
import { gradeColor } from './SchoolTags'
import { TagPicker } from './TagPicker'
import { useResource, type Row } from './api'
import './paper-lesson.css'

export type LessonScope = { project?: string; grade?: string; cls?: string; card?: string }

type Lesson = {
  group_id: string
  class_id: string
  full_score: number
  questions: Question[]
  weak_order?: string[]
  comparison: Comparison
}

type SortMode = 'paper' | 'weak'

const order = (a: string, b: string) => a.localeCompare(b, 'zh-CN', { numeric: true })
const gradeKey = (cls: Row) => (cls.grade_id ? `id:${cls.grade_id}` : `legacy:${cls.grade || ''}`)
const gradeLabel = (cls: Row) => cls.grade || '未设置年级'

function LessonContent({
  card,
  cls,
  onCatalogStale,
}: {
  card: Row
  cls: Row
  onCatalogStale: () => void
}) {
  const params = new URLSearchParams({ group_id: card.id, class_id: cls.id })
  const data = useResource<Lesson | null>('/analysis/paper-lesson?' + params, null)
  const [sort, setSort] = useState<SortMode>('paper')
  const [activeId, setActiveId] = useState('')
  const [tab, setTab] = useState<'questions' | 'compare'>('questions')
  const [metric, setMetric] = useState('total')
  const [classroom, setClassroom] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [showDist, setShowDist] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')

  const stale = !!data.data && (data.data.group_id !== card.id || data.data.class_id !== cls.id)
  const questions = !stale && data.data ? data.data.questions : []
  const weakOrder = !stale && data.data ? data.data.weak_order : undefined

  const orderedQuestions = useMemo(() => {
    if (!questions.length) return []
    if (sort === 'paper') return questions
    if (weakOrder?.length) {
      const byId = new Map(questions.map(q => [q.id, q]))
      const list = weakOrder.map(id => byId.get(id)).filter((q): q is Question => !!q)
      if (list.length === questions.length) return list
    }
    return [...questions]
      .map((q, idx) => ({ q, idx }))
      .sort((a, b) => {
        const ra = a.q.raw_score_rate ?? a.q.score_rate
        const rb = b.q.raw_score_rate ?? b.q.score_rate
        if (ra == null && rb == null) return a.idx - b.idx
        if (ra == null) return 1
        if (rb == null) return -1
        return ra - rb || a.idx - b.idx
      })
      .map(item => item.q)
  }, [questions, sort, weakOrder])

  useEffect(() => {
    if (orderedQuestions.length && !orderedQuestions.some(q => q.id === activeId)) {
      setActiveId(orderedQuestions[0].id)
    }
  }, [orderedQuestions, activeId])

  if (data.error) {
    return (
      <Alert
        type="error"
        showIcon
        message={data.error}
        action={
          <Space>
            <Button onClick={data.reload}>重试</Button>
            <Button type="primary" onClick={onCatalogStale}>
              刷新可讲评范围
            </Button>
          </Space>
        }
      />
    )
  }
  if (!data.data || stale) return <Spin />
  if (!orderedQuestions.length) return <Empty description="题卡暂无评分项" />

  const current = orderedQuestions.find(q => q.id === activeId) || orderedQuestions[0]
  const pos = Math.max(0, orderedQuestions.findIndex(q => q.id === current.id))
  const { comparison, full_score } = data.data

  const filteredNav = searchTerm.trim()
    ? orderedQuestions.filter(q => String(q.number).toLowerCase().includes(searchTerm.trim().toLowerCase()))
    : orderedQuestions

  function selectQuestion(id: string) {
    setActiveId(id)
    setTab('questions')
    setRevealed(false)
  }

  function toggleClassroom() {
    setClassroom(prev => {
      const next = !prev
      setRevealed(false)
      setShowDist(!next)
      if (next) setTab('questions')
      return next
    })
  }

  return (
    <div className="lesson-workbench">
      <aside className="lesson-sidebar" aria-label="全卷题目导航">
        <div className="lesson-sidebar-head">
          <h3>全卷题目</h3>
          <span>{orderedQuestions.length} 项</span>
        </div>
        <Segmented<SortMode>
          block
          size="small"
          value={sort}
          onChange={next => {
            setSort(next)
            setActiveId(current.id)
          }}
          options={[
            { value: 'paper', label: '原卷顺序' },
            { value: 'weak', label: '低得分率优先' },
          ]}
        />
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="按题号定位"
          aria-label="按题号定位"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
        />
        <nav className="lesson-question-list">
          {filteredNav.map(q => (
            <button
              type="button"
              key={q.id}
              aria-current={q.id === current.id ? 'true' : undefined}
              className="lesson-q-btn"
              onClick={() => selectQuestion(q.id)}
            >
              <span className="lesson-q-num">第 {q.number} 题</span>
              <span className="lesson-q-type">{q.type === 'subjective' ? '主观' : q.type === 'multiple' ? '多选' : '单选'}</span>
              <span className="lesson-q-rate">{q.score_rate != null ? `${q.score_rate}%` : '—'}</span>
              <span className={`lesson-diff-dot is-${q.difficulty || 'none'}`} aria-hidden="true" />
            </button>
          ))}
          {!filteredNav.length && <div className="lesson-nav-empty">无匹配题号</div>}
        </nav>
        <p className="lesson-sidebar-foot">百分比为本班单题得分率（困难 &lt;60%、较难 &lt;70%、一般 &lt;85%）</p>
      </aside>

      <article className="lesson-main">
        <div className="lesson-main-head">
          <Space wrap size={8} align="center">
            <h2 className="lesson-q-heading">第 {current.number} 题</h2>
            <span className="lesson-q-meta">
              {current.type === 'subjective' ? '主观题' : current.type === 'multiple' ? '多选题' : '单选题'} · 满分 {current.points} 分
            </span>
            <DifficultyTag difficulty={current.difficulty} />
          </Space>
          <Space wrap size={8}>
            <Button
              type={classroom ? 'primary' : 'default'}
              icon={classroom ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              onClick={toggleClassroom}
            >
              {classroom ? '退出课堂讲解' : '课堂讲解'}
            </Button>
            {!classroom &&
              (tab === 'questions' ? (
                <Button
                  icon={<BarChartOutlined />}
                  onClick={() => {
                    setMetric(current.id)
                    setTab('compare')
                  }}
                >
                  对比本题均分
                </Button>
              ) : (
                <Button onClick={() => setTab('questions')}>返回逐题讲评</Button>
              ))}
          </Space>
        </div>

        {classroom ? (
          <>
            <div className="lesson-classroom-bar">
              <span>课堂讲解模式 · 答案默认隐藏，换题或切班后自动复位</span>
              <Space wrap size={8}>
                <Button
                  type="primary"
                  icon={revealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                  onClick={() => setRevealed(v => !v)}
                >
                  {revealed ? '收起答案' : '揭示答案'}
                </Button>
                <Button onClick={() => setShowDist(v => !v)}>{showDist ? '隐藏作答分布' : '显示作答分布'}</Button>
              </Space>
            </div>
            <QuestionResult
              key={current.id}
              q={current}
              gradeWide={comparison.grade_wide}
              hideAnswer={!revealed}
              showDistribution={showDist}
            />
          </>
        ) : (
          <>
            <Tabs
              activeKey={tab}
              onChange={key => setTab(key as 'questions' | 'compare')}
              items={[
                { key: 'questions', label: '本班作答', children: null },
                { key: 'compare', label: '跨班均分', children: null },
              ]}
            />
            {tab === 'questions' ? (
              <QuestionResult key={current.id} q={current} gradeWide={comparison.grade_wide} />
            ) : (
              <div>
                <Space wrap style={{ marginBottom: 12 }}>
                  <span>对比指标</span>
                  <Select
                    aria-label="均分对比项目"
                    showSearch
                    optionFilterProp="label"
                    style={{ minWidth: 200 }}
                    value={metric}
                    options={[
                      { value: 'total', label: '整卷原始总分' },
                      ...orderedQuestions.map(v => ({ value: v.id, label: `第 ${v.number} 题` })),
                    ]}
                    onChange={setMetric}
                  />
                </Space>
                <ClassChart
                  comparison={comparison}
                  metric={metric}
                  maximum={questions.find(v => v.id === metric)?.points ?? full_score}
                  activeClassName={cls.name}
                />
              </div>
            )}
          </>
        )}

        <footer className="lesson-footer">
          <Button icon={<LeftOutlined />} disabled={pos <= 0} onClick={() => selectQuestion(orderedQuestions[pos - 1].id)}>
            上一题
          </Button>
          <span>
            {pos + 1} / {orderedQuestions.length} 个评分项{sort === 'weak' ? ' · 按低得分率优先' : ''}
          </span>
          <Button
            icon={<RightOutlined />}
            iconPosition="end"
            disabled={pos >= orderedQuestions.length - 1}
            onClick={() => selectQuestion(orderedQuestions[pos + 1].id)}
          >
            下一题
          </Button>
        </footer>
      </article>
    </div>
  )
}

export function PaperLesson({
  initial,
  onBack,
}: {
  initial: LessonScope
  onBack?: () => void
}) {
  const catalog = useResource<{ projects: Row[] }>('/analysis/class-catalog', { projects: [] })
  const [choice, setChoice] = useState(initial)
  useEffect(() => {
    setChoice(initial)
  }, [initial.project, initial.grade, initial.cls, initial.card])

  if (catalog.error) return <Alert type="error" message={catalog.error} action={<Button onClick={catalog.reload}>重试</Button>} />
  if (!catalog.loaded) return <Spin />

  const projects = catalog.data.projects.filter(p => p.cards.some((c: Row) => c.published && c.class_ids.length))
  const project = projects.find(p => p.id === choice.project) || projects[0]
  if (!project) {
    return (
      <Empty description="暂无可讲评的已发布题卡">
        {onBack && <Button onClick={onBack}>返回班级成绩</Button>}
      </Empty>
    )
  }

  const published: Row[] = project.cards.filter((c: Row) => c.published)
  const classes: Row[] = project.classes.filter((c: Row) => published.some(card => card.class_ids.includes(c.id)))
  const grades = new Map(classes.map(c => [gradeKey(c), gradeLabel(c)]))
  const requested = classes.find(c => c.id === choice.cls)
  const grade = choice.grade && grades.has(choice.grade) ? choice.grade : gradeKey(requested || classes[0])
  const gradeClasses = classes.filter(c => gradeKey(c) === grade).sort((a, b) => order(a.name, b.name))
  const cls = gradeClasses.find(c => c.id === choice.cls) || gradeClasses[0]
  const cards = published.filter(c => c.class_ids.includes(cls.id))
  const card = cards.find(c => c.id === choice.card) || cards[0]

  return (
    <section className="class-results">
      <div className="lesson-header-bar">
        {onBack && (
          <Button icon={<ArrowLeftOutlined />} onClick={onBack}>
            返回班级成绩
          </Button>
        )}
        <div className="lesson-selectors">
          <label>
            考试
            <Select
              aria-label="讲评考试"
              showSearch
              optionFilterProp="label"
              value={project.id}
              options={projects.map(p => ({ label: p.name, value: p.id }))}
              onChange={id => setChoice({ project: id })}
            />
          </label>
          <label>
            年级
            {grades.size <= 8 ? (
              <TagPicker
                compact
                aria-label="讲评年级标签"
                value={grade}
                options={[...grades].map(([value, label]) => ({ label, value, color: gradeColor(label) }))}
                onChange={g => g && setChoice({ project: project.id, grade: g })}
              />
            ) : (
              <Select
                aria-label="讲评年级标签"
                value={grade}
                options={[...grades].map(([value, label]) => ({ label, value }))}
                onChange={g => setChoice({ project: project.id, grade: g })}
              />
            )}
          </label>
          <label>
            班级
            <Select
              aria-label="讲评班级"
              showSearch
              optionFilterProp="label"
              value={cls.id}
              options={gradeClasses.map(c => ({ label: c.name, value: c.id }))}
              onChange={id => setChoice({ project: project.id, grade, cls: id, card: card?.id })}
            />
          </label>
          <label>
            科目题卡
            <Select
              aria-label="讲评题卡"
              showSearch
              optionFilterProp="label"
              value={card?.id}
              options={cards.map(c => ({ label: `${c.subject} · ${c.name}`, value: c.id }))}
              onChange={id => setChoice({ project: project.id, grade, cls: cls.id, card: id })}
            />
          </label>
        </div>
      </div>
      {card && <LessonContent key={`${card.id}:${cls.id}`} card={card} cls={cls} onCatalogStale={() => void catalog.reload()} />}
    </section>
  )
}
