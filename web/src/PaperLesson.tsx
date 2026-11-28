import { useEffect, useMemo, useState } from 'react'
import { Alert, Drawer, Empty, Input, Segmented, Select, Space, Spin, Tabs } from 'antd'
import {
  ArrowLeftOutlined,
  DownOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  LeftOutlined,
  RightOutlined,
  SearchOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import { Button } from './Button'
import { ClassChart, DifficultyTag, QuestionResult, type Comparison, type Question } from './LessonStatistics'
import { gradeColor } from './SchoolTags'
import { TagPicker } from './TagPicker'
import { useResource, type Row } from './api'
import type { LessonScope } from './examNavigation'
import './paper-lesson.css'

export type { LessonScope } from './examNavigation'

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

function useCompactViewport(enabled: boolean) {
  const [compact, setCompact] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 820 : enabled))
  useEffect(() => {
    if (!enabled) return
    const sync = () => setCompact(window.innerWidth < 820)
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
    }
  }, [enabled])
  return enabled && compact
}

function LessonContent({
  card,
  cls,
  mobile = false,
  compactNav = false,
  onCatalogStale,
}: {
  card: Row
  cls: Row
  mobile?: boolean
  compactNav?: boolean
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
  const [navOpen, setNavOpen] = useState(false)

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

  useEffect(() => {
    if (!orderedQuestions.length) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      const index = orderedQuestions.findIndex(q => q.id === activeId)
      if (index < 0) return
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault()
        setActiveId(orderedQuestions[index - 1].id)
        setTab('questions')
        setRevealed(false)
      } else if (event.key === 'ArrowRight' && index < orderedQuestions.length - 1) {
        event.preventDefault()
        setActiveId(orderedQuestions[index + 1].id)
        setTab('questions')
        setRevealed(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
    setNavOpen(false)
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

  const questionNavigator = (
    <>
      <Segmented<SortMode>
        block
        size={mobile ? 'middle' : 'small'}
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
        size={mobile ? 'middle' : 'small'}
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
    </>
  )

  return (
    <div className={`lesson-workbench${compactNav ? ' is-compact-nav' : ''}`}>
      {!compactNav && (
        <aside className="lesson-sidebar" aria-label="全卷题目导航">
          <div className="lesson-sidebar-head">
            <h3>全卷题目</h3>
            <span>{orderedQuestions.length} 项</span>
          </div>
          {questionNavigator}
        </aside>
      )}

      <article className="lesson-main">
        <div className="lesson-main-head">
          <Space wrap size={8} align="center">
            <h2 className="lesson-q-heading">第 {current.number} 题</h2>
            <span className="lesson-q-meta">
              {current.type === 'subjective' ? '主观题' : current.type === 'multiple' ? '多选题' : '单选题'} · 满分 {current.points} 分
            </span>
            <DifficultyTag difficulty={current.difficulty} />
          </Space>
          <Space wrap size={8} className="lesson-main-actions">
            {compactNav && (
              <Button icon={<UnorderedListOutlined />} onClick={() => setNavOpen(true)}>
                题单 {pos + 1}/{orderedQuestions.length}
                {sort === 'weak' ? ' · 低分' : ''}
              </Button>
            )}
            <Button
              type={classroom ? 'primary' : 'default'}
              icon={classroom ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              onClick={toggleClassroom}
            >
              {classroom ? '退出课堂讲解' : '课堂讲解'}
            </Button>
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
                <div className="lesson-compare-bar">
                  <span className="lesson-compare-label">对比指标</span>
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
                  {metric !== current.id && (
                    <Button size="small" onClick={() => setMetric(current.id)}>
                      查看第 {current.number} 题
                    </Button>
                  )}
                </div>
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
          {compactNav ? (
            <button type="button" className="lesson-footer-index-btn" onClick={() => setNavOpen(true)}>
              {pos + 1} / {orderedQuestions.length}
              {sort === 'weak' ? ' · 低分优先' : ''}
            </button>
          ) : (
            <span>
              {pos + 1} / {orderedQuestions.length} 个评分项{sort === 'weak' ? ' · 按低得分率优先' : ''}
            </span>
          )}
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

      {compactNav && (
        <Drawer
          title={`全卷题目（${orderedQuestions.length} 项）`}
          placement="bottom"
          height="78dvh"
          open={navOpen}
          onClose={() => setNavOpen(false)}
          className="lesson-mobile-drawer"
        >
          <div className="lesson-drawer-nav">{questionNavigator}</div>
        </Drawer>
      )}
    </div>
  )
}

export function PaperLesson({
  initial,
  onBack,
  mobile = false,
  onScopeChange,
}: {
  initial: LessonScope
  onBack?: () => void
  mobile?: boolean
  onScopeChange?: (scope: LessonScope) => void
}) {
  const catalog = useResource<{ projects: Row[] }>('/analysis/class-catalog', { projects: [] })
  const [localChoice, setChoice] = useState(initial)
  const choice = onScopeChange ? initial : localChoice
  const [scopeOpen, setScopeOpen] = useState(false)
  const compactNav = useCompactViewport(mobile)
  useEffect(() => {
    setChoice(initial)
  }, [initial.project, initial.grade, initial.cls, initial.card])

  function updateChoice(next: LessonScope) {
    setChoice(next)
    onScopeChange?.(next)
  }

  if (catalog.error) return <Alert type="error" message={catalog.error} action={<Space wrap>
    <Button onClick={catalog.reload}>重试</Button>
    {onBack && <Button onClick={onBack}>返回班级成绩</Button>}
  </Space>} />
  if (!catalog.loaded) return <Spin />

  const projects = (catalog.data.projects || []).filter(p => {
    const classIds = new Set((p.classes || []).map((c: Row) => c.id))
    return (p.cards || []).some((c: Row) => c.published && Array.isArray(c.class_ids) && c.class_ids.some((id: string) => classIds.has(id)))
  })
  if (!projects.length) {
    return (
      <Empty description="暂无可讲评的已发布题卡">
        <Space wrap>
          <Button onClick={catalog.reload}>刷新目录</Button>
          {onBack && <Button onClick={onBack}>返回班级成绩</Button>}
        </Space>
      </Empty>
    )
  }

  const matchedProject = choice.project ? projects.find(p => p.id === choice.project) : projects[0]
  if (!matchedProject) {
    return (
      <Empty description="当前考试暂无你可讲评的已发布题卡">
        <Space wrap>
          <Button type="primary" onClick={() => updateChoice({})}>查看可讲评目录</Button>
          <Button onClick={catalog.reload}>刷新范围</Button>
          {onBack && <Button onClick={onBack}>返回</Button>}
        </Space>
      </Empty>
    )
  }

  const project = matchedProject
  const allClassIds = new Set((project.classes || []).map((c: Row) => c.id))
  const published: Row[] = (project.cards || []).filter(
    (c: Row) => c.published && Array.isArray(c.class_ids) && c.class_ids.some((id: string) => allClassIds.has(id)),
  )
  const classes: Row[] = (project.classes || []).filter((c: Row) => published.some(card => card.class_ids.includes(c.id)))
  if (!classes.length || !published.length) {
    return (
      <Empty description="当前考试暂无可讲评的班级与题卡">
        <Space wrap>
          {projects.length > 1 && <Button type="primary" onClick={() => updateChoice({})}>查看可讲评目录</Button>}
          <Button onClick={catalog.reload}>刷新范围</Button>
          {onBack && <Button onClick={onBack}>返回</Button>}
        </Space>
      </Empty>
    )
  }

  const grades = new Map(classes.map(c => [gradeKey(c), gradeLabel(c)]))
  const requested = choice.cls ? classes.find(c => c.id === choice.cls) : undefined
  if (choice.cls && !requested) {
    return (
      <Empty description="当前班级暂无你可讲评的已发布题卡">
        <Space wrap>
          <Button type="primary" onClick={() => updateChoice({ project: project.id })}>查看本场可讲评班级</Button>
          <Button onClick={() => updateChoice({})}>查看全部可讲评目录</Button>
          {onBack && <Button onClick={onBack}>返回</Button>}
        </Space>
      </Empty>
    )
  }

  const grade = choice.grade ?? gradeKey(requested || classes[0])
  const gradeClasses = classes.filter(c => gradeKey(c) === grade).sort((a, b) => order(a.name, b.name))
  const cls = choice.cls ? gradeClasses.find(c => c.id === choice.cls) : gradeClasses[0]
  if (!cls) {
    return (
      <Empty description="当前年级暂无可讲评的班级">
        <Space wrap>
          <Button type="primary" onClick={() => updateChoice({ project: project.id })}>查看本场可讲评目录</Button>
          {onBack && <Button onClick={onBack}>返回</Button>}
        </Space>
      </Empty>
    )
  }

  const cards = published.filter(c => c.class_ids.includes(cls.id))
  const card = choice.card ? cards.find(c => c.id === choice.card) : cards[0]
  if (!card) {
    return (
      <Empty description="当前题卡未发布或不在你的讲评授权范围内">
        <Space wrap>
          <Button type="primary" onClick={() => updateChoice({ project: project.id, grade, cls: cls.id })}>
            查看该班可讲评题卡
          </Button>
          <Button onClick={() => updateChoice({})}>查看全部可讲评目录</Button>
          {onBack && <Button onClick={onBack}>返回</Button>}
        </Space>
      </Empty>
    )
  }

  const selectors = (
    <div className={`lesson-selectors${mobile ? ' is-mobile-stack' : ''}`}>
      <label className="lesson-selector-field">
        <span>考试</span>
        <div className="lesson-selector-control">
          <Select
            aria-label="讲评考试"
            showSearch
            optionFilterProp="label"
            value={project.id}
            options={projects.map(p => ({ label: p.name, value: p.id }))}
            onChange={id => updateChoice({ project: id })}
          />
        </div>
      </label>
      <label className="lesson-selector-field">
        <span>年级</span>
        <div className="lesson-selector-control">
          {grades.size <= 8 ? (
            <TagPicker
              compact
              aria-label="讲评年级标签"
              value={grade}
              options={[...grades].map(([value, label]) => ({ label, value, color: gradeColor(label) }))}
              onChange={g => g && updateChoice({ project: project.id, grade: g })}
            />
          ) : (
            <Select
              aria-label="讲评年级标签"
              value={grade}
              options={[...grades].map(([value, label]) => ({ label, value }))}
              onChange={g => updateChoice({ project: project.id, grade: g })}
            />
          )}
        </div>
      </label>
      <label className="lesson-selector-field">
        <span>班级</span>
        <div className="lesson-selector-control">
          <Select
            aria-label="讲评班级"
            showSearch
            optionFilterProp="label"
            value={cls.id}
            options={gradeClasses.map(c => ({ label: c.name, value: c.id }))}
            onChange={id => {
              const nextCards = published.filter(c => c.class_ids.includes(id))
              const keptCard = nextCards.some(c => c.id === card.id) ? card.id : undefined
              updateChoice({ project: project.id, grade, cls: id, card: keptCard })
            }}
          />
        </div>
      </label>
      <label className="lesson-selector-field">
        <span>科目题卡</span>
        <div className="lesson-selector-control">
          <Select
            aria-label="讲评题卡"
            showSearch
            optionFilterProp="label"
            value={card.id}
            options={cards.map(c => ({ label: `${c.subject} · ${c.name}`, value: c.id }))}
            onChange={id => updateChoice({ project: project.id, grade, cls: cls.id, card: id })}
          />
        </div>
      </label>
    </div>
  )

  return (
    <section className={`class-results lesson-shell${mobile ? ' is-mobile' : ''}`}>
      {mobile ? (
        <>
          <div className="lesson-mobile-scope-bar">
            {onBack && (
              <button type="button" className="lesson-mobile-back" aria-label="返回班级成绩" onClick={onBack}>
                <ArrowLeftOutlined />
              </button>
            )}
            <button
              type="button"
              className="lesson-mobile-scope-btn"
              aria-expanded={scopeOpen}
              onClick={() => setScopeOpen(true)}
            >
              <div className="lesson-mobile-scope-text">
                <strong>
                  {cls.name} · {card ? `${card.subject}${card.name && card.name !== 'Default' ? `（${card.name}）` : ''}` : '选择题卡'}
                </strong>
                <small>
                  {project.name} · {grades.get(grade)}
                </small>
              </div>
              <span className="lesson-mobile-scope-trigger">
                切换 <DownOutlined />
              </span>
            </button>
          </div>
          <Drawer
            title="选择讲评范围"
            placement="bottom"
            height="auto"
            open={scopeOpen}
            onClose={() => setScopeOpen(false)}
            className="lesson-mobile-drawer"
          >
            <div className="lesson-drawer-selectors">
              {selectors}
              <Button type="primary" block size="large" onClick={() => setScopeOpen(false)}>
                完成
              </Button>
            </div>
          </Drawer>
        </>
      ) : (
        <div className="lesson-header-bar">
          {onBack && (
            <Button className="lesson-back-btn" icon={<ArrowLeftOutlined />} onClick={onBack}>
              返回班级成绩
            </Button>
          )}
          {selectors}
        </div>
      )}
      {card && (
        <LessonContent
          key={`${card.id}:${cls.id}`}
          card={card}
          cls={cls}
          mobile={mobile}
          compactNav={compactNav}
          onCatalogStale={() => void catalog.reload()}
        />
      )}
    </section>
  )
}
