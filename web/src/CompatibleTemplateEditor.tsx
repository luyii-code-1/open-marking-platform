import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons'
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

function overlaps(a: ImageBox, b: ImageBox) {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const area = ix * iy
  return area > 0 && area / Math.min(a.width * a.height, b.width * b.height) > 0.3
}

type Props = { value: Template; disabled: boolean; readOnly: boolean; change: (patch: Partial<Template>) => void
  flush: () => Promise<Template>; settings: (id: string) => void }

export function CompatibleTemplateEditor({ value, disabled, readOnly, change, flush, settings }: Props) {
  const profile = value.external_sheet!
  const [page, setPage] = useState(1), [tool, setTool] = useState<Tool>('anchor'), [lastDrawTool, setLastDrawTool] = useState<Exclude<Tool, 'corners'>>('anchor')
  const [refs, setRefs] = useState<Record<number, Reference>>({}), [savedArt, setSavedArt] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [combine, setCombine] = useState(false), [transpose, setTranspose] = useState(false), [reverse, setReverse] = useState(false)
  const [options, setOptions] = useState(4), [choiceBatchCount, setChoiceBatchCount] = useState(1), [appendRegion, setAppendRegion] = useState(false)
  const [selected, setSelected] = useState(''), [trial, setTrial] = useState<Trial>()
  const [adjustCell, setAdjustCell] = useState(false), [cellColumn, setCellColumn] = useState(1), [cellDigit, setCellDigit] = useState(0)
  const [rawSize, setRawSize] = useState<Point>([1, 1]), [corners, setCorners] = useState<Point[]>([])
  const [zoom, setZoom] = useState(100)
  const [drag, setDrag] = useState<ImageBox>()
  const start = useRef<Point | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const face = profile.pages[String(page)] ?? { anchors: [] }
  const selectedQuestion = value.questions.find(q => q.id === selected)
  const reference = refs[page]
  const correcting = tool === 'corners' && !!(reference?.source || savedArt)
  const dimensions: Point = value.paper === 'A3' ? [420, 297] : [210, 297]
  const [width, height] = correcting ? rawSize : dimensions
  const correctingSource = reference?.source || savedArt
  const image = correcting ? correctingSource : trial?.image || reference?.image || savedArt
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

  useEffect(() => {
    if (correcting && imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      setRawSize([imgRef.current.naturalWidth, imgRef.current.naturalHeight])
    }
  }, [correcting, correctingSource])

  function chooseTool(next: Exclude<Tool, 'corners'>) {
    setTrial(undefined)
    setAdjustCell(false)
    setTool(next)
    setLastDrawTool(next)
  }

  function setFace(next: ExternalPage) {
    change({ external_sheet: { ...profile, pages: { ...profile.pages, [page]: next } } })
    setTrial(undefined)
  }

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try { await work() }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  async function saveBlankAsset(imageUrl: string, targetPage: number, currentAssets?: Record<string, string>) {
    if (profile.mode !== 'blank') return currentAssets
    const form = new FormData()
    form.append('file', await (await fetch(imageUrl)).blob(), 'answer-sheet.png')
    const uploaded = await request<Row>('/assets', { method: 'POST', body: form })
    return { ...(currentAssets ?? value.background_assets), [String(targetPage)]: uploaded.id }
  }

  async function importFiles(files: File[], rotation = 0, points?: Point[], opts?: { alreadyCorrected?: boolean; preserveSource?: string; targetTool?: Exclude<Tool, 'corners'> }) {
    const body = new FormData()
    files.forEach(file => body.append('files', file))
    body.append('paper', value.paper)
    body.append('rotation', String(rotation))
    if (opts?.alreadyCorrected) body.append('already_corrected', 'true')
    if (combine && !points && !opts?.alreadyCorrected) body.append('combine', 'true')
    if (points) body.append('corners', JSON.stringify(points))
    const result = await request<{ pages: Reference[] }>(endpoint + '/reference', { method: 'POST', body })
    if (result.pages.length > value.sides - page + 1) throw new Error('请先选择双面题卡，并从正面导入两页原稿')
    const next = { ...refs }
    let assets = { ...value.background_assets }
    for (let i = 0; i < result.pages.length; i++) {
      const sheet = result.pages[i], n = page + i
      next[n] = opts?.preserveSource && i === 0 ? { ...sheet, source: opts.preserveSource } : sheet
      if (sheet.image && profile.mode === 'blank') {
        assets = (await saveBlankAsset(sheet.image, n, assets)) || assets
      }
    }
    setRefs(next)
    setTrial(undefined)
    setCorners([])
    setTool(next[page]?.error ? 'corners' : (opts?.targetTool ?? lastDrawTool))
    if (profile.mode === 'blank') change({ background_assets: assets })
  }

  async function adoptCorrectedImage(sourceImage: string, successText: string) {
    const blob = await (await fetch(sourceImage)).blob()
    const file = new File([blob], 'corrected.png', { type: blob.type || 'image/png' })
    await importFiles([file], 0, undefined, {
      alreadyCorrected: true,
      preserveSource: reference?.source || sourceImage,
      targetTool: lastDrawTool,
    })
    setNotice(successText)
  }

  async function autoCorrectCurrent() {
    const sourceUrl = reference?.source || savedArt
    if (!sourceUrl) return
    const blob = await (await fetch(sourceUrl)).blob()
    await importFiles([new File([blob], 'sample.jpg', { type: blob.type || 'image/jpeg' })], 0, undefined, {
      targetTool: lastDrawTool,
    })
    setNotice('已应用自动校正，可继续在校正图上框选或微调区域')
  }

  async function reextractAnchorsFromCurrent() {
    if (!image || !face.anchors.length) return
    const blob = await (await fetch(image)).blob()
    const body = new FormData()
    body.append('file', blob, 'page.png')
    body.append('paper', value.paper)
    body.append('boxes', JSON.stringify(face.anchors.map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }))))
    const result = await request<{ anchors: ExternalAnchor[] }>(endpoint + '/reextract-anchors', { method: 'POST', body })
    setFace({ ...face, anchors: result.anchors })
    setNotice('已按当前校正图重新采样所有定位参照')
  }

  function applySuggestions(kind: 'anchors' | 'candidate' | 'choices' | 'frames') {
    if (!reference) return
    if (kind === 'anchors') setFace({ ...face, anchors: reference.anchors })
    if (kind === 'candidate') {
      const page1 = profile.pages['1'] ?? { anchors: [] }
      change({ candidate_length: reference.candidate.length,
        external_sheet: { ...profile, pages: { ...profile.pages, '1': { ...page1, candidate: reference.candidate } } } })
    }
    if (kind === 'choices' || kind === 'frames') {
      const existingOnPage = value.questions.flatMap(q => q.regions.filter(r => r.page === page))
      const number = Math.max(0, ...value.questions.map(q => q.number)) + 1
      const filtered = kind === 'choices'
        ? reference.choices.filter(cells => { const box = enclosing(cells); return !existingOnPage.some(r => overlaps(r, box)) })
        : reference.frames.filter(box => !existingOnPage.some(r => overlaps(r, box)))
      if (!filtered.length) {
        setNotice('建议区域已全部添加或与现有题目重叠')
        return
      }
      const additions = kind === 'choices' ? (filtered as ImageBox[][]).map((cells, i) => ({
        ...newQuestion(number + i), type: 'single' as const, points: 1,
        options: cells.length, external_options: cells, regions: [{ page, ...enclosing(cells) }],
      })) : (filtered as ImageBox[]).map((box, i) => ({ ...newQuestion(number + i), regions: [{ page, ...box }] }))
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
        setError('请选取相同题型的题目，或取消选中后新建题目')
        return
      }
      if (tool === 'choice' && adjustCell && current?.external_options?.[cellColumn - 1] && current.regions[0].page === page) {
        const cells = current.external_options.map((cell, i) => i === cellColumn - 1 ? box : cell)
        questionUpdate(current.id, { external_options: cells, regions: [{ page, ...enclosing(cells) }] })
        return
      }
      if (tool === 'choice' && !current && choiceBatchCount > 1) {
        const startNum = Math.max(0, ...value.questions.map(q => q.number)) + 1
        const additions: Question[] = []
        if (transpose) {
          const cols = grid(box, choiceBatchCount, options)
          for (let i = 0; i < choiceBatchCount; i++) {
            const cells = cols[i]
            additions.push({ ...newQuestion(startNum + i), type: 'single', points: 1, options, answer: [], external_options: cells, regions: [{ page, ...enclosing(cells) }] })
          }
        } else {
          const cols = grid(box, options, choiceBatchCount)
          for (let i = 0; i < choiceBatchCount; i++) {
            const cells = cols.map(col => col[i])
            additions.push({ ...newQuestion(startNum + i), type: 'single', points: 1, options, answer: [], external_options: cells, regions: [{ page, ...enclosing(cells) }] })
          }
        }
        change({ questions: [...value.questions, ...additions] })
        setTrial(undefined)
        return
      }
      const region = { page, ...box }
      const cells = transpose ? grid(box, 1, options)[0] : grid(box, options, 1).flat()
      const question = current ?? newQuestion(Math.max(0, ...value.questions.map(q => q.number)) + 1)
      const next: Question = tool === 'choice'
        ? { ...question, type: current?.type === 'multiple' ? 'multiple' : 'single', options, answer: question.answer.filter(a => a < String.fromCharCode(65 + options)), external_options: cells, regions: [region] }
        : { ...question, type: 'subjective', regions: current && appendRegion ? [...question.regions, region] : [...question.regions.filter(r => r.page !== page), region] }
      change({ questions: current ? value.questions.map(q => q.id === selected ? next : q) : [...value.questions, next] })
      setTrial(undefined)
    }
  }

  function switchPage(next: number) {
    setPage(next); setTrial(undefined); setCorners([]); setTool('anchor'); setLastDrawTool('anchor'); setSelected(''); setAdjustCell(false); setNotice('')
  }

  async function tryScan(file: Blob) {
    const saved = await flush()
    const body = new FormData()
    body.append('file', file, file instanceof File ? file.name : 'sample.jpg')
    body.append('side', page === 1 ? 'front' : 'back')
    setTrial(await request<Trial>(`/templates/${saved.id}/compatible/trial`, { method: 'POST', body }))
  }

  const pageQuestions = value.questions.filter(q => q.regions.some(r => r.page === page))
  const marks: { box: ImageBox; kind: string; label?: string }[] = [
    ...face.anchors.map((box, index) => ({ box, kind: 'anchor', label: `定${index + 1}` })),
    ...(face.candidate ?? []).flatMap((col, cIndex) => col.map((box, dIndex) => ({ box, kind: 'candidate', label: dIndex === 0 ? `${cIndex + 1}` : undefined }))),
    ...(face.absent ? [{ box: face.absent, kind: 'absent', label: '缺考' }] : []),
    ...pageQuestions.flatMap(q => q.regions.filter(r => r.page === page).map((box, idx) => ({
      box, kind: q.id === selected ? 'selected' : 'question', label: idx === 0 ? `Q${q.number}` : `Q${q.number}续`,
    }))),
    ...value.questions.filter(q => q.regions[0]?.page === page).flatMap(q => (q.external_options || []).map((box, i) => ({
      box, kind: 'choice', label: String.fromCharCode(65 + i),
    }))),
  ]
  const canAutoCorrect = !!(reference?.source || savedArt)
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
        <Typography.Paragraph type="secondary">推荐使用空白原稿。导入后可自动校正或手动校正四角，校正后可直接在校正图上继续框选。</Typography.Paragraph>
        <Space wrap>
          <Upload accept={formats} multiple showUploadList={false} disabled={blocked}
            beforeUpload={(file, files) => { if (file.uid === files[0].uid) void run(() => importFiles(files)); return false }}>
            <Button disabled={blocked}>{profile.mode === 'blank' ? '导入空白原稿' : combine ? '导入同面样张' : '导入样张'}</Button>
          </Upload>
          {profile.mode === 'completed' && <Checkbox disabled={blocked} checked={combine} onChange={e => setCombine(e.target.checked)}>合用同面样张</Checkbox>}
        </Space>
        {canAutoCorrect && <Space wrap className="compatible-tools">
          <Button disabled={blocked} onClick={() => void run(autoCorrectCurrent)}>自动校正</Button>
          <Button disabled={blocked} onClick={() => { setTrial(undefined); setCorners([]); setTool('corners') }}>手动校正四角</Button>
          <Button disabled={blocked} onClick={() => void run(async () => importFiles([new File([await (await fetch(correctingSource)).blob()], 'sample.jpg')], 2))}>旋转 180°</Button>
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
            onChange={next => chooseTool(next as Exclude<Tool, 'corners'>)} placeholder="选择框选工具" />
          {selected && <Button size="small" disabled={blocked} onClick={() => { setSelected(''); setAdjustCell(false) }}>取消选中（新建下一题）</Button>}
          {tool === 'candidate' && <><InputNumber aria-label="考号位数" min={1} max={20} value={value.candidate_length} disabled={blocked}
            onChange={length => { if (length) change({ candidate_length: length }) }} />
            <Checkbox disabled={blocked} checked={reverse} onChange={e => setReverse(e.target.checked)}>反向数字顺序</Checkbox></>}
          {tool === 'choice' && <>
            <InputNumber aria-label="选项数量" min={3} max={7} value={options} disabled={blocked} addonBefore="选项" style={{ width: 112 }}
              onChange={n => setOptions(n ?? 4)} />
            {!selected && !adjustCell && <InputNumber aria-label="批量题数" min={1} max={50} value={choiceBatchCount} disabled={blocked} addonBefore="连框题数" style={{ width: 132 }}
              onChange={n => setChoiceBatchCount(n ?? 1)} />}
          </>}
          {tool === 'subjective' && !!selectedQuestion && selectedQuestion.type === 'subjective' && <Checkbox disabled={blocked} checked={appendRegion}
            onChange={e => setAppendRegion(e.target.checked)}>追加同面续区</Checkbox>}
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
              options={Array.from({ length: 10 }, (_, digit) => ({ value: digit, label: `数字 ${digit}` }))} onChange={setCellDigit} />}
          </>}
          {tool === 'anchor' && face.anchors.length > 0 && !!image && !correcting && <Button disabled={blocked}
            onClick={() => void run(reextractAnchorsFromCurrent)}>按当前校正图重采样定位</Button>}
          {tool === 'absent' && face.absent && <Button disabled={blocked} onClick={() => setFace({ ...face, absent: undefined })}>清除缺考格</Button>}
        </Space>
        {tool === 'anchor' && face.anchors.length > 0 && <Space wrap size={[4, 4]} className="compatible-tools">
          {face.anchors.map((_, index) => <Tag key={index} color="purple" closable={!blocked}
            onClose={e => { e.preventDefault(); setFace({ ...face, anchors: face.anchors.filter((__, i) => i !== index) }) }}>定位 {index + 1}</Tag>)}
        </Space>}
        {correcting && <Space wrap className="compatible-tools">
          <Typography.Text>依次点击左上、右上、右下、左下纸角 {corners.length}/4</Typography.Text>
          <Button type="primary" disabled={blocked || corners.length !== 4} onClick={() => void run(async () => {
            const sourceUrl = correctingSource
            await importFiles([new File([await (await fetch(sourceUrl)).blob()], 'sample.jpg')], 0, corners, { preserveSource: sourceUrl, targetTool: lastDrawTool })
            setNotice('四角校正已应用，可继续框选定位参照与题区')
          })}>应用校正并继续框选</Button>
          <Button disabled={blocked || !corners.length} onClick={() => setCorners(prev => prev.slice(0, -1))}>撤销一点</Button>
          <Button disabled={blocked} onClick={() => setCorners([])}>重选四角</Button>
          {!!(reference?.image || savedArt) && <Button disabled={blocked} onClick={() => { setCorners([]); setTool(lastDrawTool) }}>取消</Button>}
        </Space>}
      </>}
      <div className="compatible-tools">
        <Tag>定位参照 {face.anchors.length}</Tag>
        {page === 1 && <Tag color={face.candidate?.length && face.candidate.length !== value.candidate_length ? 'orange' : undefined}>考号 {face.candidate?.length || 0} / {value.candidate_length} 位</Tag>}
        <Tag>本面 {pageQuestions.length} 题</Tag>
      </div>
      <div className="compatible-questions">
        {pageQuestions.map(q => <div key={q.id} className="compatible-question">
          <Button type={selected === q.id ? 'primary' : 'default'} onClick={() => {
            const nextSelected = selected === q.id ? '' : q.id
            setSelected(nextSelected)
            if (nextSelected) {
              const nextTool = q.type === 'subjective' ? 'subjective' : 'choice'
              setTool(nextTool); setLastDrawTool(nextTool); setOptions(q.options); setAdjustCell(false)
            }
          }}>第 {q.number} 题</Button>
          <InputNumber aria-label={`第 ${q.number} 题题号`} disabled={blocked} min={1} value={q.number}
            onChange={number => { if (number && !value.questions.some(other => other.id !== q.id && other.number === number)) questionUpdate(q.id, { number }) }} />
          <InputNumber aria-label={`第 ${q.number} 题分值`} disabled={blocked} value={q.points} min={.01} precision={2}
            onChange={points => { if (points) questionUpdate(q.id, { points }) }} />
          <Button disabled={blocked} onClick={() => settings(q.id)}>设置</Button>
          <Button disabled={blocked} danger onClick={() => { if (selected === q.id) setSelected(''); change({ questions: value.questions.filter(other => other.id !== q.id) }); setTrial(undefined) }}>删除</Button>
        </div>)}
      </div>
      {!readOnly && <Space wrap className="compatible-tools">
        <Upload accept={formats} showUploadList={false} disabled={blocked}
          beforeUpload={file => { void run(() => tryScan(file)); return false }}><Button disabled={blocked}>上传本面试扫件</Button></Upload>
        {!!(reference?.source || savedArt) && <Button disabled={blocked} onClick={() => void run(async () => tryScan(await (await fetch(reference?.source || savedArt)).blob()))}>使用当前样张试扫</Button>}
      </Space>}
    </Card>
    <Card title="原版面" extra={<Space wrap>
      <Button size="small" icon={<ZoomOutOutlined />} aria-label="缩小画布" disabled={!image || zoom <= 50} onClick={() => setZoom(z => Math.max(50, z - 25))} />
      <Button size="small" disabled={!image} onClick={() => setZoom(100)}>{zoom}%</Button>
      <Button size="small" icon={<ZoomInOutlined />} aria-label="放大画布" disabled={!image || zoom >= 250} onClick={() => setZoom(z => Math.min(250, z + 25))} />
      <Select aria-label="纸面" value={page} disabled={busy} onChange={switchPage}
        options={[{ value: 1, label: '正面' }, ...(value.sides === 2 ? [{ value: 2, label: '背面' }] : [])]} />
    </Space>}>
      {(error || reference?.error) && <Alert className="compatible-tools" showIcon type="warning" message={error || reference?.error} />}
      {notice && <Alert className="compatible-tools" showIcon type="info" message={notice} closable onClose={() => setNotice('')} />}
      {trial && <Alert className="compatible-tools" showIcon type="success" message="请核对本面试扫结果（当前显示自动校正图）"
        description={<div>{page === 1 && <div>考号 {trial.candidate || '未识读'}{trial.absent ? ' · 缺考' : ''}</div>}
          {Object.entries(trial.selections).map(([id, choices]) => <Tag key={id}>第 {value.questions.find(q => q.id === id)?.number} 题 {choices.join('') || '空白'}</Tag>)}</div>}
        action={<Space direction="vertical" size={6}>
          {!readOnly && <Button type="primary" size="small" disabled={blocked} onClick={() => void run(() => adoptCorrectedImage(trial.image, '已引用自动校正图作为当前底图，可继续框选定位与答题区'))}>引用此校正图继续框选</Button>}
          <Button size="small" onClick={() => setTrial(undefined)}>返回标定</Button>
        </Space>} />}
      {image ? <div className="compatible-canvas-viewport"><div className="compatible-canvas" style={{ aspectRatio: `${width}/${height}`, width: `${zoom}%`, maxWidth: zoom > 100 ? 'none' : 920 }}>
        <img ref={imgRef} src={image} alt={correcting ? '待校正原图' : '当前纸面'} draggable={false}
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
          {correcting ? <>
            {corners.length > 1 && <polyline points={(corners.length === 4 ? [...corners, corners[0]] : corners).map(([cx, cy]) => `${cx},${cy}`).join(' ')} className="compatible-corners-poly" />}
            {corners.map(([cx, cy], index) => <g key={index}><circle cx={cx} cy={cy} r={Math.max(width, height) / 120} />
              <text x={cx + Math.max(width, height) / 100} y={cy} fontSize={Math.max(width, height) / 45}>{index + 1}</text></g>)}
          </> : marks.map(({ box, kind, label }, i) => <g key={i}>
            <rect {...box} className={`compatible-mark-${kind}`} />
            {label && <text x={box.x + 0.6} y={box.y + Math.min(box.height - 0.4, 3.2)} className={`compatible-label compatible-label-${kind}`}>{label}</text>}
          </g>)}
          {drag && <rect {...drag} className="compatible-mark-selected" />}
        </svg>
      </div></div> : <Empty description={readOnly ? '已保存题区与扫描定位配置' : '导入该面的空白原稿或扫描样张'} />}
    </Card>
  </div>
}
