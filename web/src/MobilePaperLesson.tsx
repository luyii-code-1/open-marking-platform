import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  CapsuleTabs,
  Collapse,
  Empty,
  ErrorBlock,
  List,
  NavBar,
  NoticeBar,
  Popup,
  ProgressBar,
  SearchBar,
  Selector,
  Space,
  SpinLoading,
  Tag,
} from 'antd-mobile'
import { EyeInvisibleOutlined, EyeOutlined, LeftOutlined, RightOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { ClassChart, difficultyMeta, type Comparison, type Difficulty, type Question } from './LessonStatistics'
import type { LessonScope } from './PaperLesson'
import { useResource, type Row } from './api'

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
const format = (value: number | null | undefined) => (value == null ? '—' : String(value))

function AdmDifficultyTag({ difficulty }: { difficulty?: Difficulty | null }) {
  if (!difficulty) return <Tag fill="outline">暂无统计</Tag>
  const meta = difficultyMeta[difficulty]
  if (!meta) return null
  const color = difficulty === 'difficult' ? 'danger' : difficulty === 'hard' ? 'warning' : difficulty === 'easy' ? 'success' : 'primary'
  return <Tag color={color}>{meta.label}</Tag>
}

function MobileLessonContent({
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
  const [navOpen, setNavOpen] = useState(false)
  const [metricOpen, setMetricOpen] = useState(false)

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
      <ErrorBlock status="default" title="讲评数据加载失败" description={data.error}>
        <Space wrap>
          <Button size="small" onClick={() => void data.reload()}>重试</Button>
          <Button size="small" color="primary" onClick={onCatalogStale}>刷新可讲评范围</Button>
        </Space>
      </ErrorBlock>
    )
  }
  if (!data.data || stale) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 36 }}>
        <SpinLoading color="primary" />
      </div>
    )
  }
  if (!orderedQuestions.length) return <Empty description="题卡暂无评分项" />

  const current = orderedQuestions.find(q => q.id === activeId) || orderedQuestions[0]
  const pos = Math.max(0, orderedQuestions.findIndex(q => q.id === current.id))
  const { comparison, full_score } = data.data
  const peerLabel = comparison.grade_wide ? '年级' : '可见班级'
  const scoredCount = current.scored_count ?? current.count
  const hideAnswer = classroom && !revealed
  const visibleDist = classroom ? showDist : true

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

  const metricLabel = metric === 'total'
    ? '整卷原始总分'
    : `第 ${orderedQuestions.find(q => q.id === metric)?.number ?? ''} 题`

  return (
    <>
      <List mode="card">
        <List.Item
          title={
            <div className="m-adm-tag-row">
              <strong style={{ fontSize: 17 }}>第 {current.number} 题</strong>
              <Tag fill="outline">{current.type === 'subjective' ? '主观题' : current.type === 'multiple' ? '多选题' : '单选题'}</Tag>
              <Tag fill="outline">满分 {current.points} 分</Tag>
              <AdmDifficultyTag difficulty={current.difficulty} />
            </div>
          }
          description={
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <Button size="small" fill="outline" onClick={() => setNavOpen(true)}>
                <UnorderedListOutlined /> 全卷题单 {pos + 1}/{orderedQuestions.length}{sort === 'weak' ? ' · 低分' : ''}
              </Button>
              <Button
                size="small"
                color={classroom ? 'primary' : 'default'}
                fill={classroom ? 'solid' : 'outline'}
                onClick={toggleClassroom}
              >
                {classroom ? <EyeInvisibleOutlined /> : <EyeOutlined />} {classroom ? '退出课堂讲解' : '课堂讲解'}
              </Button>
            </div>
          }
        />
      </List>

      {classroom ? (
        <NoticeBar
          color="info"
          wrap
          content="课堂讲解模式：答案默认隐藏，换题或切班自动复位。"
          extra={
            <Space style={{ '--gap': '6px' }}>
              <Button size="mini" color="primary" onClick={() => setRevealed(v => !v)}>
                {revealed ? '收起答案' : '揭示答案'}
              </Button>
              <Button size="mini" fill="outline" onClick={() => setShowDist(v => !v)}>
                {showDist ? '隐藏分布' : '显示分布'}
              </Button>
            </Space>
          }
        />
      ) : (
        <CapsuleTabs activeKey={tab} onChange={key => setTab(key as 'questions' | 'compare')}>
          <CapsuleTabs.Tab title="本班作答" key="questions" />
          <CapsuleTabs.Tab title="跨班均分" key="compare" />
        </CapsuleTabs>
      )}

      {classroom || tab === 'questions' ? (
        <>
          <div className="m-adm-kpi-grid">
            <div className="m-adm-kpi-card">
              <span>本班得分率</span>
              <strong style={{ color: 'var(--adm-color-primary)' }}>
                {current.score_rate != null ? `${current.score_rate}%` : '暂无统计'}
              </strong>
              <small>{scoredCount ? `有效评分 ${scoredCount} 人` : '暂无有效样本'}</small>
            </div>
            <div className="m-adm-kpi-card">
              <span>本班均分</span>
              <strong>{format(current.average)}{current.average != null ? ` / ${current.points}` : ''}</strong>
              <small>满分 {current.points} 分</small>
            </div>
            <div className="m-adm-kpi-card">
              <span>{peerLabel}均分</span>
              <strong>{format(current.grade_average)}</strong>
              <small>{current.grade_score_rate != null ? `${peerLabel}得分率 ${current.grade_score_rate}%` : '暂无对比均值'}</small>
            </div>
            <div className="m-adm-kpi-card">
              <span>较{peerLabel}</span>
              <strong
                style={{
                  color: current.rate_diff == null || current.rate_diff === 0
                    ? undefined
                    : current.rate_diff > 0
                      ? 'var(--adm-color-success)'
                      : 'var(--adm-color-danger)',
                }}
              >
                {current.rate_diff == null ? '—' : current.rate_diff === 0 ? '持平' : `${current.rate_diff > 0 ? '+' : ''}${current.rate_diff} 百分点`}
              </strong>
              <small>{current.rate_diff != null ? '按得分率比较' : '任一侧无样本'}</small>
            </div>
            {current.type !== 'subjective' && !hideAnswer && (
              <div className="m-adm-kpi-card">
                <span>完全正确率</span>
                <strong>{current.correct_rate == null ? '—' : `${current.correct_rate}%`}</strong>
                <small>完全答对 {current.correct ?? 0} / {current.graded ?? 0} 人</small>
              </div>
            )}
          </div>

          {current.type === 'subjective' ? (
            !visibleDist ? (
              <NoticeBar color="default" content="当前已隐藏得分区间分布，点击上方「显示分布」查看。" />
            ) : !current.count ? (
              <Empty description="暂无已评分样本（缺考与未扫描不计入分布或零分）" />
            ) : (
              <List mode="card" header="本班得分区间分布">
                {(current.bands || []).map(b => {
                  const ratio = current.count ? (100 * b.count) / current.count : 0
                  return (
                    <List.Item
                      key={b.lower}
                      title={`${b.lower} ≤ 得分 ${b.inclusive ? '≤' : '<'} ${b.upper}`}
                      extra={<strong>{b.count} 人（{ratio.toFixed(1)}%）</strong>}
                      description={<ProgressBar percent={Math.round(ratio)} style={{ marginTop: 6 }} />}
                    />
                  )
                })}
              </List>
            )
          ) : (
            <>
              <List mode="card">
                <List.Item
                  title={
                    hideAnswer ? (
                      <Tag fill="outline">课堂模式 · 标准答案已隐藏</Tag>
                    ) : (
                      <div className="m-adm-tag-row">
                        <span>标准答案：</span>
                        {current.answer?.length
                          ? current.answer.map(letter => <Tag key={letter} color="success">{letter}</Tag>)
                          : <Tag fill="outline">待录入</Tag>}
                      </div>
                    )
                  }
                  extra={<span style={{ fontSize: 12, color: 'var(--adm-color-text-secondary)' }}>实考 {current.count} 人</span>}
                />
              </List>

              {!visibleDist ? (
                <NoticeBar color="default" content="当前已隐藏选项人数分布，点击上方「显示分布」查看。" />
              ) : (
                <List mode="card" header="选项分布与学生点名（点击展开名单）">
                  <Collapse>
                    {Object.entries(current.options || {}).map(([option, names]) => {
                      const isAnswer = !hideAnswer && !!current.answer?.includes(option)
                      const pct = current.count ? Math.min(100, (100 * names.length) / current.count) : 0
                      return (
                        <Collapse.Panel
                          key={option}
                          title={
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <span className="m-adm-tag-row">
                                  <strong>{option === 'blank' ? '留空' : option}</strong>
                                  {isAnswer && <Tag color="success">正解</Tag>}
                                </span>
                                <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                                  {names.length} 人 · {current.count ? `${pct.toFixed(1)}%` : '—'}
                                </span>
                              </div>
                              <ProgressBar
                                percent={Math.round(pct)}
                                style={{
                                  '--fill-color': hideAnswer
                                    ? 'var(--adm-color-primary)'
                                    : isAnswer
                                      ? 'var(--adm-color-success)'
                                      : option === 'blank'
                                        ? 'var(--adm-color-weak)'
                                        : 'var(--adm-color-warning)',
                                }}
                              />
                            </div>
                          }
                        >
                          <div style={{ lineHeight: 1.75, fontSize: 14, color: 'var(--adm-color-text)' }}>
                            {names.length ? [...names].sort(order).join('、') : '无人选择'}
                          </div>
                        </Collapse.Panel>
                      )
                    })}
                  </Collapse>
                </List>
              )}
              <div style={{ fontSize: 12, color: 'var(--adm-color-text-secondary)', paddingInline: 4 }}>
                留空计入有效实考人数；缺考与未扫描不计入。
                {current.type === 'multiple' ? '多选按全部选项一致计为完全答对，多选学生会分别列入各对应选项名单。' : ''}
              </div>
            </>
          )}

          {!!current.incomparable_count && current.incomparable_count > 0 && (
            <NoticeBar
              color="default"
              wrap
              content={`注：有 ${current.incomparable_count} 份历史版式分值与当前不一致的答卷，已从得分率及均分计算中排除。`}
            />
          )}
        </>
      ) : (
        <>
          <List mode="card">
            <List.Item
              title="对比指标"
              extra={metricLabel}
              arrow
              onClick={() => setMetricOpen(true)}
            />
            {metric !== current.id && (
              <List.Item
                title={`快速切换至第 ${current.number} 题均分对比`}
                arrow
                onClick={() => setMetric(current.id)}
              />
            )}
          </List>
          <div style={{ background: 'var(--adm-color-background)', border: '1px solid var(--adm-color-border)', borderRadius: 12, padding: 12 }}>
            <ClassChart
              comparison={comparison}
              metric={metric}
              maximum={questions.find(v => v.id === metric)?.points ?? full_score}
              activeClassName={cls.name}
            />
          </div>
        </>
      )}

      <footer className="m-adm-lesson-footer">
        <Button size="middle" disabled={pos <= 0} onClick={() => selectQuestion(orderedQuestions[pos - 1].id)}>
          <LeftOutlined /> 上一题
        </Button>
        <Button size="small" fill="none" onClick={() => setNavOpen(true)}>
          {pos + 1} / {orderedQuestions.length}{sort === 'weak' ? ' · 低分' : ''}
        </Button>
        <Button size="middle" disabled={pos >= orderedQuestions.length - 1} onClick={() => selectQuestion(orderedQuestions[pos + 1].id)}>
          下一题 <RightOutlined />
        </Button>
      </footer>

      <Popup
        visible={navOpen}
        onMaskClick={() => setNavOpen(false)}
        position="bottom"
        bodyStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, height: '78dvh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="m-adm-popup-head">
          <strong>全卷题目（{orderedQuestions.length} 项）</strong>
          <Button size="mini" fill="none" onClick={() => setNavOpen(false)}>关闭</Button>
        </div>
        <div className="m-adm-popup-body" style={{ flex: 1 }}>
          <CapsuleTabs activeKey={sort} onChange={next => { setSort(next as SortMode); setActiveId(current.id) }}>
            <CapsuleTabs.Tab title="原卷顺序" key="paper" />
            <CapsuleTabs.Tab title="低得分率优先" key="weak" />
          </CapsuleTabs>
          <SearchBar placeholder="按题号定位" value={searchTerm} onChange={setSearchTerm} />
          <List>
            {filteredNav.map(q => (
              <List.Item
                key={q.id}
                onClick={() => selectQuestion(q.id)}
                title={
                  <div className="m-adm-tag-row">
                    <strong style={{ color: q.id === current.id ? 'var(--adm-color-primary)' : undefined }}>第 {q.number} 题</strong>
                    <Tag fill="outline">{q.type === 'subjective' ? '主观' : q.type === 'multiple' ? '多选' : '单选'}</Tag>
                    <AdmDifficultyTag difficulty={q.difficulty} />
                  </div>
                }
                extra={<strong>{q.score_rate != null ? `${q.score_rate}%` : '—'}</strong>}
                arrow
              />
            ))}
            {!filteredNav.length && <Empty description="无匹配题号" />}
          </List>
          <div style={{ fontSize: 12, color: 'var(--adm-color-text-secondary)' }}>
            百分比为本班单题得分率（困难 &lt;60%、较难 &lt;70%、一般 &lt;85%）
          </div>
        </div>
      </Popup>

      <Popup
        visible={metricOpen}
        onMaskClick={() => setMetricOpen(false)}
        position="bottom"
        bodyStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '72dvh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="m-adm-popup-head">
          <strong>选择对比指标</strong>
          <Button size="mini" fill="none" onClick={() => setMetricOpen(false)}>关闭</Button>
        </div>
        <div className="m-adm-popup-body">
          <List>
            <List.Item
              title="整卷原始总分"
              extra={metric === 'total' ? <Tag color="primary">当前</Tag> : null}
              onClick={() => { setMetric('total'); setMetricOpen(false) }}
            />
            {orderedQuestions.map(q => (
              <List.Item
                key={q.id}
                title={`第 ${q.number} 题（满分 ${q.points} 分）`}
                extra={metric === q.id ? <Tag color="primary">当前</Tag> : null}
                onClick={() => { setMetric(q.id); setMetricOpen(false) }}
              />
            ))}
          </List>
        </div>
      </Popup>
    </>
  )
}

export default function MobilePaperLesson({
  initial,
  onBack,
  onScopeChange,
  onOpenResults,
  backLabel = '返回',
}: {
  initial: LessonScope
  onBack?: () => void
  onScopeChange?: (scope: LessonScope) => void
  onOpenResults?: () => void
  backLabel?: string
}) {
  const catalog = useResource<{ projects: Row[] }>('/analysis/class-catalog', { projects: [] })
  const [choice, setChoice] = useState(initial)
  const [scopeOpen, setScopeOpen] = useState(false)

  useEffect(() => {
    setChoice(initial)
  }, [initial.project, initial.grade, initial.cls, initial.card])

  function updateChoice(next: LessonScope) {
    setChoice(next)
    onScopeChange?.(next)
  }

  const navBar = (
    <div className="m-adm-header-sticky">
      <NavBar
        back={onBack ? backLabel : null}
        onBack={onBack}
        right={onOpenResults ? <Button size="mini" fill="outline" onClick={onOpenResults}>班级成绩</Button> : null}
      >
        试卷讲评
      </NavBar>
    </div>
  )

  if (catalog.error) {
    return (
      <>
        {navBar}
        <main className="m-adm-body">
          <ErrorBlock status="default" title="讲评目录加载失败" description={catalog.error}>
            <Button size="small" color="primary" onClick={() => void catalog.reload()}>重试</Button>
          </ErrorBlock>
        </main>
      </>
    )
  }

  if (!catalog.loaded) {
    return (
      <>
        {navBar}
        <main className="m-adm-body" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <SpinLoading color="primary" />
        </main>
      </>
    )
  }

  const projects = (catalog.data.projects || []).filter(p => {
    const classIds = new Set((p.classes || []).map((c: Row) => c.id))
    return (p.cards || []).some((c: Row) => c.published && Array.isArray(c.class_ids) && c.class_ids.some((id: string) => classIds.has(id)))
  })

  if (!projects.length) {
    return (
      <>
        {navBar}
        <main className="m-adm-body">
          <Empty description="暂无可讲评的已发布题卡" />
          <Space justify="center" block>
            <Button size="small" onClick={() => void catalog.reload()}>刷新目录</Button>
            {onBack && <Button size="small" color="primary" onClick={onBack}>{backLabel}</Button>}
          </Space>
        </main>
      </>
    )
  }

  const matchedProject = choice.project ? projects.find(p => p.id === choice.project) : projects[0]
  if (!matchedProject) {
    return (
      <>
        {navBar}
        <main className="m-adm-body">
          <Empty description="当前考试暂无你可讲评的已发布题卡" />
          <Space justify="center" wrap block>
            <Button size="small" color="primary" onClick={() => updateChoice({})}>查看可讲评目录</Button>
            <Button size="small" onClick={() => void catalog.reload()}>刷新范围</Button>
            {onBack && <Button size="small" onClick={onBack}>{backLabel}</Button>}
          </Space>
        </main>
      </>
    )
  }

  const project = matchedProject
  const allClassIds = new Set((project.classes || []).map((c: Row) => c.id))
  const published: Row[] = (project.cards || []).filter(
    (c: Row) => c.published && Array.isArray(c.class_ids) && c.class_ids.some((id: string) => allClassIds.has(id)),
  )
  const classes: Row[] = (project.classes || []).filter((c: Row) => published.some(card => card.class_ids.includes(c.id)))
  const grades = new Map(classes.map(c => [gradeKey(c), gradeLabel(c)]))
  if (choice.grade && !grades.has(choice.grade)) {
    return (
      <>
        {navBar}
        <main className="m-adm-body">
          <Empty description="当前年级暂无你可讲评的已发布题卡" />
          <Space justify="center" wrap block>
            <Button size="small" color="primary" onClick={() => updateChoice({ project: project.id })}>查看本场可讲评目录</Button>
            <Button size="small" onClick={() => updateChoice({})}>查看全部可讲评目录</Button>
          </Space>
        </main>
      </>
    )
  }

  const requested = choice.cls ? classes.find(c => c.id === choice.cls) : undefined
  if (choice.cls && (!requested || (choice.grade && gradeKey(requested) !== choice.grade))) {
    return (
      <>
        {navBar}
        <main className="m-adm-body">
          <Empty description="当前班级暂无你可讲评的已发布题卡" />
          <Space justify="center" wrap block>
            <Button size="small" color="primary" onClick={() => updateChoice({ project: project.id })}>查看本场可讲评班级</Button>
            <Button size="small" onClick={() => updateChoice({})}>查看全部可讲评目录</Button>
          </Space>
        </main>
      </>
    )
  }

  const grade = choice.grade && grades.has(choice.grade) ? choice.grade : gradeKey(requested || classes[0])
  const gradeClasses = classes.filter(c => gradeKey(c) === grade).sort((a, b) => order(a.name, b.name))
  const cls = (choice.cls ? gradeClasses.find(c => c.id === choice.cls) : undefined) || gradeClasses[0]
  const cards = cls ? published.filter(c => c.class_ids.includes(cls.id)) : []
  const card = choice.card ? cards.find(c => c.id === choice.card) : cards[0]
  if (!cls || !card) {
    return (
      <>
        {navBar}
        <main className="m-adm-body">
          <Empty description="当前题卡未发布或不在你的讲评授权范围内" />
          <Space justify="center" wrap block>
            {cls && <Button size="small" color="primary" onClick={() => updateChoice({ project: project.id, grade, cls: cls.id })}>查看该班可讲评题卡</Button>}
            <Button size="small" onClick={() => updateChoice({})}>查看全部可讲评目录</Button>
          </Space>
        </main>
      </>
    )
  }

  return (
    <>
      {navBar}
      <main className="m-adm-body">
        <List mode="card">
          <List.Item
            title={`${cls.name} · ${card.subject}${card.name && card.name !== 'Default' ? `（${card.name}）` : ''}`}
            description={`${project.name} · ${grades.get(grade)}`}
            extra={<Tag color="primary" fill="outline">切换范围</Tag>}
            arrow
            onClick={() => setScopeOpen(true)}
          />
        </List>

        <MobileLessonContent key={`${card.id}:${cls.id}`} card={card} cls={cls} onCatalogStale={() => void catalog.reload()} />

        <Popup
          visible={scopeOpen}
          onMaskClick={() => setScopeOpen(false)}
          position="bottom"
          bodyStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '82dvh', display: 'flex', flexDirection: 'column' }}
        >
          <div className="m-adm-popup-head">
            <strong>选择讲评范围</strong>
            <Button size="mini" color="primary" onClick={() => setScopeOpen(false)}>完成</Button>
          </div>
          <div className="m-adm-popup-body">
            <div>
              <div style={{ fontSize: 13, color: 'var(--adm-color-text-secondary)', marginBottom: 6 }}>讲评考试</div>
              <Selector
                aria-label="讲评考试"
                columns={1}
                value={[project.id]}
                options={projects.map(p => ({ label: p.name, value: p.id }))}
                onChange={arr => arr[0] && updateChoice({ project: arr[0] })}
              />
            </div>
            <div>
              <div style={{ fontSize: 13, color: 'var(--adm-color-text-secondary)', marginBottom: 6 }}>讲评年级标签</div>
              <Selector
                aria-label="讲评年级标签"
                columns={3}
                value={[grade]}
                options={[...grades].map(([value, label]) => ({ label, value }))}
                onChange={arr => arr[0] && updateChoice({ project: project.id, grade: arr[0] })}
              />
            </div>
            <div>
              <div style={{ fontSize: 13, color: 'var(--adm-color-text-secondary)', marginBottom: 6 }}>讲评班级</div>
              <Selector
                aria-label="讲评班级"
                columns={3}
                value={[cls.id]}
                options={gradeClasses.map(c => ({ label: c.name, value: c.id }))}
                onChange={arr => {
                  const id = arr[0]
                  if (!id) return
                  const nextCards = published.filter(c => c.class_ids.includes(id))
                  const keptCard = nextCards.some(c => c.id === card.id) ? card.id : undefined
                  updateChoice({ project: project.id, grade, cls: id, card: keptCard })
                }}
              />
            </div>
            <div>
              <div style={{ fontSize: 13, color: 'var(--adm-color-text-secondary)', marginBottom: 6 }}>讲评题卡</div>
              <Selector
                aria-label="讲评题卡"
                columns={2}
                value={[card.id]}
                options={cards.map(c => ({ label: `${c.subject} · ${c.name}`, value: c.id }))}
                onChange={arr => arr[0] && updateChoice({ project: project.id, grade, cls: cls.id, card: arr[0] })}
              />
            </div>
          </div>
        </Popup>
      </main>
    </>
  )
}
