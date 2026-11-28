import { Tag, Typography } from 'antd'

const { Text } = Typography

export type Difficulty = 'difficult' | 'hard' | 'medium' | 'easy'

export type Question = {
  id: string
  number: string
  type: string
  points: number
  average: number | null
  count: number
  scored_count?: number
  score_rate?: number | null
  raw_score_rate?: number | null
  difficulty?: Difficulty | null
  grade_average?: number | null
  grade_score_rate?: number | null
  rate_diff?: number | null
  incomparable_count?: number
  bands?: { lower: number; upper: number; inclusive: boolean; count: number }[]
  answer?: string[]
  options?: Record<string, string[]>
  correct?: number
  graded?: number
  correct_rate?: number | null
}

type Averages = Record<string, number | undefined>

export type Comparison = {
  grade_wide: boolean
  averages: Averages
  score_rates?: Record<string, number | null | undefined>
  classes: { name: string; averages: Averages }[]
}

export const difficultyMeta: Record<Difficulty, { label: string; color: string }> = {
  difficult: { label: '困难', color: 'red' },
  hard: { label: '较难', color: 'orange' },
  medium: { label: '一般', color: 'blue' },
  easy: { label: '较易', color: 'green' },
}

export function DifficultyTag({ difficulty }: { difficulty?: Difficulty | null }) {
  if (!difficulty) return <Tag style={{ marginInlineEnd: 0 }}>暂无统计</Tag>
  const meta = difficultyMeta[difficulty]
  return meta ? (
    <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
      {meta.label}
    </Tag>
  ) : null
}

const order = (a: string, b: string) => a.localeCompare(b, 'zh-CN', { numeric: true })
const format = (value: number | null | undefined) => (value == null ? '—' : String(value))

function DiffValue({ diff }: { diff?: number | null }) {
  if (diff == null) return <strong className="lesson-diff-neutral">—</strong>
  if (diff === 0) return <strong className="lesson-diff-neutral">持平</strong>
  return (
    <strong className={diff > 0 ? 'lesson-diff-up' : 'lesson-diff-down'}>
      {diff > 0 ? `+${diff}` : String(diff)} 百分点
    </strong>
  )
}

export function QuestionResult({
  q,
  gradeWide = true,
  hideAnswer = false,
  showDistribution = true,
}: {
  q: Question
  gradeWide?: boolean
  hideAnswer?: boolean
  showDistribution?: boolean
}) {
  const peerLabel = gradeWide ? '年级' : '可见班级'
  const scoredCount = q.scored_count ?? q.count

  const kpiStrip = (
    <div className="lesson-kpi-grid">
      <div className="lesson-kpi-card">
        <span>本班得分率</span>
        <strong className="lesson-kpi-primary">{q.score_rate != null ? `${q.score_rate}%` : '暂无统计'}</strong>
        <small>{scoredCount ? `有效评分 ${scoredCount} 人` : '暂无有效样本'}</small>
      </div>
      <div className="lesson-kpi-card">
        <span>本班均分</span>
        <strong>
          {format(q.average)}
          {q.average != null ? ` / ${q.points}` : ''}
        </strong>
        <small>满分 {q.points} 分</small>
      </div>
      <div className="lesson-kpi-card">
        <span>{peerLabel}均分</span>
        <strong>{format(q.grade_average)}</strong>
        <small>{q.grade_score_rate != null ? `${peerLabel}得分率 ${q.grade_score_rate}%` : '暂无对比均值'}</small>
      </div>
      <div className="lesson-kpi-card">
        <span>较{peerLabel}</span>
        <DiffValue diff={q.rate_diff} />
        <small>{q.rate_diff != null ? '按得分率比较' : '任一侧无样本'}</small>
      </div>
      {q.type !== 'subjective' && !hideAnswer && (
        <div className="lesson-kpi-card">
          <span>完全正确率</span>
          <strong>{q.correct_rate == null ? '—' : `${q.correct_rate}%`}</strong>
          <small>
            完全答对 {q.correct ?? 0} / {q.graded ?? 0} 人
          </small>
        </div>
      )}
    </div>
  )

  const incomparableNote =
    q.incomparable_count && q.incomparable_count > 0 ? (
      <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
        注：有 {q.incomparable_count} 份历史版式分值与当前不一致的答卷，已从得分率及均分计算中排除。
      </Text>
    ) : null

  if (q.type === 'subjective') {
    const bandMax = Math.max(1, ...(q.bands?.map(b => b.count) || [0]))
    return (
      <div className="lesson-result-block">
        {kpiStrip}
        {!showDistribution ? (
          <div className="lesson-hidden-note">当前已隐藏得分区间分布，点击上方「显示作答分布」查看。</div>
        ) : !q.count ? (
          <div className="lesson-hidden-note">暂无已评分样本。未评分与缺考/未扫描答卷不计入分布或零分。</div>
        ) : (
          <div className="lesson-bands-wrap">
            <table className="lesson-bands">
              <thead>
                <tr>
                  <th>得分区间</th>
                  <th>分布</th>
                  <th>人数</th>
                  <th>占比</th>
                </tr>
              </thead>
              <tbody>
                {q.bands?.map(b => {
                  const ratio = q.count ? (100 * b.count) / q.count : 0
                  return (
                    <tr key={b.lower}>
                      <td>
                        {b.lower} ≤ 得分 {b.inclusive ? '≤' : '<'} {b.upper}
                      </td>
                      <td className="lesson-band-bar-cell">
                        <div className="lesson-opt-track">
                          <div className="lesson-opt-fill is-neutral" style={{ width: `${(100 * b.count) / bandMax}%` }} />
                        </div>
                      </td>
                      <td>{b.count} 人</td>
                      <td>{q.count ? `${ratio.toFixed(1)}%` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {incomparableNote}
      </div>
    )
  }

  return (
    <div className="lesson-result-block">
      {kpiStrip}
      <div className="lesson-answer-bar">
        {hideAnswer ? (
          <Tag style={{ marginInlineEnd: 0 }}>课堂模式 · 标准答案已隐藏</Tag>
        ) : (
          <span>
            标准答案：
            {q.answer?.length ? (
              q.answer.map(letter => (
                <Tag key={letter} color="green" style={{ marginInlineStart: 4, marginInlineEnd: 0 }}>
                  {letter}
                </Tag>
              ))
            ) : (
              <Tag style={{ marginInlineStart: 4, marginInlineEnd: 0 }}>待录入</Tag>
            )}
          </span>
        )}
        <Text type="secondary">有效实考 {q.count} 人（含留空）</Text>
      </div>

      {!showDistribution ? (
        <div className="lesson-hidden-note">当前已隐藏选项人数分布，点击上方「显示作答分布」查看。</div>
      ) : (
        <div className="lesson-options">
          {Object.entries(q.options || {}).map(([option, names]) => {
            const isAnswer = !hideAnswer && !!q.answer?.includes(option)
            const pct = q.count ? Math.min(100, (100 * names.length) / q.count) : 0
            const fillClass = hideAnswer
              ? 'is-neutral'
              : isAnswer
                ? 'is-correct'
                : option === 'blank'
                  ? 'is-blank'
                  : 'is-distractor'
            return (
              <details key={option}>
                <summary>
                  <div className="lesson-opt-row">
                    <span className="lesson-opt-name">
                      <b>{option === 'blank' ? '留空' : option}</b>
                      {isAnswer && (
                        <Tag color="green" style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px', paddingInline: 5 }}>
                          正解
                        </Tag>
                      )}
                    </span>
                    <div className="lesson-opt-track">
                      <div className={`lesson-opt-fill ${fillClass}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="lesson-opt-count">{names.length} 人</span>
                    <span className="lesson-opt-pct">{q.count ? `${pct.toFixed(1)}%` : '—'}</span>
                  </div>
                </summary>
                <div>{names.length ? [...names].sort(order).join('、') : '无人选择'}</div>
              </details>
            )
          })}
        </div>
      )}

      <small className="lesson-footnote">
        留空计入有效实考人数；缺考与未扫描不计入。
        {q.type === 'multiple' ? ' 多选按全部选项一致计为完全答对，选择多个选项的学生会分别列入各对应选项名单。' : ''}
      </small>
      {incomparableNote}
    </div>
  )
}

export function ClassChart({
  comparison,
  metric,
  maximum,
  activeClassName,
}: {
  comparison: Comparison
  metric: string
  maximum: number
  activeClassName?: string
}) {
  const avg = comparison.averages[metric]
  const gradeRate = comparison.score_rates?.[metric]
  const rows = [...comparison.classes].sort((a, b) => order(a.name, b.name))
  const ceiling = Math.max(1, maximum, ...rows.map(r => r.averages[metric] ?? 0))
  const height = (n: number) => `${Math.max(0, Math.min(100, (n * 100) / ceiling))}%`
  return (
    <section className="lesson-chart" aria-label="同题卡班级均分对比">
      <p className="lesson-metric">
        {comparison.grade_wide ? '年级均分' : '可见班级均分'} <strong>{format(avg)}</strong> 分
        {gradeRate != null && <span>得分率 {gradeRate}%</span>}
        <span>按有有效得分的学生人数加权（满分 {maximum} 分）</span>
      </p>
      <div className="lesson-chart-scroll" tabIndex={0} aria-label="各班均分，横向滚动">
        <div className="lesson-plot" style={{ minWidth: Math.max(240, rows.length * 82) }}>
          {avg != null && <div className="lesson-mean-line" style={{ bottom: height(avg) }} />}
          {rows.map((row, index) => {
            const v = row.averages[metric]
            const isCurrent = !!activeClassName && row.name === activeClassName
            return (
              <div
                className={`lesson-chart-column${isCurrent ? ' is-current' : ''}`}
                key={index}
                aria-label={`${row.name}，${v == null ? '暂无成绩' : `${v} 分`}`}
              >
                <div className={`lesson-bar${isCurrent ? ' is-current' : ''}`} style={{ height: v == null ? 0 : height(v) }}>
                  <b>{format(v)}</b>
                </div>
                <div className="lesson-bar-label" title={row.name}>
                  {row.name}
                  {isCurrent ? '（本班）' : ''}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
