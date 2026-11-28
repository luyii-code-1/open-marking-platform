import { useState } from 'react'
import {
  Button,
  CapsuleTabs,
  Empty,
  ErrorBlock,
  Input,
  List,
  NavBar,
  NoticeBar,
  Popup,
  SearchBar,
  Selector,
  Space,
  SpinLoading,
  Stepper,
  Tag,
} from 'antd-mobile'
import { DesktopOutlined, ReadOutlined } from '@ant-design/icons'
import { useResource, type Row } from './api'
import { cardName, classResultsPath } from './examNavigation'
import MobilePaperLesson from './MobilePaperLesson'
import { MobileResultExport } from './MobileResultExport'
import type { LessonScope } from './PaperLesson'
import { resultState } from './resultFilterParams'
import type { useNavigation } from './useNavigation'

type ClassNavigation = Pick<ReturnType<typeof useNavigation>, 'location' | 'navigate'>
type CardReportTab = 'items' | 'averages' | 'questions' | 'ranks' | 'bands' | 'scores'

const CARD_REPORT_TABS: [CardReportTab, string][] = [
  ['items', '小题分'],
  ['averages', '小题均分对比'],
  ['questions', '试题分析'],
  ['ranks', '名次段'],
  ['bands', '分数段'],
  ['scores', '成绩与名次'],
]

const display = (value: unknown) => (value == null ? '—' : String(value))
const gradeKey = (cls: Row) => (cls.grade_id ? `id:${cls.grade_id}` : `legacy:${cls.grade || ''}`)
const cardTitle = (card: Row) => {
  const label = cardName(card, { id: card.subject, name: card.subject })
  if (!card.subject) return label
  return label === card.subject || label === card.subject + '题卡' ? card.subject : `${card.subject} · ${label}`
}

function flattenColumns(cols: Row[], prefix = ''): { key: string; title: string }[] {
  const out: { key: string; title: string }[] = []
  for (const col of cols || []) {
    const label = prefix ? `${prefix}·${col.title}` : String(col.title || col.key || '')
    if (Array.isArray(col.children) && col.children.length) {
      out.push(...flattenColumns(col.children, label))
    } else if (col.key) {
      out.push({ key: String(col.key), title: label })
    }
  }
  return out
}

function MobileClassSummary({
  project,
  cls,
  cards,
}: {
  project: Row
  cls: Row
  cards: Row[]
}) {
  const [studentSearch, setStudentSearch] = useState('')
  const query = new URLSearchParams({
    project_id: project.id,
    class_ids: cls.id,
    group_ids: cards.map(c => c.id).join(','),
  })
  const summary = useResource<any>(cards.length ? '/analysis/project/class-summary?' + query : null, null)

  if (summary.error) {
    return (
      <ErrorBlock status="default" title="班级总表加载失败" description={summary.error}>
        <Button size="small" color="primary" onClick={() => void summary.reload()}>重试</Button>
      </ErrorBlock>
    )
  }

  const cols: Row[] = (summary.data?.columns || []).filter((col: Row) => cards.some(c => c.id === col.id))
  const term = studentSearch.trim().toLocaleLowerCase()
  const students: Row[] = [...(summary.data?.students || [])]
    .sort((a, b) => (a.class_rank ?? Infinity) - (b.class_rank ?? Infinity))
    .filter(s => !term || `${s.name || ''} ${s.candidate_number || ''}`.toLocaleLowerCase().includes(term))

  return (
    <>
      <List mode="card">
        <List.Item
          title="班级成绩总表"
          extra={
            <MobileResultExport
              scope={{ kind: 'project', id: project.id, query, cardCount: cards.length }}
              parts={[project.name, cls.grade, cls.name]}
              disabled={!summary.data || !!summary.error}
              initialReport="class-summary"
              quickReport="class-summary"
            />
          }
        />
      </List>
      {summary.data?.warnings?.length > 0 && (
        <NoticeBar color="alert" wrap content="同一学生同科有多张题卡，切换上方单科可核对各题卡成绩。" />
      )}
      {summary.loading && !summary.data ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 28 }}>
          <SpinLoading color="primary" />
        </div>
      ) : (
        <>
          <SearchBar placeholder="按姓名或准考证号查找学生" value={studentSearch} onChange={setStudentSearch} />
          {!students.length ? (
            <Empty description={term ? '没有匹配的学生记录' : '暂无学生成绩'} />
          ) : (
            <List mode="card" header={`班级成绩总表（${students.length} 人）`}>
              {students.map(stu => (
                <List.Item
                  key={stu.student_id}
                  title={
                    <div className="m-adm-tag-row">
                      <strong>{stu.name}</strong>
                      <Tag color="primary" fill="outline">第 {display(stu.class_rank)} 名</Tag>
                      <Tag fill="outline">{cls.all_subjects ? '总分' : '任教合计'} {display(stu.total)}</Tag>
                    </div>
                  }
                  description={
                    <div className="m-adm-student-card">
                      <span>准考证号：{stu.candidate_number || '—'} · 状态：{resultState[stu.status] || stu.status || '—'}</span>
                      <div className="m-adm-score-chips">
                        {cols.map(col => {
                          const val = stu.scores?.[col.id]
                          const text = val?.status === 'completed'
                            ? (col.conversion_enabled ? `${display(val.raw)} / 赋${display(val.converted)}` : display(val.raw))
                            : (resultState[val?.status] || '—')
                          return <span key={col.id} className="m-adm-score-chip">{col.subject}：{text}</span>
                        })}
                      </div>
                    </div>
                  }
                />
              ))}
            </List>
          )}
        </>
      )}
    </>
  )
}

function MobileClassCardReport({
  project,
  card,
  cls,
}: {
  project: Row
  card: Row
  cls: Row
}) {
  const [tab, setTab] = useState<CardReportTab>('items')
  const [step, setStep] = useState<number>(10)
  const [limits, setLimits] = useState('10,30,50,100,200')
  const [applied, setApplied] = useState({ step: 10, limits: '10,30,50,100,200' })
  const [search, setSearch] = useState('')

  const query = new URLSearchParams({
    group_id: card.id,
    class_ids: cls.id,
    score_step: String(applied.step),
    ranks: applied.limits,
  })
  const formal = useResource<any>('/analysis/reports?' + query, null)
  const scores = useResource<any>(
    tab === 'scores' ? '/analysis/group?' + new URLSearchParams({ group_id: card.id, class_ids: cls.id }) : null,
    null,
  )
  const activeRes = tab === 'scores' ? scores : formal
  const total = formal.data?.summary
  const report = tab === 'scores' ? null : formal.data?.reports?.[tab]
  const flatCols = flattenColumns(report?.columns || [])
  const rawRows: Row[] = activeRes.error ? [] : tab === 'scores' ? (scores.data?.students || []) : (report?.rows || [])
  const term = search.trim().toLocaleLowerCase()
  const rows = tab === 'scores'
    ? [...rawRows]
      .sort((a, b) => (a.class_rank ?? Infinity) - (b.class_rank ?? Infinity))
      .filter(s => !term || `${s.name || ''} ${s.candidate_number || ''}`.toLocaleLowerCase().includes(term))
    : rawRows.filter(r => !term || Object.values(r).some(v => String(v ?? '').toLocaleLowerCase().includes(term)))

  return (
    <>
      <List mode="card">
        <List.Item
          title={cardTitle(card)}
          description={
            total
              ? `应考 ${total.records} · 已结分 ${total.completed} · 待结分 ${total.pending} · 缺考 ${total.absent} · 未扫描 ${total.unscanned}`
              : '单科成绩报表'
          }
          extra={
            <MobileResultExport
              scope={{ kind: 'card', id: card.id, query, studentCount: total?.records || 0 }}
              quickReport={tab === 'scores' ? 'ranking' : tab}
              initialReport={tab === 'scores' ? 'ranking' : tab}
              parts={[project.name, cls.grade, cls.name, card.subject]}
              disabled={!activeRes.data || !!activeRes.error}
            />
          }
        />
      </List>

      <CapsuleTabs activeKey={tab} onChange={key => setTab(key as CardReportTab)}>
        {CARD_REPORT_TABS.map(([key, label]) => (
          <CapsuleTabs.Tab key={key} title={label} />
        ))}
      </CapsuleTabs>

      {(tab === 'bands' || tab === 'ranks') && (
        <List mode="card" header="报表参数">
          {tab === 'bands' ? (
            <List.Item
              title="每段分数"
              extra={<Stepper min={0.5} step={1} value={step} onChange={v => setStep(v || 10)} />}
            />
          ) : (
            <List.Item title="累计名次">
              <Input value={limits} onChange={setLimits} placeholder="10,30,50,100,200" />
            </List.Item>
          )}
          <List.Item>
            <Button
              block
              size="small"
              color="primary"
              onClick={() => setApplied(prev => (tab === 'bands' ? { ...prev, step } : { ...prev, limits }))}
            >
              应用参数
            </Button>
          </List.Item>
        </List>
      )}

      {activeRes.error ? (
        <ErrorBlock status="default" title="单科报表加载失败" description={activeRes.error}>
          <Button size="small" color="primary" onClick={() => void activeRes.reload()}>重试</Button>
        </ErrorBlock>
      ) : activeRes.loading && !activeRes.data ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 28 }}>
          <SpinLoading color="primary" />
        </div>
      ) : (
        <>
          <SearchBar placeholder={tab === 'scores' ? '按姓名或准考证号查找' : '筛选当前报表内容'} value={search} onChange={setSearch} />
          {!rows.length ? (
            <Empty description={term ? '没有匹配的记录' : '当前报表暂无数据'} />
          ) : tab === 'scores' ? (
            <List mode="card" header={`成绩与名次（${rows.length} 人）`}>
              {rows.map(stu => (
                <List.Item
                  key={stu.student_id || stu.candidate_number}
                  title={
                    <div className="m-adm-tag-row">
                      <strong>{stu.name}</strong>
                      <Tag color="primary" fill="outline">班内第 {display(stu.class_rank)} 名</Tag>
                      {stu.scope_rank != null && <Tag fill="outline">范围第 {display(stu.scope_rank)} 名</Tag>}
                    </div>
                  }
                  description={
                    <div className="m-adm-student-card">
                      <span>准考证号：{stu.candidate_number || '—'} · 状态：{resultState[stu.status] || stu.status || '—'}</span>
                      <div className="m-adm-score-chips">
                        <span className="m-adm-score-chip">原始分：{stu.status === 'completed' ? display(stu.total) : '—'}</span>
                        {card.conversion_enabled && <span className="m-adm-score-chip">赋分：{display(stu.converted_score)}</span>}
                      </div>
                    </div>
                  }
                />
              ))}
            </List>
          ) : (
            <List mode="card" header={`${CARD_REPORT_TABS.find(([k]) => k === tab)?.[1] || '报表'}（${rows.length} 条）`}>
              {rows.map((row, idx) => {
                const primaryCol = flatCols[0]
                const restCols = flatCols.slice(1)
                return (
                  <List.Item
                    key={String(row.student_id || row.candidate_number || row.question || row.band || row.class || row.number || idx)}
                    title={primaryCol ? `${primaryCol.title}：${display(row[primaryCol.key])}` : `第 ${idx + 1} 行`}
                    description={
                      <div className="m-adm-score-chips" style={{ marginTop: 4 }}>
                        {restCols.map(col => (
                          <span key={col.key} className="m-adm-score-chip">
                            {col.title}：{display(row[col.key])}
                          </span>
                        ))}
                      </div>
                    }
                  />
                )
              })}
            </List>
          )}
        </>
      )}
    </>
  )
}

export default function MobileClassResults({
  location,
  navigate,
  onSwitchDesktop,
}: ClassNavigation & { onSwitchDesktop: () => void }) {
  const scope = location.lessonScope ?? {}
  const lessonCard = location.lessonCard
  const [examOpen, setExamOpen] = useState(false)
  const [classSearch, setClassSearch] = useState('')
  const catalog = useResource<{ projects: Row[] }>('/analysis/class-catalog', { projects: [] })

  function show(next: LessonScope, card?: string, replace = false) {
    navigate(classResultsPath(next, card), replace)
  }

  if (lessonCard) {
    return (
      <MobilePaperLesson
        initial={{ ...scope, card: lessonCard }}
        backLabel="返回班级成绩"
        onBack={() => show(scope, undefined, true)}
      />
    )
  }

  const projects = catalog.data.projects || []
  const project = scope.project ? projects.find(p => p.id === scope.project) : projects[0]
  const classes: Row[] = project?.classes || []
  const cls = scope.cls ? classes.find(c => c.id === scope.cls) : undefined
  const gradeMismatch = !!scope.grade && !!cls && gradeKey(cls) !== scope.grade
  const invalidProject = !!scope.project && !project
  const invalidClass = !!scope.cls && (!cls || gradeMismatch)
  const cards: Row[] = cls && !invalidClass ? (project?.cards || []).filter((c: Row) => c.class_ids.includes(cls.id)) : []
  const card = scope.card && !invalidClass ? cards.find(c => c.id === scope.card) : undefined
  const invalidCard = !!scope.card && !card
  const publishedCard = !invalidCard && !invalidClass ? (card?.published ? card : cards.find(c => c.published)) : undefined

  const navBack = cls
    ? () => show({ project: project?.id, cls: card ? cls.id : undefined }, undefined, true)
    : undefined

  return (
    <>
      <div className="m-adm-header-sticky">
        <NavBar
          back={navBack ? (card ? '总表' : '班级') : null}
          onBack={navBack}
          right={
            <div className="m-adm-nav-right">
              {cls && project && publishedCard && (
                <Button
                  size="mini"
                  color="primary"
                  onClick={() => show({ ...scope, project: project.id, cls: cls.id }, publishedCard.id)}
                >
                  <ReadOutlined /> 讲评
                </Button>
              )}
              <button type="button" className="m-adm-nav-btn" onClick={onSwitchDesktop} aria-label="切换桌面版">
                <DesktopOutlined />
              </button>
            </div>
          }
        >
          {cls ? `${cls.name}${card ? ` · ${card.subject}` : ''}` : '班级成绩'}
        </NavBar>
      </div>

      <main className="m-adm-body">
        {catalog.error ? (
          <ErrorBlock status="default" title="成绩目录加载失败" description={catalog.error}>
            <Button size="small" color="primary" onClick={() => void catalog.reload()}>重试</Button>
          </ErrorBlock>
        ) : !catalog.loaded ? (
          <div style={{ display: 'grid', placeItems: 'center', padding: 36 }}>
            <SpinLoading color="primary" />
          </div>
        ) : invalidProject ? (
          <>
            <Empty description="当前考试不在你的任教成绩查看范围内" />
            <Button block color="primary" onClick={() => show({}, undefined, true)}>重新选择考试</Button>
          </>
        ) : !project ? (
          <Empty description="暂无已发布的任教班级成绩" />
        ) : invalidClass ? (
          <>
            <Empty description="当前年级与班级范围不匹配或无权限查看" />
            <Button block color="primary" onClick={() => show({ project: project.id }, undefined, true)}>重新选择班级</Button>
          </>
        ) : (
          <>
            <List mode="card">
              <List.Item
                title={project.name}
                description={cls ? `${cls.grade || '未设置年级'} · ${cls.name}` : `共 ${classes.length} 个班级`}
                extra={<Tag color="primary" fill="outline">切换考试</Tag>}
                arrow
                onClick={() => setExamOpen(true)}
              />
            </List>

            {!cls ? (
              <>
                <SearchBar placeholder="搜索年级或班级" value={classSearch} onChange={setClassSearch} />
                {(() => {
                  const term = classSearch.trim().toLocaleLowerCase()
                  const grouped = new Map<string, Row[]>()
                  for (const item of classes) {
                    const g = String(item.grade || '未设置年级')
                    if (term && !(g + item.name).toLocaleLowerCase().includes(term)) continue
                    if (!grouped.has(g)) grouped.set(g, [])
                    grouped.get(g)!.push(item)
                  }
                  if (!grouped.size) return <Empty description={term ? '没有匹配的班级' : '此范围暂无可查看的班级'} />
                  return [...grouped].map(([gradeName, rows]) => (
                    <List key={gradeName} mode="card" header={gradeName}>
                      {rows
                        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true }))
                        .map(c => (
                          <List.Item key={c.id} title={c.name} arrow onClick={() => show({ project: project.id, cls: c.id })} />
                        ))}
                    </List>
                  ))
                })()}
              </>
            ) : invalidCard ? (
              <>
                <Empty description="当前指定的题卡不存在或不在该班可查看范围内" />
                <Space justify="center" wrap block>
                  <Button size="small" color="primary" onClick={() => show({ project: project.id, cls: cls.id }, undefined, true)}>查看本班总表</Button>
                  <Button size="small" onClick={() => show({ project: project.id }, undefined, true)}>重新选择班级</Button>
                </Space>
              </>
            ) : (
              <>
                {cards.length > 0 && (
                  <List mode="card" header="总表 / 单科切换">
                    <List.Item>
                      <Selector
                        columns={2}
                        value={card ? [card.id] : ['__all__']}
                        options={[
                          { label: '班级总表', value: '__all__' },
                          ...cards.map(c => ({ label: `${cardTitle(c)}${c.published ? '' : '（未发布）'}`, value: c.id })),
                        ]}
                        onChange={arr => {
                          const v = arr[0]
                          if (!v) return
                          show({ project: project.id, cls: cls.id, card: v === '__all__' ? undefined : v }, undefined, true)
                        }}
                      />
                    </List.Item>
                  </List>
                )}

                {card ? (
                  <MobileClassCardReport key={`${card.id}:${cls.id}`} project={project} card={card} cls={cls} />
                ) : (
                  <MobileClassSummary key={`${project.id}:${cls.id}`} project={project} cls={cls} cards={cards} />
                )}
              </>
            )}
          </>
        )}

        <Popup
          visible={examOpen}
          onMaskClick={() => setExamOpen(false)}
          position="bottom"
          bodyStyle={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '72dvh', display: 'flex', flexDirection: 'column' }}
        >
          <div className="m-adm-popup-head">
            <strong>选择考试项目</strong>
            <Button size="mini" fill="none" onClick={() => setExamOpen(false)}>关闭</Button>
          </div>
          <div className="m-adm-popup-body">
            <List>
              {projects.map(p => (
                <List.Item
                  key={p.id}
                  title={p.name}
                  extra={project?.id === p.id ? <Tag color="primary">当前</Tag> : null}
                  onClick={() => { show({ project: p.id }); setExamOpen(false) }}
                />
              ))}
            </List>
          </div>
        </Popup>
      </main>
    </>
  )
}
