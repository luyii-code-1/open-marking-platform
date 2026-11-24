import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Alert, Card, Checkbox, Empty, Form, Input, InputNumber, Select, Space, Tag, Typography, Upload } from 'antd'
import { Button } from './Button'
import { newQuestion, request, requestBlob, type ExternalAnchor, type ExternalPage, type ImageBox, type Question, type Row, type Template } from './api'
import './compatible-template.css'

type Point = [number, number]
type Tool = 'anchor' | 'candidate' | 'choice' | 'subjective' | 'absent' | 'corners'
type Reference = {
  source: string; image?: string; error?: string; anchors: ExternalAnchor[]
  candidate: ImageBox[][]; choices: ImageBox[][]; frames: ImageBox[]
}
type Trial = { image: string; candidate: string | null; selections: Record<string, string[]>; absent: boolean }

const formats = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp'
const drawingTools: { value: Tool; label: string }[] = [
  { value: 'anchor', label: '定位参照' },
  { value: 'candidate', label: '考号填涂格' },
  { value: 'choice', label: '客观题' },
  { value: 'subjective', label: '主观题' },
  { value: 'absent', label: '缺考格' },
]

function enclosing(cells: ImageBox[]): ImageBox {
  const x = Math.min(...cells.map(cell => cell.x)), y = Math.min(...cells.map(cell => cell.y))
  return { x, y, width: Math.max(...cells.map(cell => cell.x + cell.width)) - x,
    height: Math.max(...cells.map(cell => cell.y + cell.height)) - y }
}

function grid(box: ImageBox, columns: number, rows: number) {
  const width = box.width / columns, height = box.height / rows
  return Array.from({ length: columns }, (_, column) => Array.from({ length: rows }, (_, row) =>
    ({ x: box.x + column * width, y: box.y + row * height, width, height })))
}

type Props = { value: Template; disabled: boolean; readOnly: boolean; change: (patch: Partial<Template>) => void
  flush: () => Promise<Template>; settings: (id: string) => void }

export function CompatibleTemplateEditor({ value, disabled, readOnly, change, flush, settings }: Props) {
  const profile = value.external_sheet!
  const [page, setPage] = useState(1), [tool, setTool] = useState<Tool>('anchor')
  const [refs, setRefs] = useState<Record<number, Reference>>({}), [savedArt, setSavedArt] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [combine, setCombine] = useState(false), [transpose, setTranspose] = useState(false), [reverse, setReverse] = useState(false)
  const [options, setOptions] = useState(4), [selected, setSelected] = useState(''), [trial, setTrial] = useState<Trial>()
  const [adjustCell, setAdjustCell] = useState(false), [cellColumn, setCellColumn] = useState(1), [cellDigit, setCellDigit] = useState(0)
  const [rawSize, setRawSize] = useState<Point>([1, 1]), [corners, setCorners] = useState<Point[]>([])
  const [drag, setDrag] = useState<ImageBox>()
  const start = useRef<Point | null>(null)
  const face = profile.pages[String(page)] ?? { anchors: [] }
  const selectedQuestion = value.questions.find(q => q.id === selected)
  const reference = refs[page]
  const correcting = tool === 'corners' && !!reference?.source
  const dimensions: Point = value.paper === 'A3' ? [420, 297] : [210, 297]
  const [width, height] = correcting ? rawSize : dimensions
  const image = correcting ? reference.source : trial?.image || reference?.image || savedArt
  const asset = value.background_assets?.[String(page)]
  const blocked = disabled || readOnly || busy
  const endpoint = `/groups/${value.group_id}/compatible`
  useEffect(() => {
    let active = true
    let url = ''
    setSavedArt('')
    if (asset) void requestBlob(`/assets/${asset}`).then(blob => {
      if (active) {
        url = URL.createObjectURL(blob)
        setSavedArt(url)
      }
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [asset])

  function setFace(next: ExternalPage) {
    change({ external_sheet: { ...profile, pages: { ...profile.pages, [page]: next } } })
    setTrial(undefined)
  }

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await work() }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  async function importFiles(files: File[], rotation = 0, points?: Point[]) {
    const body = new FormData()
    files.forEach(file => body.append('files', file))
    body.append('paper', value.paper)
    body.append('rotation', String(rotation))
    if (combine && !points) body.append('combine', 'true')
    if (points) body.append('corners', JSON.stringify(points))
    const result = await request<{ pages: Reference[] }>(endpoint + '/reference', { method: 'POST', body })
    if (result.pages.length > value.sides - page + 1) throw new Error('请先选择双面题卡，并从正面导入两页原稿')
    const next = { ...refs }, assets = { ...value.background_assets }
    for (let i = 0; i < result.pages.length; i++) {
      const sheet = result.pages[i], n = page + i
      next[n] = sheet
      if (sheet.image && profile.mode === 'blank') {
        const form = new FormData()
        form.append('file', await (await fetch(sheet.image)).blob(), 'answer-sheet.png')
        assets[n] = (await request<Row>('/assets', { method: 'POST', body: form })).id
      }
    }
    setRefs(next)
    setTrial(undefined)
    setCorners([])
    setTool(next[page]?.error ? 'corners' : 'anchor')
    if (profile.mode === 'blank') change({ background_assets: assets })
  }

  function applySuggestions(kind: 'anchors' | 'candidate' | 'choices' | 'frames') {
    if (!reference) return
    if (kind === 'anchors') setFace({ ...face, anchors: reference.anchors })
    if (kind === 'candidate') {
      change({ candidate_length: reference.candidate.length,
        external_sheet: { ...profile, pages: { ...profile.pages, '1': { ...face, candidate: reference.candidate } } } })
    }
    if (kind === 'choices' || kind === 'frames') {
      const number = Math.max(0, ...value.questions.map(q => q.number)) + 1
      const additions = kind === 'choices' ? reference.choices.map((cells, i) => ({
        ...newQuestion(number + i), type: 'single' as const, points: 1,
        options: cells.length, external_options: cells, regions: [{ page, ...enclosing(cells) }],
      })) : reference.frames.map((box, i) => ({ ...newQuestion(number + i), regions: [{ page, ...box }] }))
      change({ questions: [...value.questions, ...additions] })
    }
    setTrial(undefined)
  }

  function point(event: PointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect()
    return [Math.min(correcting ? width - 1 : width, Math.max(0, (event.clientX - rect.left) / rect.width * width)),
      Math.min(correcting ? height - 1 : height, Math.max(0, (event.clientY - rect.top) / rect.height * height))]
  }

  function rectangle(a: Point, b: Point): ImageBox {
    const round = (n: number) => Math.round(n * 100) / 100
    return { x: round(Math.min(a[0], b[0])), y: round(Math.min(a[1], b[1])),
      width: round(Math.abs(a[0] - b[0])), height: round(Math.abs(a[1] - b[1])) }
  }

  function questionUpdate(id: string, patch: Partial<Question>) {
    change({ questions: value.questions.map(q => q.id === id ? { ...q, ...patch } : q) })
    setTrial(undefined)
  }

  function finishBox(box: ImageBox) {
    if (box.width < 1 || box.height < 1) return
    if (tool === 'anchor') {
      if (face.anchors.length >= 8) { setError('每面最多八个定位参照'); return }
      void run(async () => {
        const blob = await (await fetch(image)).blob()
        const body = new FormData()
        body.append('file', blob, 'anchor.png')
        body.append('paper', value.paper)
        body.append('box', JSON.stringify(box))
        const anchor = await request<ExternalAnchor>(endpoint + '/anchor', { method: 'POST', body })
        setFace({ ...face, anchors: [...face.anchors, anchor] })
      })
    } else if (tool === 'candidate') {
      if (adjustCell && face.candidate?.[cellColumn - 1]) {
        setFace({ ...face, candidate: face.candidate.map((column, i) =>
          i === cellColumn - 1 ? column.map((cell, d) => d === cellDigit ? box : cell) : column) })
        return
      }
      const partition = transpose ? grid(box, 10, value.candidate_length) : grid(box, value.candidate_length, 10)
      const digits = transpose ? Array.from({ length: value.candidate_length }, (_, row) => partition.map(col => col[row])) : partition
      setFace({ ...face, candidate: reverse ? digits.map(cells => [...cells].reverse()) : digits })
    } else if (tool === 'absent') {
      setFace({ ...face, absent: box })
    } else {
      const current = value.questions.find(q => q.id === selected)
      if (current && (tool === 'subjective') !== (current.type === 'subjective')) {
        setError('请选取相同题型的题目，或新建一题')
        return
      }
      const region = { page, ...box }
      if (tool === 'choice' && adjustCell && current?.external_options?.[cellColumn - 1] && current.regions[0].page === page) {
        const cells = current.external_options.map((cell, i) => i === cellColumn - 1 ? box : cell)
        questionUpdate(current.id, { external_options: cells, regions: [{ page, ...enclosing(cells) }] })
        return
      }
      const cells = transpose ? grid(box, 1, options)[0] : grid(box, options, 1).flat()
      const question = current ?? newQuestion(Math.max(0, ...value.questions.map(q => q.number)) + 1)
      const next: Question = tool === 'choice'
        ? { ...question, type: current?.type === 'multiple' ? 'multiple' : 'single', options, answer: question.answer.filter(a => a < String.fromCharCode(65 + options)), external_options: cells, regions: [region] }
        : { ...question, type: 'subjective', regions: [...question.regions.filter(r => r.page !== page), region] }
      change({ questions: current ? value.questions.map(q => q.id === selected ? next : q) : [...value.questions, next] })
      setTrial(undefined)
    }
  }

  function switchPage(next: number) {
    setPage(next); setTrial(undefined); setCorners([]); setTool('anchor'); setSelected(''); setAdjustCell(false)
  }

  async function tryScan(file: Blob) {
    const saved = await flush()
    const body = new FormData()
    body.append('file', file, file instanceof File ? file.name : 'sample.jpg')
    body.append('side', page === 1 ? 'front' : 'back')
    setTrial(await request<Trial>(`/templates/${saved.id}/compatible/trial`, { method: 'POST', body }))
  }

  const marks = [
    ...face.anchors.map(box => ({ box, kind: 'anchor' })),
    ...(face.candidate ?? []).flat().map(box => ({ box, kind: 'candidate' })),
    ...(face.absent ? [{ box: face.absent, kind: 'absent' }] : []),
    ...value.questions.flatMap(q => q.regions.filter(r => r.page === page).map(box => ({ box, kind: q.id === selected ? 'selected' : 'question' }))),
    ...value.questions.filter(q => q.regions[0]?.page === page).flatMap(q => (q.external_options || []).map(box => ({ box, kind: 'choice' }))),
  ]
  return <div className="compatible-workbench">
    <Card title="兼容标定" className="compatible-controls">
      <Form layout="vertical">
        <Form.Item label="题卡名称"><Input disabled={blocked} value={value.name} onChange={e => change({ name: e.target.value })} /></Form.Item>
        <Space wrap>
          <Select aria-label="纸型" disabled={blocked || !!value.questions.length || !!Object.keys(refs).length || !!Object.keys(profile.pages).length}
            value={value.paper} onChange={paper => change({ paper })} options={[{ value: 'A4', label: 'A4 纵向' }, { value: 'A3', label: 'A3 横向' }]} />
          <Select aria-label="面数" disabled={blocked || !!Object.keys(refs).length || !!Object.keys(profile.pages).length}
            value={value.sides} onChange={sides => { change({ sides }); switchPage(1) }} options={[{ value: 1, label: '单面' }, { value: 2, label: '双面' }]} />
        </Space>
      </Form>
      {!readOnly && <>
        <Typography.Paragraph type="secondary">推荐使用空白原稿。已作答样张的印刷区域识别不完整时，可手动框选。</Typography.Paragraph>
        <Space wrap>
          <Upload accept={formats} multiple showUploadList={false} disabled={blocked}
            beforeUpload={(file, files) => { if (file.uid === files[0].uid) void run(() => importFiles(files)); return false }}>
            <Button disabled={blocked}>{profile.mode === 'blank' ? '导入空白原稿' : combine ? '导入同面样张' : '导入样张'}</Button>
          </Upload>
          {profile.mode === 'completed' && <Checkbox disabled={blocked} checked={combine} onChange={e => setCombine(e.target.checked)}>合用同面样张</Checkbox>}
        </Space>
        {reference?.source && <Space wrap className="compatible-tools">
          <Button disabled={blocked} onClick={() => { setTrial(undefined); setCorners([]); setTool('corners') }}>手动校正四角</Button>
          <Button disabled={blocked} onClick={() => void run(async () => importFiles([new File([await (await fetch(reference.source)).blob()], 'sample.jpg')], 2))}>旋转 180°</Button>
        </Space>}
        {reference?.image && <Space wrap className="compatible-tools">
          <Button disabled={blocked || !reference.anchors.length} onClick={() => applySuggestions('anchors')}>采用定位建议</Button>
          {page === 1 && <Button disabled={blocked || !reference.candidate.length} onClick={() => applySuggestions('candidate')}>采用考号建议</Button>}
          <Button disabled={blocked || !reference.choices.length} onClick={() => applySuggestions('choices')}>添加客观题建议</Button>
          <Button disabled={blocked || !reference.frames.length} onClick={() => applySuggestions('frames')}>添加主观题建议</Button>
        </Space>}
        <Space wrap className="compatible-tools">
          <Select aria-label="框选工具" value={tool === 'corners' ? undefined : tool} disabled={blocked}
            options={drawingTools.filter(item => page === 1 || !['candidate', 'absent'].includes(item.value))}
            onChange={next => { setTrial(undefined); setAdjustCell(false); setTool(next) }} placeholder="选择框选工具" />
          {tool === 'candidate' && <><InputNumber aria-label="考号位数" min={1} max={20} value={value.candidate_length} disabled={blocked}
            onChange={length => { if (length) change({ candidate_length: length }) }} />
            <Checkbox disabled={blocked} checked={reverse} onChange={e => setReverse(e.target.checked)}>反向数字顺序</Checkbox></>}
          {tool === 'choice' && <InputNumber aria-label="选项数量" min={3} max={7} value={options} disabled={blocked}
            onChange={n => setOptions(n ?? 4)} />}
          {(tool === 'candidate' || tool === 'choice') && <Checkbox disabled={blocked} checked={transpose}
            onChange={e => setTranspose(e.target.checked)}>{tool === 'candidate' ? '数字横向排列' : '选项竖向排列'}</Checkbox>}
          {((tool === 'candidate' && !!face.candidate?.length)
            || (tool === 'choice' && !!selectedQuestion?.external_options?.length)) && <>
            <Checkbox disabled={blocked} checked={adjustCell} onChange={e => { setAdjustCell(e.target.checked); setCellColumn(1) }}>调整单格</Checkbox>
            {adjustCell && <Select aria-label={tool === 'candidate' ? '考号位' : '题目选项'} value={cellColumn}
              options={Array.from({ length: tool === 'candidate' ? face.candidate!.length : selectedQuestion!.options },
                (_, i) => ({ label: tool === 'candidate' ? `第 ${i + 1} 位` : String.fromCharCode(65 + i), value: i + 1 }))}
              onChange={setCellColumn} />}
            {adjustCell && tool === 'candidate' && <Select aria-label="数字" value={cellDigit}
              options={Array.from({ length: 10 }, (_, value) => ({ value, label: `数字 ${value}` }))} onChange={setCellDigit} />}
          </>}
          {tool === 'anchor' && face.anchors.length > 0 && <Button disabled={blocked}
            onClick={() => setFace({ ...face, anchors: face.anchors.slice(0, -1) })}>移除最后一个参照</Button>}
          {tool === 'absent' && face.absent && <Button disabled={blocked} onClick={() => setFace({ ...face, absent: undefined })}>清除缺考格</Button>}
        </Space>
        {correcting && <Space wrap className="compatible-tools">
          <Typography.Text>依次点击左上、右上、右下、左下纸角 {corners.length}/4</Typography.Text>
          <Button disabled={blocked || corners.length !== 4} onClick={() => void run(async () => importFiles([new File([await (await fetch(reference.source)).blob()], 'sample.jpg')], 0, corners))}>应用校正</Button>
          <Button disabled={blocked} onClick={() => setCorners([])}>重选四角</Button>
        </Space>}
      </>}
      <div className="compatible-tools">
        <Tag>定位参照 {face.anchors.length}</Tag>
        {page === 1 && <Tag>考号 {face.candidate?.length || 0} 位</Tag>}
        <Tag>本面 {value.questions.filter(q => q.regions.some(r => r.page === page)).length} 题</Tag>
      </div>
      <div className="compatible-questions">
        {value.questions.filter(q => q.regions.some(r => r.page === page)).map(q => <div key={q.id} className="compatible-question">
          <Button type={selected === q.id ? 'primary' : 'default'} onClick={() => {
            setSelected(selected === q.id ? '' : q.id); setTool(q.type === 'subjective' ? 'subjective' : 'choice'); setOptions(q.options); setAdjustCell(false)
          }}>第 {q.number} 题</Button>
          <InputNumber aria-label={`第 ${q.number} 题题号`} disabled={blocked} min={1} value={q.number}
            onChange={number => { if (number && !value.questions.some(other => other.id !== q.id && other.number === number)) questionUpdate(q.id, { number }) }} />
          <InputNumber aria-label={`第 ${q.number} 题分值`} disabled={blocked} value={q.points} min={.01} precision={2}
            onChange={points => { if (points) questionUpdate(q.id, { points }) }} />
          <Button disabled={blocked} onClick={() => settings(q.id)}>设置</Button>
          <Button disabled={blocked} danger onClick={() => { change({ questions: value.questions.filter(other => other.id !== q.id) }); setTrial(undefined) }}>删除</Button>
        </div>)}
      </div>
      {!readOnly && <Space wrap className="compatible-tools">
        <Upload accept={formats} showUploadList={false} disabled={blocked}
          beforeUpload={file => { void run(() => tryScan(file)); return false }}><Button disabled={blocked}>上传本面试扫件</Button></Upload>
        {!!reference?.source && <Button disabled={blocked} onClick={() => void run(async () => tryScan(await (await fetch(reference.source)).blob()))}>使用当前样张试扫</Button>}
      </Space>}
    </Card>
    <Card title="原版面" extra={<Select aria-label="纸面" value={page} disabled={busy} onChange={switchPage}
      options={[{ value: 1, label: '正面' }, ...(value.sides === 2 ? [{ value: 2, label: '背面' }] : [])]} />}>
      {(error || reference?.error) && <Alert className="compatible-tools" showIcon type="warning" message={error || reference?.error} />}
      {trial && <Alert className="compatible-tools" showIcon type="success" message="请核对本面试扫结果"
        description={<div>{page === 1 && <div>考号 {trial.candidate || '未识读'}{trial.absent ? ' · 缺考' : ''}</div>}
          {Object.entries(trial.selections).map(([id, choices]) => <Tag key={id}>第 {value.questions.find(q => q.id === id)?.number} 题 {choices.join('') || '空白'}</Tag>)}</div>}
        action={<Button onClick={() => setTrial(undefined)}>返回标定</Button>} />}
      {image ? <div className="compatible-canvas" style={{ aspectRatio: `${width}/${height}` }}>
        <img src={image} alt={correcting ? '待校正原图' : '当前纸面'} draggable={false}
          onLoad={event => { if (correcting) setRawSize([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight]) }} />
        <svg role="img" aria-label="题卡标定区域" viewBox={`0 0 ${width} ${height}`} className={blocked || trial ? '' : 'compatible-draw'}
          onPointerDown={event => {
            if (blocked || trial) return
            if (correcting) { if (corners.length < 4) setCorners([...corners, point(event)]); return }
            start.current = point(event); event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={event => { if (start.current) setDrag(rectangle(start.current, point(event))) }}
          onPointerCancel={() => { setDrag(undefined); start.current = null }}
          onPointerUp={event => {
            if (!start.current) return
            const box = rectangle(start.current, point(event))
            start.current = null; setDrag(undefined)
            finishBox(box)
          }}>
          {correcting ? corners.map(([cx, cy], index) => <g key={index}><circle cx={cx} cy={cy} r={Math.max(width, height) / 120} />
            <text x={cx + 10} y={cy} fontSize={Math.max(width, height) / 50}>{index + 1}</text></g>) :
            marks.map(({ box, kind }, i) => <rect key={i} {...box} className={`compatible-mark-${kind}`} />)}
          {drag && <rect {...drag} className="compatible-mark-selected" />}
        </svg>
      </div> : <Empty description={readOnly ? '已保存题区与扫描定位配置' : '导入该面的空白原稿或扫描样张'} />}
    </Card>
  </div>
}
