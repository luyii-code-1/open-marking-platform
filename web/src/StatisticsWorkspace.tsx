import { useState } from 'react'
import { Alert, App, Card, Empty, Input, InputNumber, Popconfirm, Progress, Select, Space, Spin, Statistic, Tabs, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, DownloadOutlined, PlusOutlined } from '@ant-design/icons'
import { Button } from './Button'
import { Table } from './DataTable'
import { ErrorNotice } from './EntityTable'
import { announceChanges, download, send, useResource, type Row } from './api'
import { useUnsavedChanges } from './useNavigation'
import { Scans } from './Management'

type Question = { type: 'single' | 'multiple'; options: number; title: string }
type CardState = {
  group_id: string
  template: { id: string; revision: number; sides: number; questions: Question[] } | null
  draft: Question[] | null
  draft_version: number
  locked: boolean
  closed: boolean
  scans_purged: boolean
}
type ResultRow = { number: number; title: string; type: Question['type']; counts: Record<string, number>; blank: number; invalid: number }
type Results = { total: number; rows: ResultRow[] }

const defaultQuestion: Question = { type: 'single', options: 4, title: '' }

export function StatisticsWorkspace({ project, back }: { project: Row; back: () => void }) {
  const endpoint = `/projects/${project.id}/statistics`
  const data = useResource<CardState | null>(endpoint, null)
  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Space wrap><Button icon={<ArrowLeftOutlined />} onClick={back}>返回项目</Button>
      <Typography.Title level={4} style={{ margin: 0 }}>{project.name}</Typography.Title><Tag>统计</Tag></Space>
    <ErrorNotice error={data.error} retry={data.reload} />
    {data.data ? <StatisticsCard key={project.id} endpoint={endpoint} name={project.name} initial={data.data} refresh={data.reload} /> : !data.error && <Spin />}
  </Space>
}

function StatisticsCard({ endpoint, name, initial, refresh }: { endpoint: string; name: string; initial: CardState; refresh: () => Promise<unknown> }) {
  const [card, setCard] = useState(initial)
  const makeRows = (state: CardState): (Question & { key: string })[] => (state.draft ?? state.template?.questions ?? [defaultQuestion])
    .map(question => ({ ...question, key: crypto.randomUUID() }))
  const [questions, setQuestions] = useState(() => makeRows(initial))
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false)
  const [section, setSection] = useState('design')
  const { message } = App.useApp()
  useUnsavedChanges(dirty)

  function change(next: typeof questions) {
    setQuestions(next)
    setDirty(true)
  }

  async function save(publish: boolean) {
    setBusy(true)
    try {
      const saved = await send<CardState>(endpoint, {
        questions: questions.map(({ type, options, title }) => ({ type, options, title })),
        draft_version: card.draft_version, publish,
      }, 'PUT')
      setCard(saved)
      setDirty(false)
      announceChanges(['groups', 'templates', 'projects'])
      message.success(publish ? '统计题卡已发布' : '统计草稿已保存')
    } catch (error) { message.error((error as Error).message) }
    finally { setBusy(false) }
  }

  const scanLocked = initial.locked || card.locked
  const activeTemplate = initial.locked ? initial.template : card.template
  const draft = scanLocked ? null : card.draft
  const visibleQuestions = scanLocked
    ? activeTemplate?.questions.map((q, i) => ({ ...q, key: 'published-' + i })) ?? []
    : questions
  const locked = scanLocked || busy
  const design = <Card title="统计题卡" extra={<Space wrap>
    {activeTemplate && <Tag color="green">第 {activeTemplate.revision} 版 · {activeTemplate.sides === 2 ? '双面' : '单面'}</Tag>}
    {draft && <Tag>草稿</Tag>}
    {!scanLocked && <Button disabled={!questions.length} loading={busy} onClick={() => save(false)}>保存草稿</Button>}
    <Button icon={<DownloadOutlined />} disabled={(!scanLocked && dirty) || (!draft && !activeTemplate)} onClick={() =>
      download(draft ? endpoint + '/preview' : `/templates/${activeTemplate!.id}/pdf`, `${name}.pdf`).catch(error => message.error(error.message))}>{draft ? '下载草稿预览' : '下载打印题卡'}</Button>
    {!scanLocked && <Popconfirm title={card.template ? '发布新版统计题卡？' : '发布统计题卡？'}
      description="正式扫描开始后锁定题目配置。" onConfirm={() => save(true)}>
      <Button type="primary" disabled={!questions.length || !!card.template && !card.draft && !dirty} loading={busy}>发布题卡</Button>
    </Popconfirm>}
  </Space>}>
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {scanLocked && <Alert type="info" showIcon message="扫描已开始，题卡已锁定。" />}
      <Typography.Text type="secondary">A4 题卡自动排版。每题可设 2–26 个选项，超过 13 个时自动换行。</Typography.Text>
      <Table rowKey="key" dataSource={visibleQuestions} pagination={false} columnChooser={false} exportable={false}
        columns={[
          { title: '题号', render: (_, _row, index) => index + 1, width: 70 },
          { title: '题目说明', render: (_, row) => <Input aria-label="题目说明" maxLength={64} disabled={locked}
            placeholder="选填" value={row.title} onChange={event => change(questions.map(q =>
              q.key === row.key ? { ...q, title: event.target.value } : q))} /> },
          { title: '题型', width: 116, render: (_, row) => <Select aria-label="题型" value={row.type} disabled={locked}
            options={[{ value: 'single', label: '单选' }, { value: 'multiple', label: '多选' }]}
            onChange={type => change(questions.map(q => q.key === row.key ? { ...q, type } : q))} /> },
          { title: '选项数', width: 165, render: (_, row) => <Space>
            <InputNumber aria-label="选项数" value={row.options} disabled={locked} min={2} max={26} precision={0}
              onChange={options => { if (options) change(questions.map(q => q.key === row.key ? { ...q, options } : q)) }} />
            <Typography.Text type="secondary">A–{String.fromCharCode(64 + row.options)}</Typography.Text>
          </Space> },
          ...(!scanLocked ? [{ title: '操作', width: 84, render: (_: unknown, row: typeof questions[number]) =>
            <Button type="link" danger disabled={busy} onClick={() => change(questions.filter(q => q.key !== row.key))}>删除</Button> }] : []),
        ]} />
      {!scanLocked && <Button icon={<PlusOutlined />} disabled={busy || questions.length >= 32}
        onClick={() => change([...questions, { ...defaultQuestion, key: crypto.randomUUID() }])}>添加题目</Button>}
    </Space>
  </Card>
  return <Tabs activeKey={section} onChange={setSection} items={[
    { key: 'design', label: '题卡', children: design },
    { key: 'scans', label: '扫描与导入', children: activeTemplate ? <Scans groupId={card.group_id} /> :
      <Card><Empty description="发布统计题卡后即可创建扫描批次" /></Card> },
    { key: 'statistics', label: '统计结果', destroyOnHidden: true, children: <StatisticsResults
      endpoint={endpoint} name={name} closed={initial.closed} canChange={!initial.scans_purged} onCollectionChange={refresh} /> },
  ]} />
}

function StatisticsResults({ endpoint, name, closed, canChange, onCollectionChange }: {
  endpoint: string; name: string; closed: boolean; canChange: boolean; onCollectionChange: () => Promise<unknown>
}) {
  const data = useResource<Results>(endpoint + '/results', { total: 0, rows: [] })
  const [number, setNumber] = useState<number>()
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()
  const result = data.data.rows.find(row => row.number === number) ?? data.data.rows[0]
  const ratio = (count: number) => data.data.total ? Math.round(count * 1000 / data.data.total) / 10 : 0
  async function changeCollection() {
    setBusy(true)
    try {
      const result = await send<{ closed: boolean }>(endpoint + '/collection', { closed: !closed }, 'PUT')
      await onCollectionChange()
      announceChanges(['groups', 'projects'])
      message.success(result.closed ? '已结束收集' : '已恢复收集')
    } catch (error) { message.error((error as Error).message) }
    finally { setBusy(false) }
  }
  return <Card title="统计结果" extra={<Space wrap>
    {closed && <Tag color="green">收集已结束</Tag>}
    {canChange && (closed || data.data.total > 0) && <Popconfirm title={closed ? '恢复接收统计答卷？' : '结束收集并锁定结果？'}
      onConfirm={changeCollection}><Button loading={busy}>{closed ? '恢复收集' : '结束收集'}</Button></Popconfirm>}
    <Button onClick={() => void data.reload()}>刷新</Button>
    <Button icon={<DownloadOutlined />} disabled={!result} onClick={() => download(endpoint + '/export', `${name} 选项统计.xlsx`).catch(error => message.error(error.message))}>导出 Excel</Button>
  </Space>}>
    <ErrorNotice error={data.error} retry={data.reload} />
    {!result ? <Empty description="发布题卡后可查看逐题统计" /> : <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Select aria-label="查看题目" value={result.number} onChange={setNumber} style={{ minWidth: 200 }}
        options={data.data.rows.map(row => ({ value: row.number, label: `第 ${row.number} 题 ${row.title}`.trim() }))} />
      <Space wrap size={32}>
        <Statistic title="确认入库" value={data.data.total} suffix="份" />
        <Statistic title="空白" value={result.blank} suffix="份" />
        <Statistic title="无效" value={result.invalid} suffix="份" />
      </Space>
      <Typography.Text type="secondary">占比按确认入库份数计算。{result.type === 'single' ? '单选多填计入无效。' : '多选时每个已选选项分别计数。'}</Typography.Text>
      <Table rowKey="option" dataSource={Object.entries(result.counts).map(([option, count]) => ({ option, count }))}
        loading={data.loading} pagination={false} columnChooser={false} exportable={false}
        columns={[
          { title: '选项', dataIndex: 'option', width: 90 },
          { title: '选择份数', dataIndex: 'count', width: 110 },
          { title: '占比', render: (_, row) => <Progress percent={ratio(row.count)} /> },
        ]} />
    </Space>}
  </Card>
}
