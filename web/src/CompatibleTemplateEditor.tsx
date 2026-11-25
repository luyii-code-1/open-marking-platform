import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons'
import { Alert, Card, Checkbox, Empty, Form, Input, InputNumber, Segmented, Select, Space, Steps, Tag, Typography, Upload } from 'antd'
import { Button } from './Button'
import { newQuestion, request, requestBlob, type ExternalAnchor, type ExternalPage, type ImageBox, type Question, type Row, type Template } from './api'
import './compatible-template.css'

type Point = [number, number]
type DrawTool = 'anchor' | 'candidate' | 'choice' | 'subjective' | 'absent'
type InteractionMode = 'draw' | 'edit'
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
type Reference = {
  source: string; image?: string; error?: string; anchors: ExternalAnchor[]
  candidate: ImageBox[][]; choices: ImageBox[][]; frames: ImageBox[]
  rectified?: boolean
}
type Trial = { image: string; candidate: string | null; selections: Record<string, string[]>; absent: boolean }
type ActiveMark =
  | { kind: 'anchor'; index: number }
  | { kind: 'candidate' }
  | { kind: 'candidate-cell'; col: number; digit: number }
  | { kind: 'absent' }
  | { kind: 'question'; id: string; regionIndex: number }
  | { kind: 'choice-cell'; id: string; optionIndex: number }
type EditDrag = {
  mark: ActiveMark
  action: 'move' | ResizeHandle
  origin: Point
  initialBox: ImageBox
  currentBox: ImageBox
}

const formats = '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.bmp'
const regionTools: { value: Exclude<DrawTool, 'anchor'>; label: string }[] = [
  { value: 'candidate', label: '考号填涂格' },
  { value: 'absent', label: '缺考格' },
  { value: 'choice', label: '客观题' },
  { value: 'subjective', label: '主观题' },
]
const handles: { id: ResizeHandle; cx: (b: ImageBox) => number; cy: (b: ImageBox) => number; cursor: string }[] = [
  { id: 'nw', cx: b => b.x, cy: b => b.y, cursor: 'nwse-resize' },
  { id: 'n', cx: b => b.x + b.width / 2, cy: b => b.y, cursor: 'ns-resize' },
  { id: 'ne', cx: b => b.x + b.width, cy: b => b.y, cursor: 'nesw-resize' },
  { id: 'e', cx: b => b.x + b.width, cy: b => b.y + b.height / 2, cursor: 'ew-resize' },
  { id: 'se', cx: b => b.x + b.width, cy: b => b.y + b.height, cursor: 'nwse-resize' },
  { id: 's', cx: b => b.x + b.width / 2, cy: b => b.y + b.height, cursor: 'ns-resize' },
  { id: 'sw', cx: b => b.x, cy: b => b.y + b.height, cursor: 'nesw-resize' },
  { id: 'w', cx: b => b.x, cy: b => b.y + b.height / 2, cursor: 'ew-resize' },
]

const round2 = (n: number) => Math.round(n * 100) / 100

function enclosing(cells: ImageBox[]): ImageBox {
  const x = Math.min(...cells.map(cell => cell.x)), y = Math.min(...cells.map(cell => cell.y))
  return {
    x: round2(x),
    y: round2(y),
    width: round2(Math.max(...cells.map(cell => cell.x + cell.width)) - x),
    height: round2(Math.max(...cells.map(cell => cell.y + cell.height)) - y),
  }
}

function grid(box: ImageBox, columns: number, rows: number) {
  const width = box.width / columns, height = box.height / rows
  return Array.from({ length: columns }, (_, column) => Array.from({ length: rows }, (_, row) =>
    ({ x: round2(box.x + column * width), y: round2(box.y + row * height), width: round2(width), height: round2(height) })))
}

function overlaps(a: ImageBox, b: ImageBox) {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const area = ix * iy
  return area > 0 && area / Math.min(a.width * a.height, b.width * b.height) > 0.3
}

function sameMark(a?: ActiveMark, b?: ActiveMark): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'anchor' && b.kind === 'anchor') return a.index === b.index
  if (a.kind === 'candidate' || a.kind === 'absent') return true
  if (a.kind === 'candidate-cell' && b.kind === 'candidate-cell') return a.col === b.col && a.digit === b.digit
  if (a.kind === 'question' && b.kind === 'question') return a.id === b.id && a.regionIndex === b.regionIndex
  if (a.kind === 'choice-cell' && b.kind === 'choice-cell') return a.id === b.id && a.optionIndex === b.optionIndex
  return false
}

function remapBox(cell: ImageBox, from: ImageBox, to: ImageBox): ImageBox {
  const sx = from.width > 1e-4 ? to.width / from.width : 1
  const sy = from.height > 1e-4 ? to.height / from.height : 1
  return {
    x: round2(to.x + (cell.x - from.x) * sx),
    y: round2(to.y + (cell.y - from.y) * sy),
    width: round2(Math.max(1, cell.width * sx)),
    height: round2(Math.max(1, cell.height * sy)),
  }
}

function clampBox(box: ImageBox, maxW: number, maxH: number, minSize = 1.2): ImageBox {
  const w = Math.min(maxW, Math.max(minSize, box.width))
  const h = Math.min(maxH, Math.max(minSize, box.height))
  const x = Math.min(maxW - w, Math.max(0, box.x))
  const y = Math.min(maxH - h, Math.max(0, box.y))
  return { x: round2(x), y: round2(y), width: round2(w), height: round2(h) }
}

function applyDragDelta(initial: ImageBox, action: 'move' | ResizeHandle, dx: number, dy: number, maxW: number, maxH: number, minSize: number): ImageBox {
  if (action === 'move') {
    return clampBox({ x: initial.x + dx, y: initial.y + dy, width: initial.width, height: initial.height }, maxW, maxH, minSize)
  }
  let left = initial.x, top = initial.y, right = initial.x + initial.width, bottom = initial.y + initial.height
  if (action.includes('w')) left = Math.min(right - minSize, Math.max(0, initial.x + dx))
  if (action.includes('e')) right = Math.max(left + minSize, Math.min(maxW, initial.x + initial.width + dx))
  if (action.includes('n')) top = Math.min(bottom - minSize, Math.max(0, initial.y + dy))
  if (action.includes('s')) bottom = Math.max(top + minSize, Math.min(maxH, initial.y + initial.height + dy))
  return { x: round2(left), y: round2(top), width: round2(right - left), height: round2(bottom - top) }
}

type Props = {
  value: Template; disabled: boolean; readOnly: boolean; change: (patch: Partial<Template>) => void
  flush: () => Promise<Template>; settings: (id: string) => void
}

export function CompatibleTemplateEditor({ value, disabled, readOnly, change, flush, settings }: Props) {
  const profile = value.external_sheet!
  const anonymous = value.statistics_sheet === true
  const statistics = anonymous || value.statistics_mode === true
  const [page, setPage] = useState(1)
  const [step, setStep] = useState(() => {
    if (readOnly || (profile.pages['1']?.anchors.length ?? 0) >= 4) return 2
    return value.background_assets?.['1'] ? 1 : 0
  })
  const [mode, setMode] = useState<InteractionMode>('draw')
  const [regionTool, setRegionTool] = useState<Exclude<DrawTool, 'anchor'>>(anonymous ? 'choice' : 'candidate')
  const [pickingCorners, setPickingCorners] = useState(false)
  const [applyGrayscale, setApplyGrayscale] = useState(true)
  const [refs, setRefs] = useState<Record<number, Reference>>({})
  const [savedArt, setSavedArt] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [combine, setCombine] = useState(false)
  const [transpose, setTranspose] = useState(false)
  const [reverse, setReverse] = useState(false)
  const [options, setOptions] = useState(4)
  const [optionRows, setOptionRows] = useState(1)
  const [choiceBatchCount, setChoiceBatchCount] = useState(1)
  const [appendRegion, setAppendRegion] = useState(false)
  const [selected, setSelected] = useState('')
  const [activeMark, setActiveMark] = useState<ActiveMark>()
  const [editGranularCell, setEditGranularCell] = useState(false)
  const [trial, setTrial] = useState<Trial>()
  const [adjustCell, setAdjustCell] = useState(false)
  const [cellColumn, setCellColumn] = useState(1)
  const [cellDigit, setCellDigit] = useState(0)
  const [rawSize, setRawSize] = useState<Point>([1, 1])
  const [corners, setCorners] = useState<Point[]>([])
  const [zoom, setZoom] = useState(100)
  const [drag, setDrag] = useState<ImageBox>()
  const [editDrag, setEditDrag] = useState<EditDrag>()
  const drawStart = useRef<Point | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const face = profile.pages[String(page)] ?? { anchors: [] }
  const selectedQuestion = value.questions.find(q => q.id === selected)
  const reference = refs[page]
  const correctingSource = reference?.source || savedArt
  const correcting = pickingCorners && !!correctingSource
  const dimensions: Point = value.paper === 'A3' ? [420, 297] : [210, 297]
  const [width, height] = correcting ? rawSize : dimensions
  const image = correcting ? correctingSource : trial?.image || reference?.image || savedArt
  const asset = value.background_assets?.[String(page)]
  const blocked = disabled || readOnly || busy
  const endpoint = `/groups/${value.group_id}/compatible`
  const activeDrawTool: DrawTool = step === 1 ? 'anchor' : (page === 2 && (regionTool === 'candidate' || regionTool === 'absent') ? 'choice' : regionTool)
  const canDrawOnCanvas = !blocked && !trial && !correcting && mode === 'draw' && (step === 1 || step === 2)
  const canEditOnCanvas = !blocked && !trial && !correcting && mode === 'edit' && (step === 1 || step === 2)

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

  function getMarkBox(mark: ActiveMark): ImageBox | undefined {
    if (mark.kind === 'anchor') {
      const a = face.anchors[mark.index]
      return a ? { x: a.x, y: a.y, width: a.width, height: a.height } : undefined
    }
    if (mark.kind === 'candidate') {
      const flat = (face.candidate ?? []).flat()
      return flat.length ? enclosing(flat) : undefined
    }
    if (mark.kind === 'candidate-cell') return face.candidate?.[mark.col]?.[mark.digit]
    if (mark.kind === 'absent') return face.absent
    if (mark.kind === 'question') {
      const q = value.questions.find(item => item.id === mark.id)
      const r = q?.regions[mark.regionIndex]
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : undefined
    }
    if (mark.kind === 'choice-cell') {
      const q = value.questions.find(item => item.id === mark.id)
      return q?.external_options?.[mark.optionIndex]
    }
    return undefined
  }

  function markLabel(mark: ActiveMark): string {
    if (mark.kind === 'anchor') return `定位块 ${mark.index + 1}`
    if (mark.kind === 'candidate') return `考号整体（${face.candidate?.length || 0} 位）`
    if (mark.kind === 'candidate-cell') return `考号第 ${mark.col + 1} 位 · 数字 ${mark.digit}`
    if (mark.kind === 'absent') return '缺考格'
    if (mark.kind === 'question') {
      const q = value.questions.find(item => item.id === mark.id)
      return q ? `第 ${q.number} 题${mark.regionIndex > 0 ? `（续区 ${mark.regionIndex + 1}）` : ''}` : '题目'
    }
    const q = value.questions.find(item => item.id === mark.id)
    return q ? `第 ${q.number} 题 · 选项 ${String.fromCharCode(65 + mark.optionIndex)}` : '选项格'
  }

  function setFace(next: ExternalPage) {
    change({ external_sheet: { ...profile, pages: { ...profile.pages, [page]: next } } })
    setTrial(undefined)
  }

  function questionUpdate(id: string, patch: Partial<Question>) {
    change({ questions: value.questions.map(q => q.id === id ? { ...q, ...patch } : q) })
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

  async function importFiles(
    files: File[],
    rotation = 0,
    points?: Point[],
    opts?: { alreadyCorrected?: boolean; preserveSource?: string; targetStep?: number; grayscale?: boolean },
  ) {
    const body = new FormData()
    files.forEach(file => body.append('files', file))
    body.append('paper', value.paper)
    body.append('rotation', String(rotation))
    body.append('apply_grayscale', String(opts?.grayscale ?? applyGrayscale))
    if (opts?.alreadyCorrected) body.append('already_corrected', 'true')
    if (combine && !points && !opts?.alreadyCorrected) body.append('combine', 'true')
    if (points) body.append('corners', JSON.stringify(points))
    const result = await request<{ pages: Reference[] }>(endpoint + '/reference', { method: 'POST', body })
    if (result.pages.length > value.sides - page + 1) throw new Error('请先选择双面题卡，并从正面导入两页原稿')
    const next = { ...refs }
    let assets = { ...value.background_assets }
    for (let i = 0; i < result.pages.length; i++) {
      const sheet = { ...result.pages[i], rectified: !!result.pages[i].image }
      const n = page + i
      next[n] = opts?.preserveSource && i === 0 ? { ...sheet, source: opts.preserveSource } : sheet
      if (sheet.image && profile.mode === 'blank') {
        assets = (await saveBlankAsset(sheet.image, n, assets)) || assets
      }
    }
    setRefs(next)
    setTrial(undefined)
    setCorners([])
    setActiveMark(undefined)
    const hasErr = !!next[page]?.error
    setPickingCorners(hasErr)
    if (!hasErr && opts?.targetStep !== undefined) setStep(opts.targetStep)
    if (profile.mode === 'blank') change({ background_assets: assets })
  }

  async function adoptCorrectedImage(sourceImage: string, successText: string) {
    const blob = await (await fetch(sourceImage)).blob()
    const file = new File([blob], 'corrected.png', { type: blob.type || 'image/png' })
    await importFiles([file], 0, undefined, {
      alreadyCorrected: true,
      preserveSource: reference?.source || sourceImage,
      targetStep: face.anchors.length >= 4 ? 2 : 1,
      grayscale: true,
    })
    setNotice(successText)
  }

  async function rectifyPage(kind: 'auto' | 'corners' | 'anchors' | 'detect') {
    const sourceUrl = kind === 'corners' || kind === 'auto' ? (reference?.source || savedArt) : (reference?.image || savedArt)
    if (!sourceUrl) return
    const blob = await (await fetch(sourceUrl)).blob()
    const body = new FormData()
    body.append('file', blob, kind === 'corners' || kind === 'auto' ? 'sample.jpg' : 'page.png')
    body.append('paper', value.paper)
    body.append('apply_grayscale', String(applyGrayscale))
    body.append('detect_regions', 'true')
    if (kind === 'corners') {
      body.append('corners', JSON.stringify(corners))
    } else if (kind === 'anchors') {
      body.append('anchors', JSON.stringify(face.anchors.map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }))))
    } else if (kind === 'detect') {
      body.append('already_rectified', 'true')
    }
    const result = await request<{ image: string; anchors: ExternalAnchor[]; candidate: ImageBox[][]; choices: ImageBox[][]; frames: ImageBox[] }>(
      endpoint + '/rectify',
      { method: 'POST', body },
    )
    const updatedRef: Reference = {
      source: reference?.source || sourceUrl,
      image: result.image,
      anchors: result.anchors,
      candidate: result.candidate,
      choices: result.choices,
      frames: result.frames,
      rectified: true,
    }
    setRefs(prev => ({ ...prev, [page]: updatedRef }))
    setTrial(undefined)
    setCorners([])
    setPickingCorners(false)
    setActiveMark(undefined)
    if (profile.mode === 'blank') {
      const assets = await saveBlankAsset(result.image, page)
      if (assets) change({ background_assets: assets })
    }
    if (kind === 'anchors') {
      setFace({ ...face, anchors: result.anchors })
      setNotice(`已按定位块完成灰度与矩形校正，并在校正图上自动识别出考号 ${result.candidate.length} 位、客观题 ${result.choices.length} 题、主观题 ${result.frames.length} 区`)
      setStep(2)
    } else if (kind === 'detect') {
      setNotice(`已在当前矩形校正图上识别出考号 ${result.candidate.length} 位、客观题 ${result.choices.length} 题、主观题 ${result.frames.length} 区`)
    } else {
      setNotice('已完成灰度与矩形校正，可进入下一步标定或核对定位块')
      setStep(1)
    }
  }

  async function sampleSingleAnchor(box: ImageBox, tighten: boolean, replaceIndex?: number) {
    if (!image) return
    const blob = await (await fetch(image)).blob()
    const body = new FormData()
    body.append('file', blob, 'anchor.png')
    body.append('paper', value.paper)
    body.append('box', JSON.stringify(box))
    body.append('tighten', String(tighten))
    const sampled = await request<ExternalAnchor>(endpoint + '/anchor', { method: 'POST', body })
    if (replaceIndex !== undefined) {
      setFace({ ...face, anchors: face.anchors.map((a, idx) => idx === replaceIndex ? sampled : a) })
    } else {
      const nextAnchors = [...face.anchors, sampled]
      setFace({ ...face, anchors: nextAnchors })
      setActiveMark({ kind: 'anchor', index: nextAnchors.length - 1 })
    }
  }

  async function reextractAnchorsFromCurrent(tighten = true) {
    if (!image || !face.anchors.length) return
    const blob = await (await fetch(image)).blob()
    const body = new FormData()
    body.append('file', blob, 'page.png')
    body.append('paper', value.paper)
    body.append('tighten', String(tighten))
    body.append('boxes', JSON.stringify(face.anchors.map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }))))
    const result = await request<{ anchors: ExternalAnchor[] }>(endpoint + '/reextract-anchors', { method: 'POST', body })
    setFace({ ...face, anchors: result.anchors })
    setNotice(tighten ? '已紧缩并重采样全部定位块' : '已按当前校正图重采样全部定位块')
  }

  function applySuggestions(kind: 'anchors' | 'candidate' | 'choices' | 'frames') {
    if (!reference || (anonymous && kind === 'candidate') || (statistics && kind === 'frames')) return
    if (kind === 'anchors') {
      setFace({ ...face, anchors: reference.anchors })
      setNotice(`已采用 ${reference.anchors.length} 个自动识别定位块`)
    }
    if (kind === 'candidate') {
      const page1 = profile.pages['1'] ?? { anchors: [] }
      change({
        candidate_length: reference.candidate.length,
        external_sheet: { ...profile, pages: { ...profile.pages, '1': { ...page1, candidate: reference.candidate } } },
      })
      setNotice(`已采用 ${reference.candidate.length} 位考号填涂区`)
    }
    if (kind === 'choices' || kind === 'frames') {
      const existingOnPage = value.questions.flatMap(q => q.regions.filter(r => r.page === page))
      const number = Math.max(0, ...value.questions.map(q => q.number)) + 1
      const filtered = kind === 'choices'
        ? reference.choices.filter(cells => { const box = enclosing(cells); return !existingOnPage.some(r => overlaps(r, box)) })
        : reference.frames.filter(box => !existingOnPage.some(r => overlaps(r, box)))
      if (!filtered.length) {
        setNotice('识别结果已全部添加或与现有题目重叠')
        return
      }
      const additions = kind === 'choices' ? (filtered as ImageBox[][]).map((cells, i) => ({
        ...newQuestion(number + i), type: 'single' as const, points: 1,
        options: cells.length, external_options: cells, regions: [{ page, ...enclosing(cells) }],
      })) : (filtered as ImageBox[]).map((box, i) => ({ ...newQuestion(number + i), regions: [{ page, ...box }] }))
      change({ questions: [...value.questions, ...additions] })
      setNotice(`已添加 ${additions.length} 项${kind === 'choices' ? '客观题' : '主观题'}区域`)
    }
    setTrial(undefined)
  }

  function commitMarkBox(mark: ActiveMark, nextBox: ImageBox, syncAnchorPattern = true) {
    if (mark.kind === 'anchor') {
      const existing = face.anchors[mark.index]
      if (!existing) return
      const nextAnchors = face.anchors.map((a, idx) => idx === mark.index ? { ...a, ...nextBox } : a)
      setFace({ ...face, anchors: nextAnchors })
      if (syncAnchorPattern && image) {
        void run(() => sampleSingleAnchor(nextBox, false, mark.index))
      }
    } else if (mark.kind === 'candidate') {
      const cols = face.candidate
      if (!cols?.length) return
      const oldBox = enclosing(cols.flat())
      setFace({ ...face, candidate: cols.map(col => col.map(cell => remapBox(cell, oldBox, nextBox))) })
    } else if (mark.kind === 'candidate-cell') {
      const cols = face.candidate
      if (!cols?.[mark.col]?.[mark.digit]) return
      setFace({
        ...face,
        candidate: cols.map((col, ci) => ci === mark.col ? col.map((cell, di) => di === mark.digit ? nextBox : cell) : col),
      })
    } else if (mark.kind === 'absent') {
      setFace({ ...face, absent: nextBox })
    } else if (mark.kind === 'question') {
      const q = value.questions.find(item => item.id === mark.id)
      const oldRegion = q?.regions[mark.regionIndex]
      if (!q || !oldRegion) return
      if (q.type === 'subjective') {
        questionUpdate(q.id, { regions: q.regions.map((r, idx) => idx === mark.regionIndex ? { ...r, ...nextBox } : r) })
      } else {
        const oldBox = { x: oldRegion.x, y: oldRegion.y, width: oldRegion.width, height: oldRegion.height }
        const cells = (q.external_options || []).map(cell => remapBox(cell, oldBox, nextBox))
        questionUpdate(q.id, { external_options: cells, regions: [{ page: oldRegion.page, ...nextBox }] })
      }
    } else if (mark.kind === 'choice-cell') {
      const q = value.questions.find(item => item.id === mark.id)
      if (!q?.external_options?.[mark.optionIndex]) return
      const cells = q.external_options.map((cell, idx) => idx === mark.optionIndex ? nextBox : cell)
      questionUpdate(q.id, { external_options: cells, regions: [{ page: q.regions[0]?.page ?? page, ...enclosing(cells) }] })
    }
  }

  function deleteActiveMark(mark: ActiveMark) {
    if (mark.kind === 'anchor') {
      setFace({ ...face, anchors: face.anchors.filter((_, idx) => idx !== mark.index) })
    } else if (mark.kind === 'candidate') {
      setFace({ ...face, candidate: undefined })
    } else if (mark.kind === 'absent') {
      setFace({ ...face, absent: undefined })
    } else if (mark.kind === 'question') {
      const q = value.questions.find(item => item.id === mark.id)
      if (!q) return
      if (q.type === 'subjective' && q.regions.length > 1) {
        questionUpdate(q.id, { regions: q.regions.filter((_, idx) => idx !== mark.regionIndex) })
      } else {
        if (selected === q.id) setSelected('')
        change({ questions: value.questions.filter(other => other.id !== q.id) })
        setTrial(undefined)
      }
    }
    setActiveMark(undefined)
  }

  useEffect(() => {
    if (!canEditOnCanvas || !activeMark) return
    function onKeyDown(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (event.key === 'Escape') { setActiveMark(undefined); return }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (activeMark && activeMark.kind !== 'candidate-cell' && activeMark.kind !== 'choice-cell') {
          event.preventDefault()
          deleteActiveMark(activeMark)
        }
        return
      }
      const delta = event.shiftKey ? 2 : 0.5
      let dx = 0, dy = 0
      if (event.key === 'ArrowLeft') dx = -delta
      else if (event.key === 'ArrowRight') dx = delta
      else if (event.key === 'ArrowUp') dy = -delta
      else if (event.key === 'ArrowDown') dy = delta
      else return
      const currentBox = activeMark ? getMarkBox(activeMark) : undefined
      if (!activeMark || !currentBox) return
      event.preventDefault()
      const minSize = activeMark.kind === 'anchor' ? 3 : 1.2
      commitMarkBox(activeMark, clampBox({ ...currentBox, x: currentBox.x + dx, y: currentBox.y + dy }, width, height, minSize), true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  function point(event: PointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect()
    return [
      Math.min(correcting ? width - 1 : width, Math.max(0, (event.clientX - rect.left) / rect.width * width)),
      Math.min(correcting ? height - 1 : height, Math.max(0, (event.clientY - rect.top) / rect.height * height)),
    ]
  }

  function rectangle(a: Point, b: Point): ImageBox {
    return {
      x: round2(Math.min(a[0], b[0])),
      y: round2(Math.min(a[1], b[1])),
      width: round2(Math.abs(a[0] - b[0])),
      height: round2(Math.abs(a[1] - b[1])),
    }
  }

  function finishBox(box: ImageBox) {
    if (box.width < 1 || box.height < 1) return
    if (activeDrawTool === 'anchor') {
      if (face.anchors.length >= 8) { setError('每面最多八个定位参照'); return }
      void run(() => sampleSingleAnchor(box, true))
    } else if (activeDrawTool === 'candidate') {
      if (adjustCell && face.candidate?.[cellColumn - 1]) {
        setFace({
          ...face,
          candidate: face.candidate.map((column, i) =>
            i === cellColumn - 1 ? column.map((cell, d) => d === cellDigit ? box : cell) : column),
        })
        return
      }
      const partition = transpose ? grid(box, 10, value.candidate_length) : grid(box, value.candidate_length, 10)
      const digits = transpose ? Array.from({ length: value.candidate_length }, (_, row) => partition.map(col => col[row])) : partition
      setFace({ ...face, candidate: reverse ? digits.map(cells => [...cells].reverse()) : digits })
    } else if (activeDrawTool === 'absent') {
      setFace({ ...face, absent: box })
    } else {
      const current = value.questions.find(q => q.id === selected)
      if (current && (activeDrawTool === 'subjective') !== (current.type === 'subjective')) {
        setError('请选取相同题型的题目，或取消选中后新建题目')
        return
      }
      if (activeDrawTool === 'choice' && adjustCell && current?.external_options?.[cellColumn - 1] && current.regions[0].page === page) {
        const cells = current.external_options.map((cell, i) => i === cellColumn - 1 ? box : cell)
        questionUpdate(current.id, { external_options: cells, regions: [{ page, ...enclosing(cells) }] })
        return
      }
      if (activeDrawTool === 'choice' && !current && choiceBatchCount > 1 && (transpose || optionRows === 1)) {
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
      const rows = statistics ? Math.min(options, optionRows) : 1
      const layout = grid(box, Math.ceil(options / rows), rows)
      const cells = transpose ? grid(box, 1, options)[0] : Array.from({ length: rows }, (_, row) =>
        layout.map(column => column[row])).flat().slice(0, options)
      const question = current ?? newQuestion(Math.max(0, ...value.questions.map(q => q.number)) + 1)
      const next: Question = activeDrawTool === 'choice'
        ? { ...question, type: current?.type === 'multiple' ? 'multiple' : 'single', options, answer: question.answer.filter(a => a < String.fromCharCode(65 + options)), external_options: cells, regions: [region] }
        : { ...question, type: 'subjective', regions: current && appendRegion ? [...question.regions, region] : [...question.regions.filter(r => r.page !== page), region] }
      change({ questions: current ? value.questions.map(q => q.id === selected ? next : q) : [...value.questions, next] })
      setTrial(undefined)
    }
  }

  function goStep(nextStep: number) {
    setTrial(undefined)
    setPickingCorners(false)
    setCorners([])
    setAdjustCell(false)
    setActiveMark(undefined)
    setStep(nextStep)
    if (nextStep === 2 && page === 2 && (regionTool === 'candidate' || regionTool === 'absent')) {
      setRegionTool('choice')
    }
  }

  function switchPage(next: number) {
    setPage(next)
    setTrial(undefined)
    setCorners([])
    setPickingCorners(false)
    setSelected('')
    setActiveMark(undefined)
    setAdjustCell(false)
    setNotice('')
    setStep(readOnly || (profile.pages[String(next)]?.anchors.length ?? 0) >= 4 ? 2 : refs[next]?.image || value.background_assets?.[String(next)] ? 1 : 0)
  }

  async function tryScan(file: Blob) {
    const saved = await flush()
    const body = new FormData()
    body.append('file', file, file instanceof File ? file.name : 'sample.jpg')
    body.append('side', page === 1 ? 'front' : 'back')
    setTrial(await request<Trial>(`/templates/${saved.id}/compatible/trial`, { method: 'POST', body }))
  }

  function startEditDrag(event: PointerEvent<SVGElement>, mark: ActiveMark, action: 'move' | ResizeHandle) {
    if (!canEditOnCanvas) return
    event.stopPropagation()
    const box = getMarkBox(mark)
    if (!box) return
    setActiveMark(mark)
    if (mark.kind === 'question' || mark.kind === 'choice-cell') setSelected(mark.id)
    const svg = event.currentTarget.ownerSVGElement
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const origin: Point = [
      Math.min(width, Math.max(0, (event.clientX - rect.left) / rect.width * width)),
      Math.min(height, Math.max(0, (event.clientY - rect.top) / rect.height * height)),
    ]
    setEditDrag({ mark, action, origin, initialBox: box, currentBox: box })
    svg.setPointerCapture(event.pointerId)
  }

  const pageQuestions = value.questions.filter(q => q.regions.some(r => r.page === page))
  const candidateEnvelope = face.candidate?.length ? enclosing(face.candidate.flat()) : undefined
  const activeBox = editDrag ? editDrag.currentBox : (activeMark ? getMarkBox(activeMark) : undefined)
  const canAutoCorrect = !!(reference?.source || savedArt)
  const hasRectifiedPage = !!(reference?.image || savedArt)

  type RenderMark = {
    key: string
    box: ImageBox
    kind: string
    label?: string
    mark?: ActiveMark
  }
  const marks: RenderMark[] = [
    ...face.anchors.map((box, index) => {
      const m: ActiveMark = { kind: 'anchor', index }
      const b = editDrag && sameMark(editDrag.mark, m) ? editDrag.currentBox : box
      return { key: `anchor-${index}`, box: b, kind: sameMark(activeMark, m) ? 'selected' : 'anchor', label: `定${index + 1}`, mark: m }
    }),
    ...(candidateEnvelope && !editGranularCell ? [{
      key: 'candidate-envelope',
      box: editDrag && sameMark(editDrag.mark, { kind: 'candidate' }) ? editDrag.currentBox : candidateEnvelope,
      kind: sameMark(activeMark, { kind: 'candidate' }) ? 'selected' : 'candidate-group',
      label: '考号',
      mark: { kind: 'candidate' } as ActiveMark,
    }] : []),
    ...(face.candidate ?? []).flatMap((col, cIndex) => col.map((box, dIndex) => {
      const cellMark: ActiveMark = { kind: 'candidate-cell', col: cIndex, digit: dIndex }
      let b = box
      if (editDrag && sameMark(editDrag.mark, { kind: 'candidate' }) && candidateEnvelope) {
        b = remapBox(box, candidateEnvelope, editDrag.currentBox)
      } else if (editDrag && sameMark(editDrag.mark, cellMark)) {
        b = editDrag.currentBox
      }
      return {
        key: `cand-${cIndex}-${dIndex}`,
        box: b,
        kind: sameMark(activeMark, cellMark) ? 'selected' : 'candidate',
        label: dIndex === 0 ? `${cIndex + 1}` : undefined,
        mark: editGranularCell ? cellMark : ({ kind: 'candidate' } as ActiveMark),
      }
    })),
    ...(face.absent ? [{
      key: 'absent',
      box: editDrag && sameMark(editDrag.mark, { kind: 'absent' }) ? editDrag.currentBox : face.absent,
      kind: sameMark(activeMark, { kind: 'absent' }) ? 'selected' : 'absent',
      label: '缺考',
      mark: { kind: 'absent' } as ActiveMark,
    }] : []),
    ...pageQuestions.flatMap(q => q.regions.map((r, regionIndex) => ({ r, regionIndex })).filter(({ r }) => r.page === page).map(({ r, regionIndex }, visIdx) => {
      const qMark: ActiveMark = { kind: 'question', id: q.id, regionIndex }
      const b = editDrag && sameMark(editDrag.mark, qMark) ? editDrag.currentBox : r
      const isSelected = sameMark(activeMark, qMark) || (mode === 'draw' && q.id === selected)
      return {
        key: `q-${q.id}-${regionIndex}`,
        box: b,
        kind: isSelected ? 'selected' : 'question',
        label: visIdx === 0 ? `Q${q.number}` : `Q${q.number}续`,
        mark: editGranularCell && q.type !== 'subjective' ? undefined : qMark,
      }
    })),
    ...value.questions.filter(q => q.regions[0]?.page === page).flatMap(q => (q.external_options || []).map((box, optionIndex) => {
      const cellMark: ActiveMark = { kind: 'choice-cell', id: q.id, optionIndex }
      const qMark: ActiveMark = { kind: 'question', id: q.id, regionIndex: 0 }
      let b = box
      if (editDrag && sameMark(editDrag.mark, qMark)) {
        b = remapBox(box, editDrag.initialBox, editDrag.currentBox)
      } else if (editDrag && sameMark(editDrag.mark, cellMark)) {
        b = editDrag.currentBox
      }
      return {
        key: `opt-${q.id}-${optionIndex}`,
        box: b,
        kind: sameMark(activeMark, cellMark) ? 'selected' : 'choice',
        label: String.fromCharCode(65 + optionIndex),
        mark: editGranularCell ? cellMark : qMark,
      }
    })),
  ]

  const showCanvas = !!image || (statistics && readOnly && marks.length > 0)
  const stepItems = [
    { title: '导入与校正', description: hasRectifiedPage ? '已就绪' : '待导入' },
    { title: '标定定位块', description: `${face.anchors.length} 个` },
    { title: '识别与框选', description: `${pageQuestions.length} 题` },
    { title: '试扫核验', description: trial ? '已试扫' : '待核验' },
  ]

  return <div className="compatible-layout">
    <Card size="small" className="compatible-steps-card">
      <Steps size="small" current={step} onChange={goStep} items={stepItems} />
    </Card>
    <div className="compatible-workbench">
      <Card
        title={`步骤 ${step + 1} · ${stepItems[step].title}`}
        className="compatible-controls"
        extra={<Tag color={hasRectifiedPage ? 'green' : 'default'}>{page === 1 ? '正面' : '背面'}</Tag>}
      >
        {step === 0 && <>
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
            <Typography.Paragraph type="secondary" className="compatible-tools">
              先导入样张并完成灰度与矩形校正，再进入下一步标定定位块与自动识别答题区。
            </Typography.Paragraph>
            <Space wrap className="compatible-tools">
              <Upload accept={formats} multiple showUploadList={false} disabled={blocked}
                beforeUpload={(file, files) => { if (file.uid === files[0].uid) void run(() => importFiles(files)); return false }}>
                <Button type="primary" disabled={blocked}>{profile.mode === 'blank' ? '导入空白原稿' : combine ? '导入同面样张' : '导入样张'}</Button>
              </Upload>
              <Checkbox disabled={blocked} checked={applyGrayscale} onChange={e => setApplyGrayscale(e.target.checked)}>灰度光照校正</Checkbox>
              {profile.mode === 'completed' && <Checkbox disabled={blocked} checked={combine} onChange={e => setCombine(e.target.checked)}>合用同面样张</Checkbox>}
            </Space>
            {canAutoCorrect && <Space wrap className="compatible-tools">
              <Button disabled={blocked} onClick={() => void run(() => rectifyPage('auto'))}>自动灰度与矩形校正</Button>
              <Button disabled={blocked} onClick={() => { setTrial(undefined); setCorners([]); setPickingCorners(true) }}>手动标定四角</Button>
              <Button disabled={blocked} onClick={() => void run(async () => importFiles([new File([await (await fetch(correctingSource)).blob()], 'sample.jpg')], 2))}>旋转 180°</Button>
            </Space>}
            {correcting && <div className="compatible-panel-box">
              <Typography.Text strong>手动四角校正（{corners.length} / 4）</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 8px' }}>
                请按左上、右上、右下、左下顺序点击右侧原图纸角。
              </Typography.Paragraph>
              <Space wrap>
                <Button type="primary" disabled={blocked || corners.length !== 4} onClick={() => void run(() => rectifyPage('corners'))}>执行灰度与矩形校正</Button>
                <Button disabled={blocked || !corners.length} onClick={() => setCorners(prev => prev.slice(0, -1))}>撤销一点</Button>
                <Button disabled={blocked} onClick={() => setCorners([])}>重选四角</Button>
                {hasRectifiedPage && <Button disabled={blocked} onClick={() => { setCorners([]); setPickingCorners(false) }}>取消</Button>}
              </Space>
            </div>}
          </>}
          <div className="compatible-step-footer">
            <Button type="primary" disabled={!hasRectifiedPage || pickingCorners} onClick={() => goStep(1)}>下一步：标定定位块</Button>
          </div>
        </>}

        {step === 1 && <>
          <Typography.Paragraph type="secondary">
            每面需标定 4 至 8 个定位块（四角黑块尽量紧贴，避免框入虚线或边框，并至少保留 1 处含方向特征的印刷块）。定完 4 个角定位块后，可先执行「灰度与矩形校正」拉正整页，再进入自动识别。
          </Typography.Paragraph>
          {!readOnly && <>
            <Space wrap className="compatible-tools">
              {reference?.anchors?.length ? <Button disabled={blocked} onClick={() => applySuggestions('anchors')}>采用自动定位（{reference.anchors.length}）</Button> : null}
              <Button disabled={blocked || !image || !face.anchors.length} onClick={() => void run(() => reextractAnchorsFromCurrent(true))}>紧缩并重采样定位</Button>
              <Checkbox disabled={blocked} checked={applyGrayscale} onChange={e => setApplyGrayscale(e.target.checked)}>同步灰度校正</Checkbox>
            </Space>
            <div className="compatible-panel-box">
              <Typography.Text strong>基于定位块执行矩形校正</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 8px' }}>
                按当前 4 个角定位块消除透视倾斜并统一纸面灰度，随后在校正图上自动识别{anonymous ? '选项区' : statistics ? '考号和选项区' : '考号、客观题与主观题区域'}。
              </Typography.Paragraph>
              <Button type="primary" disabled={blocked || !image || face.anchors.length < 4} onClick={() => void run(() => rectifyPage('anchors'))}>
                按定位块灰度与矩形校正并自动识别
              </Button>
            </div>
            {face.anchors.length > 0 && <Space wrap size={[6, 6]} className="compatible-tools">
              {face.anchors.map((_, index) => {
                const isCur = activeMark?.kind === 'anchor' && activeMark.index === index
                return <Tag key={index} color={isCur ? 'orange' : 'purple'} closable={!blocked}
                  style={{ cursor: 'pointer' }}
                  onClick={() => { setMode('edit'); setActiveMark({ kind: 'anchor', index }) }}
                  onClose={e => { e.preventDefault(); setFace({ ...face, anchors: face.anchors.filter((__, i) => i !== index) }); if (isCur) setActiveMark(undefined) }}>
                  定位 {index + 1}
                </Tag>
              })}
            </Space>}
          </>}
          <div className="compatible-step-footer">
            <Button onClick={() => goStep(0)}>上一步</Button>
            <Button type="primary" disabled={face.anchors.length < 4} onClick={() => goStep(2)}>下一步：识别与框选</Button>
          </div>
        </>}

        {step === 2 && <>
          {!readOnly && <>
            <div className="compatible-panel-box">
              <Space wrap>
                <Button disabled={blocked || !image} onClick={() => void run(() => rectifyPage('detect'))}>在校正图上自动识别区域</Button>
                {!anonymous && page === 1 && <Button disabled={blocked || !reference?.candidate?.length} onClick={() => applySuggestions('candidate')}>
                  采用考号（{reference?.candidate?.length || 0}位）
                </Button>}
                <Button disabled={blocked || !reference?.choices?.length} onClick={() => applySuggestions('choices')}>
                  添加{statistics ? '选择题' : '客观题'}（{reference?.choices?.length || 0}）
                </Button>
                {!statistics && <Button disabled={blocked || !reference?.frames?.length} onClick={() => applySuggestions('frames')}>
                  添加主观题（{reference?.frames?.length || 0}）
                </Button>}
              </Space>
            </div>
            {mode === 'draw' ? <Space wrap className="compatible-tools">
              <Select aria-label="框选区域类型" value={activeDrawTool === 'anchor' ? 'choice' : activeDrawTool} disabled={blocked}
                options={regionTools.filter(item => (!statistics || item.value !== 'subjective') &&
                  ((!anonymous && page === 1) || !['candidate', 'absent'].includes(item.value)))}
                onChange={next => { setRegionTool(next); setAdjustCell(false) }} style={{ minWidth: 132 }} />
              {selected && <Button size="small" disabled={blocked} onClick={() => { setSelected(''); setAdjustCell(false) }}>取消选中（新建下一题）</Button>}
              {activeDrawTool === 'candidate' && <>
                <InputNumber aria-label="考号位数" min={1} max={20} value={value.candidate_length} disabled={blocked}
                  onChange={length => { if (length) change({ candidate_length: length }) }} />
                <Checkbox disabled={blocked} checked={reverse} onChange={e => setReverse(e.target.checked)}>反向数字顺序</Checkbox>
              </>}
              {activeDrawTool === 'choice' && <>
                <InputNumber aria-label="选项数量" min={statistics ? 2 : 3} max={statistics ? 26 : 7}
                  value={options} disabled={blocked} addonBefore="选项" style={{ width: 112 }}
                  onChange={n => {
                    setOptions(n ?? 4)
                    if (statistics) { setOptionRows((n ?? 4) > 13 ? 2 : 1); setChoiceBatchCount(1) }
                  }} />
                {statistics && !transpose && !adjustCell && <InputNumber aria-label="每题选项行数" min={1} max={Math.min(8, options)}
                  value={optionRows} disabled={blocked} addonBefore="选项行数" style={{ width: 130 }}
                  onChange={n => { setOptionRows(n ?? 1); setChoiceBatchCount(1) }} />}
                {!selected && !adjustCell && (transpose || optionRows === 1) && <InputNumber aria-label="批量题数" min={1} max={50} value={choiceBatchCount} disabled={blocked} addonBefore="连框题数" style={{ width: 132 }}
                  onChange={n => setChoiceBatchCount(n ?? 1)} />}
              </>}
              {activeDrawTool === 'subjective' && !!selectedQuestion && selectedQuestion.type === 'subjective' && <Checkbox disabled={blocked} checked={appendRegion}
                onChange={e => setAppendRegion(e.target.checked)}>追加同面续区</Checkbox>}
              {(activeDrawTool === 'candidate' || activeDrawTool === 'choice') && <Checkbox disabled={blocked} checked={transpose}
                onChange={e => setTranspose(e.target.checked)}>{activeDrawTool === 'candidate' ? '数字横向排列' : '选项竖向排列'}</Checkbox>}
              {((activeDrawTool === 'candidate' && !!face.candidate?.length)
                || (activeDrawTool === 'choice' && !!selectedQuestion?.external_options?.length)) && <>
                <Checkbox disabled={blocked} checked={adjustCell} onChange={e => { setAdjustCell(e.target.checked); setCellColumn(1) }}>重框单格</Checkbox>
                {adjustCell && <Select aria-label={activeDrawTool === 'candidate' ? '考号位' : '题目选项'} value={cellColumn}
                  options={Array.from({ length: activeDrawTool === 'candidate' ? face.candidate!.length : selectedQuestion!.options },
                    (_, i) => ({ label: activeDrawTool === 'candidate' ? `第 ${i + 1} 位` : String.fromCharCode(65 + i), value: i + 1 }))}
                  onChange={setCellColumn} />}
                {adjustCell && activeDrawTool === 'candidate' && <Select aria-label="数字" value={cellDigit}
                  options={Array.from({ length: 10 }, (_, digit) => ({ value: digit, label: `数字 ${digit}` }))} onChange={setCellDigit} />}
              </>}
              {activeDrawTool === 'absent' && face.absent && <Button disabled={blocked} onClick={() => setFace({ ...face, absent: undefined })}>清除缺考格</Button>}
            </Space> : <Alert className="compatible-tools" showIcon type="info"
              message="当前为「移动 / 调整」模式"
              description="点击画布上的任意标记可拖动位置或拖拽边角控制点缩放，方向键可微调坐标；如需新建标记，请切换回「框选标记」。" />}
          </>}
          <div className="compatible-tools">
            <Tag>定位 {face.anchors.length}</Tag>
            {!anonymous && page === 1 && <Tag color={face.candidate?.length && face.candidate.length !== value.candidate_length ? 'orange' : undefined}>
              考号 {face.candidate?.length || 0} / {value.candidate_length} 位
            </Tag>}
            <Tag>本面 {pageQuestions.length} 题</Tag>
          </div>
          <div className="compatible-questions">
            {pageQuestions.map(q => <div key={q.id} className="compatible-question">
              <Button type={selected === q.id ? 'primary' : 'default'} onClick={() => {
                const nextSelected = selected === q.id ? '' : q.id
                setSelected(nextSelected)
                if (nextSelected) {
                  setRegionTool(q.type === 'subjective' ? 'subjective' : 'choice')
                  setOptions(q.options)
                  setOptionRows(statistics && q.options > 13 ? 2 : 1)
                  setAdjustCell(false)
                  const regionIndex = q.regions.findIndex(r => r.page === page)
                  if (regionIndex >= 0) setActiveMark({ kind: 'question', id: q.id, regionIndex })
                } else {
                  setActiveMark(undefined)
                }
              }}>第 {q.number} 题</Button>
              <InputNumber aria-label={`第 ${q.number} 题题号`} disabled={blocked} min={1} value={q.number}
                onChange={number => { if (number && !value.questions.some(other => other.id !== q.id && other.number === number)) questionUpdate(q.id, { number }) }} />
              {statistics ? <>
                <Select size="small" aria-label={'第 '+q.number+' 题题型'} disabled={blocked} value={q.type}
                  options={[{ value: 'single', label: '单选' }, { value: 'multiple', label: '多选' }]}
                  onChange={type => questionUpdate(q.id, { type })} />
                <Input size="small" aria-label={'第 '+q.number+' 题说明'} disabled={blocked} maxLength={64}
                  placeholder="题目说明" value={q.title || ''} onChange={e => questionUpdate(q.id, { title: e.target.value })} />
              </> : <>
                <InputNumber aria-label={'第 '+q.number+' 题分值'} disabled={blocked} value={q.points} min={.01} precision={2}
                  onChange={points => { if (points) questionUpdate(q.id, { points }) }} />
                <Button disabled={blocked} onClick={() => settings(q.id)}>设置</Button>
              </>}
              <Button disabled={blocked} danger onClick={() => {
                if (selected === q.id) setSelected('')
                if (activeMark && (activeMark.kind === 'question' || activeMark.kind === 'choice-cell') && activeMark.id === q.id) setActiveMark(undefined)
                change({ questions: value.questions.filter(other => other.id !== q.id) })
                setTrial(undefined)
              }}>删除</Button>
            </div>)}
          </div>
          <div className="compatible-step-footer">
            <Button onClick={() => goStep(1)}>上一步</Button>
            <Button type="primary" onClick={() => goStep(3)}>下一步：试扫核验</Button>
          </div>
        </>}

        {step === 3 && <>
          <Typography.Paragraph type="secondary">
            上传一张实扫答卷或使用当前样张进行试扫，确认定位和{anonymous ? '选项' : '考号及选项'}识读准确后即可发布题卡。
          </Typography.Paragraph>
          {!readOnly && <Space wrap className="compatible-tools">
            <Upload accept={formats} showUploadList={false} disabled={blocked}
              beforeUpload={file => { void run(() => tryScan(file)); return false }}>
              <Button type="primary" disabled={blocked}>上传本面试扫件</Button>
            </Upload>
            {canAutoCorrect && <Button disabled={blocked} onClick={() => void run(async () => tryScan(await (await fetch(reference?.source || savedArt)).blob()))}>
              使用当前样张试扫
            </Button>}
          </Space>}
          <div className="compatible-tools">
            <Tag color={face.anchors.length >= 4 ? 'green' : 'orange'}>定位块 {face.anchors.length}</Tag>
            {!anonymous && page === 1 && <Tag color={face.candidate?.length === value.candidate_length ? 'green' : 'orange'}>考号 {face.candidate?.length || 0}/{value.candidate_length} 位</Tag>}
            <Tag>本面 {pageQuestions.length} 题</Tag>
          </div>
          <div className="compatible-step-footer">
            <Button onClick={() => goStep(2)}>返回调整区域</Button>
          </div>
        </>}
      </Card>

      <Card
        title={correcting ? '原图四角校正' : trial ? '试扫自动校正预览' : readOnly ? '题卡预览' : '标定画布'}
        extra={<Space wrap size={6}>
          {!readOnly && !correcting && !trial && (step === 1 || step === 2) && <>
            <Segmented size="small" value={mode} onChange={val => { setMode(val as InteractionMode); setDrag(undefined); setEditDrag(undefined) }}
              options={[{ value: 'draw', label: '框选标记' }, { value: 'edit', label: '移动 / 调整' }]} />
            {mode === 'edit' && step === 2 && <Checkbox checked={editGranularCell} onChange={e => { setEditGranularCell(e.target.checked); setActiveMark(undefined) }}>微调单格</Checkbox>}
          </>}
          <Button size="small" icon={<ZoomOutOutlined />} aria-label="缩小画布" disabled={!showCanvas || zoom <= 50} onClick={() => setZoom(z => Math.max(50, z - 25))} />
          <Button size="small" disabled={!showCanvas} onClick={() => setZoom(100)}>{zoom}%</Button>
          <Button size="small" icon={<ZoomInOutlined />} aria-label="放大画布" disabled={!showCanvas || zoom >= 250} onClick={() => setZoom(z => Math.min(250, z + 25))} />
          <Select aria-label="纸面" value={page} disabled={busy} onChange={switchPage}
            options={[{ value: 1, label: '正面' }, ...(value.sides === 2 ? [{ value: 2, label: '背面' }] : [])]} />
        </Space>}
      >
        {(error || reference?.error) && <Alert className="compatible-tools" showIcon type="warning" message={error || reference?.error} />}
        {notice && <Alert className="compatible-tools" showIcon type="info" message={notice} closable onClose={() => setNotice('')} />}
        {canEditOnCanvas && activeMark && activeBox && <div className="compatible-selection-bar">
          <Space wrap size={8}>
            <Tag color="orange">{markLabel(activeMark)}</Tag>
            <Typography.Text type="secondary">
              X {activeBox.x} · Y {activeBox.y} · {activeBox.width} × {activeBox.height} mm（可用方向键微调）
            </Typography.Text>
            {activeMark.kind !== 'candidate-cell' && activeMark.kind !== 'choice-cell' && <Button size="small" danger onClick={() => deleteActiveMark(activeMark)}>删除此标记</Button>}
            <Button size="small" onClick={() => setActiveMark(undefined)}>取消选中</Button>
          </Space>
        </div>}
        {trial && <Alert className="compatible-tools" showIcon type="success" message="请核对本面试扫结果（当前显示自动校正图）"
          description={<div>{!anonymous && page === 1 && <div>考号 {trial.candidate || '未识读'}{trial.absent ? ' · 缺考' : ''}</div>}
            {Object.entries(trial.selections).map(([id, choices]) => <Tag key={id}>第 {value.questions.find(q => q.id === id)?.number} 题 {choices.join('') || '空白'}</Tag>)}</div>}
          action={<Space direction="vertical" size={6}>
            {!readOnly && !(statistics && profile.mode === 'blank') && <Button type="primary" size="small" disabled={blocked} onClick={() => void run(() => adoptCorrectedImage(trial.image, '已引用自动校正图作为当前底图，可继续框选或微调区域'))}>引用此校正图继续框选</Button>}
            <Button size="small" onClick={() => setTrial(undefined)}>返回标定</Button>
          </Space>} />}
        {showCanvas ? <div className="compatible-canvas-viewport"><div className="compatible-canvas" style={{ aspectRatio: `${width}/${height}`, width: `${zoom}%`, maxWidth: zoom > 100 ? 'none' : 920 }}>
          {image && <img ref={imgRef} src={image} alt={correcting ? '待校正原图' : '当前纸面'} draggable={false}
            onLoad={event => { if (correcting) setRawSize([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight]) }} />}
          <svg role="img" aria-label="题卡标定区域" viewBox={`0 0 ${width} ${height}`}
            className={correcting || canDrawOnCanvas ? 'compatible-draw' : canEditOnCanvas ? 'compatible-edit' : ''}
            onPointerDown={event => {
              if (blocked || trial) return
              if (correcting) { if (corners.length < 4) setCorners([...corners, point(event)]); return }
              if (canEditOnCanvas) { setActiveMark(undefined); return }
              if (!canDrawOnCanvas) return
              drawStart.current = point(event)
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={event => {
              if (drawStart.current) {
                setDrag(rectangle(drawStart.current, point(event)))
                return
              }
              if (editDrag) {
                const cur = point(event)
                const dx = cur[0] - editDrag.origin[0], dy = cur[1] - editDrag.origin[1]
                const minSize = editDrag.mark.kind === 'anchor' ? 3 : 1.2
                setEditDrag({ ...editDrag, currentBox: applyDragDelta(editDrag.initialBox, editDrag.action, dx, dy, width, height, minSize) })
              }
            }}
            onPointerCancel={() => { setDrag(undefined); drawStart.current = null; setEditDrag(undefined) }}
            onPointerUp={event => {
              if (drawStart.current) {
                const box = rectangle(drawStart.current, point(event))
                drawStart.current = null
                setDrag(undefined)
                finishBox(box)
                return
              }
              if (editDrag) {
                const { mark, initialBox, currentBox } = editDrag
                setEditDrag(undefined)
                if (initialBox.x !== currentBox.x || initialBox.y !== currentBox.y || initialBox.width !== currentBox.width || initialBox.height !== currentBox.height) {
                  commitMarkBox(mark, currentBox, true)
                }
              }
            }}>
            {correcting ? <>
              {corners.length > 1 && <polyline points={(corners.length === 4 ? [...corners, corners[0]] : corners).map(([cx, cy]) => `${cx},${cy}`).join(' ')} className="compatible-corners-poly" />}
              {corners.map(([cx, cy], index) => <g key={index}><circle cx={cx} cy={cy} r={Math.max(width, height) / 120} />
                <text x={cx + Math.max(width, height) / 100} y={cy} fontSize={Math.max(width, height) / 45}>{index + 1}</text></g>)}
            </> : <>
              {marks.map(({ key, box, kind, label, mark }) => <g key={key}>
                <rect {...box}
                  className={`compatible-mark-${kind}${canEditOnCanvas && mark ? ' compatible-mark-interactive' : ''}`}
                  onPointerDown={canEditOnCanvas && mark ? event => startEditDrag(event, mark, 'move') : undefined}
                />
                {label && <text x={box.x + 0.45} y={box.y + Math.min(box.height - 0.3, 2.8)} className={`compatible-label compatible-label-${kind}`}>{label}</text>}
              </g>)}
              {canEditOnCanvas && activeMark && activeBox && handles.map(h => {
                const size = 2.1
                return <rect key={h.id} x={h.cx(activeBox) - size / 2} y={h.cy(activeBox) - size / 2} width={size} height={size}
                  className="compatible-handle" style={{ cursor: h.cursor }}
                  onPointerDown={event => startEditDrag(event, activeMark, h.id)} />
              })}
            </>}
            {drag && <rect {...drag} className="compatible-mark-selected" />}
          </svg>
        </div></div> : <Empty description={readOnly ? '已保存题区与扫描定位配置' : '请先在左侧步骤 1 导入该面的空白原稿或扫描样张'} />}
      </Card>
    </div>
  </div>
}
