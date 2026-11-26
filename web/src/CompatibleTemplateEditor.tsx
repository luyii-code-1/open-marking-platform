import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { CopyOutlined, DownloadOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons'
import { Alert, App, Card, Checkbox, Empty, Form, Input, InputNumber, Modal, Radio, Select, Space, Steps, Switch, Tag, Typography, Upload } from 'antd'
import { Button } from './Button'
import { newQuestion, request, requestBlob, type ExternalAnchor, type ExternalPage, type ImageBox, type Question, type Row, type Template } from './api'
import { buildCompatibleAiPrompt, exportCompatibleToAiJson, parseCompatibleAiJson, type ParsedAiLayout } from './compatibleAiJson'
import './compatible-template.css'

type Point = [number, number]
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
type Reference = {
  source: string
  image?: string
  error?: string
  anchors: ExternalAnchor[]
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
  value: Template
  disabled: boolean
  readOnly: boolean
  change: (patch: Partial<Template>) => void
  flush: () => Promise<Template>
  settings: (id: string) => void
}

export function CompatibleTemplateEditor({ value, disabled, readOnly, change, flush, settings }: Props) {
  const profile = value.external_sheet!
  const legacyStatistics = value.statistics_sheet === true
  const statistics = legacyStatistics || value.statistics_mode === true
  const anonymous = legacyStatistics || (statistics && value.candidate_enabled === false)

  const [page, setPage] = useState(1)
  const [step, setStep] = useState(() => {
    if (readOnly || value.questions.length > 0 || (profile.pages['1']?.anchors.length ?? 0) >= 4) return 1
    return value.background_assets?.['1'] ? 1 : 0
  })
  const [pickingCorners, setPickingCorners] = useState(false)
  const [applyGrayscale, setApplyGrayscale] = useState(true)
  const [refs, setRefs] = useState<Record<number, Reference>>({})
  const [savedArt, setSavedArt] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [combine, setCombine] = useState(false)
  const [activeMark, setActiveMark] = useState<ActiveMark>()
  const [editGranularCell, setEditGranularCell] = useState(false)
  const [trial, setTrial] = useState<Trial>()
  const [rawSize, setRawSize] = useState<Point>([1, 1])
  const [corners, setCorners] = useState<Point[]>([])
  const [zoom, setZoom] = useState(100)
  const [editDrag, setEditDrag] = useState<EditDrag>()
  const [aiJsonText, setAiJsonText] = useState('')
  const [aiImportMode, setAiImportMode] = useState<'replace' | 'append'>('replace')
  const [aiScopes, setAiScopes] = useState<string[]>(['anchors', 'candidate', 'absent', 'choices', 'subjective'])
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const { message } = App.useApp()

  const face = profile.pages[String(page)] ?? { anchors: [] }
  const reference = refs[page]
  const correctingSource = reference?.source || savedArt
  const correcting = pickingCorners && !!correctingSource
  const dimensions: Point = value.paper === 'A3' ? [420, 297] : [210, 297]
  const [width, height] = correcting ? rawSize : dimensions
  const image = correcting ? correctingSource : trial?.image || reference?.image || savedArt
  const asset = value.background_assets?.[String(page)]
  const blocked = disabled || readOnly || busy
  const endpoint = `/groups/${value.group_id}/compatible`
  const canEditOnCanvas = !blocked && !trial && !correcting && step === 1

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
    let nextPages = { ...profile.pages }
    for (let i = 0; i < result.pages.length; i++) {
      const sheet = { ...result.pages[i], rectified: !!result.pages[i].image }
      const n = page + i
      next[n] = opts?.preserveSource && i === 0 ? { ...sheet, source: opts.preserveSource } : sheet
      if (sheet.image && profile.mode === 'blank') {
        assets = (await saveBlankAsset(sheet.image, n, assets)) || assets
      }
      // Pre-populate auto-detected tight corner anchors if that face has none yet.
      if (sheet.anchors?.length >= 4 && !(nextPages[String(n)]?.anchors?.length)) {
        nextPages = { ...nextPages, [String(n)]: { ...(nextPages[String(n)] ?? { anchors: [] }), anchors: sheet.anchors } }
      }
    }
    setRefs(next)
    setTrial(undefined)
    setCorners([])
    setActiveMark(undefined)
    const hasErr = !!next[page]?.error
    setPickingCorners(hasErr)
    change({
      ...(profile.mode === 'blank' ? { background_assets: assets } : {}),
      external_sheet: { ...profile, pages: nextPages },
    })
    if (!hasErr) {
      setStep(opts?.targetStep ?? 1)
      setNotice('已完成灰度与矩形校正，可直接下载校正图并复制 AI 提示词发给外部 AI。')
    }
  }

  async function adoptCorrectedImage(sourceImage: string, successText: string) {
    const blob = await (await fetch(sourceImage)).blob()
    const file = new File([blob], 'corrected.png', { type: blob.type || 'image/png' })
    await importFiles([file], 0, undefined, {
      alreadyCorrected: true,
      preserveSource: reference?.source || sourceImage,
      targetStep: 1,
      grayscale: true,
    })
    setNotice(successText)
  }

  async function rectifyPage(kind: 'auto' | 'corners' | 'anchors') {
    const sourceUrl = kind === 'anchors' ? (reference?.image || savedArt) : (reference?.source || savedArt)
    if (!sourceUrl) return
    const blob = await (await fetch(sourceUrl)).blob()
    const body = new FormData()
    body.append('file', blob, kind === 'anchors' ? 'page.png' : 'sample.jpg')
    body.append('paper', value.paper)
    body.append('apply_grayscale', String(applyGrayscale))
    body.append('detect_regions', 'false')
    if (kind === 'corners') {
      body.append('corners', JSON.stringify(corners))
    } else if (kind === 'anchors') {
      body.append('anchors', JSON.stringify(face.anchors.map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }))))
    }
    const result = await request<{ image: string; anchors: ExternalAnchor[] }>(endpoint + '/rectify', { method: 'POST', body })
    const updatedRef: Reference = {
      source: reference?.source || sourceUrl,
      image: result.image,
      anchors: result.anchors,
      rectified: true,
    }
    setRefs(prev => ({ ...prev, [page]: updatedRef }))
    setTrial(undefined)
    setCorners([])
    setPickingCorners(false)
    setActiveMark(undefined)
    const nextAssets = profile.mode === 'blank' ? await saveBlankAsset(result.image, page) : undefined
    const nextAnchors = kind === 'anchors' || !face.anchors.length ? result.anchors : face.anchors
    change({
      ...(nextAssets ? { background_assets: nextAssets } : {}),
      external_sheet: { ...profile, pages: { ...profile.pages, [page]: { ...face, anchors: nextAnchors } } },
    })
    setStep(1)
    setNotice('已完成灰度与矩形校正，可下载当前校正图发给外部 AI 或直接粘贴 JSON 导入。')
  }

  async function sampleSingleAnchor(box: ImageBox, replaceIndex: number) {
    if (!image) return
    const blob = await (await fetch(image)).blob()
    const body = new FormData()
    body.append('file', blob, 'anchor.png')
    body.append('paper', value.paper)
    body.append('box', JSON.stringify(box))
    body.append('tighten', 'false')
    const sampled = await request<ExternalAnchor>(endpoint + '/anchor', { method: 'POST', body })
    setFace({ ...face, anchors: face.anchors.map((a, idx) => idx === replaceIndex ? sampled : a) })
  }

  function commitMarkBox(mark: ActiveMark, nextBox: ImageBox, syncAnchorPattern = true) {
    if (mark.kind === 'anchor') {
      const existing = face.anchors[mark.index]
      if (!existing) return
      const nextAnchors = face.anchors.map((a, idx) => idx === mark.index ? { ...a, ...nextBox } : a)
      setFace({ ...face, anchors: nextAnchors })
      if (syncAnchorPattern && image) {
        void run(() => sampleSingleAnchor(nextBox, mark.index))
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

  function goStep(nextStep: number) {
    setTrial(undefined)
    setPickingCorners(false)
    setCorners([])
    setActiveMark(undefined)
    setStep(nextStep)
  }

  function switchPage(next: number) {
    setPage(next)
    setTrial(undefined)
    setCorners([])
    setPickingCorners(false)
    setActiveMark(undefined)
    setNotice('')
    setAiJsonText('')
    setStep(refs[next]?.image || value.background_assets?.[String(next)] ? 1 : 0)
  }

  async function tryScan(file: Blob) {
    if (image && !readOnly && face.anchors.length >= 4) {
      const avoid: ImageBox[] = [
        ...(face.candidate?.length ? [enclosing(face.candidate.flat())] : []),
        ...(face.absent ? [face.absent] : []),
        ...pageQuestions.flatMap(q => q.regions.filter(r => r.page === page).map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }))),
      ]
      const blob = await (await fetch(image)).blob()
      const checkBody = new FormData()
      checkBody.append('file', blob, 'page.png')
      checkBody.append('paper', value.paper)
      checkBody.append('tighten', 'false')
      checkBody.append('lenient', 'true')
      checkBody.append('ensure_distinctive', 'true')
      checkBody.append('avoid_boxes', JSON.stringify(avoid))
      checkBody.append('boxes', JSON.stringify(face.anchors.map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }))))
      const ensured = await request<{ anchors: ExternalAnchor[]; distinctive_added?: boolean }>(endpoint + '/reextract-anchors', { method: 'POST', body: checkBody })
      if (ensured.distinctive_added) {
        change({ external_sheet: { ...profile, pages: { ...profile.pages, [page]: { ...face, anchors: ensured.anchors } } } })
        setNotice('已自动补充 1 处辨别版式与方向的固定印刷参照')
      }
    }
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
  const candidateEnvelope = !anonymous && face.candidate?.length ? enclosing(face.candidate.flat()) : undefined
  const activeBox = editDrag ? editDrag.currentBox : (activeMark ? getMarkBox(activeMark) : undefined)
  const canAutoCorrect = !!(reference?.source || savedArt)
  const hasRectifiedPage = !!(reference?.image || savedArt)

  const nextQuestionNumber = Math.max(0, ...value.questions.map(q => q.number)) + 1
  const aiContext = useMemo(() => ({
    paper: value.paper,
    page,
    sides: value.sides,
    statistics,
    anonymous,
    candidateLength: value.candidate_length || 9,
    nextQuestionNumber,
    sheetName: value.name,
  }), [value.paper, page, value.sides, statistics, anonymous, value.candidate_length, nextQuestionNumber, value.name])
  const aiPromptText = useMemo(() => buildCompatibleAiPrompt(aiContext), [aiContext])
  const aiParsed = useMemo<{ layout?: ParsedAiLayout; error?: string }>(() => {
    if (!aiJsonText.trim()) return {}
    try {
      return { layout: parseCompatibleAiJson(aiJsonText, aiContext) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }, [aiJsonText, aiContext])

  async function copyTextToClipboard(text: string, okMsg: string) {
    try {
      await navigator.clipboard.writeText(text)
      message.success(okMsg)
    } catch {
      setPromptPreviewOpen(true)
      message.info('请直接全选复制弹窗中的内容')
    }
  }

  function downloadRectifiedImage() {
    if (!image) return
    const link = document.createElement('a')
    link.href = image
    link.download = `${(value.name || '题卡').trim()}-第${page}面-校正图.png`
    document.body.appendChild(link)
    link.click()
    link.remove()
    message.success('已下载当前校正基准图，请连同提示词发给外部 AI')
  }

  async function applyAiJsonImport() {
    const layout = aiParsed.layout
    if (!layout) return
    const scopeSet = new Set(aiScopes)
    let nextFace: ExternalPage = { ...face }
    let nextCandidateLength = value.candidate_length
    const summary: string[] = []
    const extraNotes: string[] = []

    const avoidBoxes: ImageBox[] = [
      ...(layout.candidate?.length ? [enclosing(layout.candidate.flat())] : (face.candidate?.length ? [enclosing(face.candidate.flat())] : [])),
      ...(layout.absent ? [layout.absent] : (face.absent ? [face.absent] : [])),
      ...layout.choices.map(c => c.region),
      ...layout.subjective.flatMap(s => s.regions),
    ]

    if (image) {
      const candidateAnchors = scopeSet.has('anchors') && layout.anchors.length > 0
        ? (aiImportMode === 'replace' ? layout.anchors : [...face.anchors.map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h })), ...layout.anchors].slice(0, 8))
        : face.anchors.map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }))
      const blob = await (await fetch(image)).blob()
      const body = new FormData()
      body.append('file', blob, 'page.png')
      body.append('paper', value.paper)
      body.append('tighten', String(scopeSet.has('anchors') && layout.anchors.length > 0))
      body.append('lenient', 'true')
      body.append('ensure_distinctive', 'true')
      body.append('avoid_boxes', JSON.stringify(avoidBoxes))
      body.append('boxes', JSON.stringify(candidateAnchors))
      const sampled = await request<{ anchors: ExternalAnchor[]; skipped?: number; distinctive_added?: boolean }>(endpoint + '/reextract-anchors', { method: 'POST', body })
      if (sampled.anchors.length > 0) {
        nextFace = { ...nextFace, anchors: sampled.anchors }
        summary.push(`定位块 ${sampled.anchors.length} 个`)
      }
      if (sampled.distinctive_added) {
        extraNotes.push('已自动添加 1 处辨别版式与方向的固定印刷参照')
      }
      if (sampled.skipped) {
        extraNotes.push(`${sampled.skipped} 个空白或重复定位框已自动忽略`)
      }
    } else if (scopeSet.has('anchors') && layout.anchors.length > 0) {
      extraNotes.push('尚未导入校正底图，已先导入题目与考号，定位块将在导入底图后自动补齐')
    }

    if (scopeSet.has('candidate') && !anonymous && page === 1 && layout.candidate?.length) {
      nextFace = { ...nextFace, candidate: layout.candidate }
      if (layout.candidateLength) nextCandidateLength = layout.candidateLength
      summary.push(`考号 ${layout.candidate.length} 位`)
    }

    if (scopeSet.has('absent') && !statistics && page === 1 && layout.absent) {
      nextFace = { ...nextFace, absent: layout.absent }
      summary.push('缺考格')
    }

    let nextQuestions = [...value.questions]
    const importingChoices = scopeSet.has('choices') && layout.choices.length > 0
    const importingSubjective = !statistics && scopeSet.has('subjective') && layout.subjective.length > 0

    if (aiImportMode === 'replace' && (importingChoices || importingSubjective)) {
      nextQuestions = nextQuestions.flatMap(q => {
        const isSub = q.type === 'subjective'
        if ((isSub && !importingSubjective) || (!isSub && !importingChoices)) return [q]
        const remaining = q.regions.filter(r => r.page !== page)
        return remaining.length ? [{ ...q, regions: remaining }] : []
      })
    }

    const usedNumbers = new Set(nextQuestions.map(q => q.number))
    const takeNumber = (preferred: number) => {
      let n = Math.max(1, preferred)
      while (usedNumbers.has(n)) n++
      usedNumbers.add(n)
      return n
    }

    if (importingChoices) {
      const additions: Question[] = layout.choices.map(item => {
        const num = takeNumber(item.number)
        return {
          ...newQuestion(num),
          type: item.type,
          options: item.options,
          points: statistics ? 0 : item.points,
          title: item.title,
          answer: [],
          external_options: item.cells,
          regions: [{ page, ...item.region }],
        }
      })
      nextQuestions = [...nextQuestions, ...additions]
      summary.push(`${statistics ? '选择题' : '客观题'} ${additions.length} 题`)
    }

    if (importingSubjective) {
      const additions: Question[] = layout.subjective.map(item => {
        const num = takeNumber(item.number)
        return {
          ...newQuestion(num),
          type: 'subjective',
          points: item.points,
          regions: item.regions.map(r => ({ page, ...r })),
        }
      })
      nextQuestions = [...nextQuestions, ...additions]
      summary.push(`主观题 ${additions.length} 题`)
    }

    change({
      candidate_length: nextCandidateLength,
      external_sheet: { ...profile, pages: { ...profile.pages, [page]: nextFace } },
      questions: nextQuestions,
    })
    setTrial(undefined)
    setActiveMark(undefined)
    setNotice(
      `已导入：${summary.join('、') || '无新增区域'}${extraNotes.length ? `（${extraNotes.join('；')}）` : ''}。可在右侧画布点击任意标记微调位置。`,
    )
  }

  type RenderMark = { key: string; box: ImageBox; kind: string; label?: string; mark?: ActiveMark }
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
    ...(!anonymous ? (face.candidate ?? []) : []).flatMap((col, cIndex) => col.map((box, dIndex) => {
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
    ...(!statistics && face.absent ? [{
      key: 'absent',
      box: editDrag && sameMark(editDrag.mark, { kind: 'absent' }) ? editDrag.currentBox : face.absent,
      kind: sameMark(activeMark, { kind: 'absent' }) ? 'selected' : 'absent',
      label: '缺考',
      mark: { kind: 'absent' } as ActiveMark,
    }] : []),
    ...pageQuestions.flatMap(q => q.regions.map((r, regionIndex) => ({ r, regionIndex })).filter(({ r }) => r.page === page).map(({ r, regionIndex }, visIdx) => {
      const qMark: ActiveMark = { kind: 'question', id: q.id, regionIndex }
      const b = editDrag && sameMark(editDrag.mark, qMark) ? editDrag.currentBox : r
      return {
        key: `q-${q.id}-${regionIndex}`,
        box: b,
        kind: sameMark(activeMark, qMark) ? 'selected' : 'question',
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

  const showCanvas = !!image || marks.length > 0
  const stepItems = [
    { title: '导入与校正底图', description: hasRectifiedPage ? '已就绪' : '待导入' },
    { title: 'AI 识别与 JSON 导入', description: `${pageQuestions.length} 题` },
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
            {statistics && !legacyStatistics && <Form.Item label="准考证号">
              <Space>
                <Switch checked={!anonymous} disabled={blocked} aria-label="启用准考证号"
                  onChange={candidate_enabled => { change({ candidate_enabled }); setActiveMark(undefined); setTrial(undefined) }} />
                <Typography.Text type="secondary">{anonymous ? '每张入库题卡计一份' : '扫描时按考号匹配应考名单'}</Typography.Text>
              </Space>
            </Form.Item>}
            <Space wrap>
              <Select aria-label="纸型" disabled={blocked || !!value.questions.length || !!Object.keys(refs).length || !!Object.keys(profile.pages).length}
                value={value.paper} onChange={paper => change({ paper })} options={[{ value: 'A4', label: 'A4 纵向' }, { value: 'A3', label: 'A3 横向' }]} />
              <Select aria-label="面数" disabled={blocked || !!Object.keys(refs).length || !!Object.keys(profile.pages).length}
                value={value.sides} onChange={sides => { change({ sides }); switchPage(1) }} options={[{ value: 1, label: '单面' }, { value: 2, label: '双面' }]} />
              {!anonymous && <InputNumber aria-label="考号位数" min={1} max={20} value={value.candidate_length} disabled={blocked} addonBefore="考号位数" style={{ width: 136 }}
                onChange={length => { if (length) change({ candidate_length: length }) }} />}
            </Space>
          </Form>
          {!readOnly && <>
            <Typography.Paragraph type="secondary" className="compatible-tools">
              先导入空白原稿或样张并完成灰度与矩形校正，再进入下一步复制提示词给外部 AI 生成 JSON。
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
            <Button type="primary" disabled={!hasRectifiedPage || pickingCorners} onClick={() => goStep(1)}>下一步：AI 识别与 JSON 导入</Button>
          </div>
        </>}

        {step === 1 && <>
          {!readOnly && <>
            <div className="compatible-panel-box">
              <Typography.Text strong>1. 发送校正图与提示词给外部 AI</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 8px' }}>
                AI 会先发给您一份「识别概要」供核对，确认无误后再输出 JSON，确保题号、选项和区域完整准确。
              </Typography.Paragraph>
              <Space wrap>
                <Button icon={<DownloadOutlined />} disabled={blocked || !image} onClick={downloadRectifiedImage}>
                  下载当前校正图
                </Button>
                <Button type="primary" icon={<CopyOutlined />} disabled={blocked} onClick={() => void copyTextToClipboard(aiPromptText, '已复制 AI 识别提示词')}>
                  复制 AI 提示词
                </Button>
                <Button size="small" type="link" onClick={() => setPromptPreviewOpen(true)}>查看提示词</Button>
                <Button size="small" type="link" disabled={!marks.length} onClick={() => void copyTextToClipboard(exportCompatibleToAiJson(value, page), '已复制当前面 JSON，可发给 AI 微调')}>
                  导出当前 JSON
                </Button>
              </Space>
            </div>

            <div className="compatible-panel-box">
              <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 6 }}>
                <Typography.Text strong>2. 粘贴 AI 返回的 JSON</Typography.Text>
                {aiJsonText && <Button size="small" type="link" onClick={() => setAiJsonText('')}>清空</Button>}
              </Space>
              <Input.TextArea
                rows={7}
                disabled={blocked}
                value={aiJsonText}
                onChange={e => setAiJsonText(e.target.value)}
                placeholder='将 AI 确认后返回的 JSON（支持直接粘贴整段带 ```json 代码块的回复）粘贴到此处…'
                style={{ fontFamily: 'monospace' }}
              />
              {aiParsed.error && <Alert style={{ marginTop: 8 }} type="error" showIcon message={aiParsed.error} />}
              {aiParsed.layout && <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                <Space wrap size={[6, 6]}>
                  <Tag color="purple">定位块 {aiParsed.layout.anchors.length}</Tag>
                  {!anonymous && page === 1 && <Tag color="green">考号 {aiParsed.layout.candidate ? `${aiParsed.layout.candidate.length}位` : '无'}</Tag>}
                  {!statistics && page === 1 && <Tag color="green">缺考 {aiParsed.layout.absent ? '有' : '无'}</Tag>}
                  <Tag color="blue">{statistics ? '选择题' : '客观题'} {aiParsed.layout.choices.length} 题</Tag>
                  {!statistics && <Tag color="blue">主观题 {aiParsed.layout.subjective.length} 题</Tag>}
                </Space>
                {aiParsed.layout.warnings.length > 0 && <Alert type="warning" showIcon message={aiParsed.layout.warnings.join('；')} />}
                <Radio.Group size="small" value={aiImportMode} onChange={e => setAiImportMode(e.target.value)}>
                  <Radio value="replace">替换本面同类区域</Radio>
                  <Radio value="append">保留现有并追加</Radio>
                </Radio.Group>
                <Checkbox.Group
                  value={aiScopes}
                  onChange={vals => setAiScopes(vals.map(String))}
                  options={[
                    { label: `定位块(${aiParsed.layout.anchors.length})`, value: 'anchors', disabled: !aiParsed.layout.anchors.length },
                    ...(!anonymous && page === 1 ? [{ label: `考号(${aiParsed.layout.candidate?.length || 0}位)`, value: 'candidate', disabled: !aiParsed.layout.candidate?.length }] : []),
                    ...(!statistics && page === 1 ? [{ label: '缺考', value: 'absent', disabled: !aiParsed.layout.absent }] : []),
                    { label: `${statistics ? '选择题' : '客观题'}(${aiParsed.layout.choices.length})`, value: 'choices', disabled: !aiParsed.layout.choices.length },
                    ...(!statistics ? [{ label: `主观题(${aiParsed.layout.subjective.length})`, value: 'subjective', disabled: !aiParsed.layout.subjective.length }] : []),
                  ]}
                />
                <Button type="primary" block loading={busy} onClick={() => void run(applyAiJsonImport)}>
                  导入并生成题卡区域
                </Button>
              </Space>}
            </div>
          </>}

          <div className="compatible-tools">
            <Space wrap size={[6, 6]}>
              <Tag color={face.anchors.length >= 4 ? 'purple' : 'orange'}>定位块 {face.anchors.length}</Tag>
              {!anonymous && page === 1 && <Tag color={face.candidate?.length === value.candidate_length ? 'green' : 'orange'}>
                考号 {face.candidate?.length || 0} / {value.candidate_length} 位
              </Tag>}
              <Tag color="blue">本面 {pageQuestions.length} 题</Tag>
              {!readOnly && face.anchors.length >= 4 && !!image && <Button size="small" disabled={blocked} onClick={() => void run(() => rectifyPage('anchors'))}>按定位块再拉正</Button>}
            </Space>
          </div>

          <div className="compatible-questions">
            {pageQuestions.map(q => <div key={q.id} className="compatible-question">
              <Button type={activeMark?.kind === 'question' && activeMark.id === q.id ? 'primary' : 'default'} onClick={() => {
                const regionIndex = q.regions.findIndex(r => r.page === page)
                if (regionIndex >= 0) setActiveMark({ kind: 'question', id: q.id, regionIndex })
              }}>第 {q.number} 题</Button>
              <InputNumber aria-label={`第 ${q.number} 题题号`} disabled={blocked} min={1} value={q.number}
                onChange={number => { if (number && !value.questions.some(other => other.id !== q.id && other.number === number)) questionUpdate(q.id, { number }) }} />
              {statistics ? <>
                <Select size="small" aria-label={`第 ${q.number} 题题型`} disabled={blocked} value={q.type}
                  options={[{ value: 'single', label: '单选' }, { value: 'multiple', label: '多选' }]}
                  onChange={type => questionUpdate(q.id, { type })} />
                <Input size="small" aria-label={`第 ${q.number} 题说明`} disabled={blocked} maxLength={64}
                  placeholder="题目说明" value={q.title || ''} onChange={e => questionUpdate(q.id, { title: e.target.value })} />
              </> : <>
                <InputNumber aria-label={`第 ${q.number} 题分值`} disabled={blocked} value={q.points} min={.01} precision={2}
                  onChange={points => { if (points) questionUpdate(q.id, { points }) }} />
                <Button disabled={blocked} onClick={() => settings(q.id)}>设置</Button>
              </>}
              <Button disabled={blocked} danger onClick={() => {
                if (activeMark && (activeMark.kind === 'question' || activeMark.kind === 'choice-cell') && activeMark.id === q.id) setActiveMark(undefined)
                change({ questions: value.questions.filter(other => other.id !== q.id) })
                setTrial(undefined)
              }}>删除</Button>
            </div>)}
          </div>

          <div className="compatible-step-footer">
            <Button onClick={() => goStep(0)}>上一步</Button>
            <Button type="primary" disabled={face.anchors.length < 4 || !pageQuestions.length} onClick={() => goStep(2)}>下一步：试扫核验</Button>
          </div>
        </>}

        {step === 2 && <>
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
            <Button onClick={() => goStep(1)}>返回微调 / 重导 JSON</Button>
          </div>
        </>}
      </Card>

      <Card
        title={correcting ? '原图四角校正' : trial ? '试扫自动校正预览' : '标定预览（点击标记可微调位置）'}
        extra={<Space wrap size={6}>
          {canEditOnCanvas && <Checkbox checked={editGranularCell} onChange={e => { setEditGranularCell(e.target.checked); setActiveMark(undefined) }}>微调单格</Checkbox>}
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
              X {activeBox.x} · Y {activeBox.y} · {activeBox.width} × {activeBox.height} mm（可拖动或用方向键微调）
            </Typography.Text>
            {activeMark.kind !== 'candidate-cell' && activeMark.kind !== 'choice-cell' && <Button size="small" danger onClick={() => deleteActiveMark(activeMark)}>删除此标记</Button>}
            <Button size="small" onClick={() => setActiveMark(undefined)}>取消选中</Button>
          </Space>
        </div>}
        {trial && <Alert className="compatible-tools" showIcon type="success" message="请核对本面试扫结果（当前显示自动校正图）"
          description={<div>{!anonymous && page === 1 && <div>考号 {trial.candidate || '未识读'}{!statistics && trial.absent ? ' · 缺考' : ''}</div>}
            {Object.entries(trial.selections).map(([id, choices]) => <Tag key={id}>第 {value.questions.find(q => q.id === id)?.number} 题 {choices.join('') || '空白'}</Tag>)}</div>}
          action={<Space direction="vertical" size={6}>
            {!readOnly && !(statistics && profile.mode === 'blank') && <Button type="primary" size="small" disabled={blocked} onClick={() => void run(() => adoptCorrectedImage(trial.image, '已引用自动校正图作为当前底图，可导出给 AI 或继续微调'))}>引用此校正图</Button>}
            <Button size="small" onClick={() => setTrial(undefined)}>返回预览</Button>
          </Space>} />}
        {showCanvas ? <div className="compatible-canvas-viewport"><div className="compatible-canvas" style={{ aspectRatio: `${width}/${height}`, width: `${zoom}%`, maxWidth: zoom > 100 ? 'none' : 920 }}>
          {image && <img ref={imgRef} src={image} alt={correcting ? '待校正原图' : '当前纸面'} draggable={false}
            onLoad={event => { if (correcting) setRawSize([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight]) }} />}
          <svg role="img" aria-label="题卡标定区域" viewBox={`0 0 ${width} ${height}`}
            className={correcting ? 'compatible-draw' : canEditOnCanvas ? 'compatible-edit' : ''}
            onPointerDown={event => {
              if (blocked || trial) return
              if (correcting) { if (corners.length < 4) setCorners([...corners, point(event)]); return }
              if (canEditOnCanvas) setActiveMark(undefined)
            }}
            onPointerMove={event => {
              if (!editDrag) return
              const cur = point(event)
              const dx = cur[0] - editDrag.origin[0], dy = cur[1] - editDrag.origin[1]
              const minSize = editDrag.mark.kind === 'anchor' ? 3 : 1.2
              setEditDrag({ ...editDrag, currentBox: applyDragDelta(editDrag.initialBox, editDrag.action, dx, dy, width, height, minSize) })
            }}
            onPointerCancel={() => setEditDrag(undefined)}
            onPointerUp={() => {
              if (!editDrag) return
              const { mark, initialBox, currentBox } = editDrag
              setEditDrag(undefined)
              if (initialBox.x !== currentBox.x || initialBox.y !== currentBox.y || initialBox.width !== currentBox.width || initialBox.height !== currentBox.height) {
                commitMarkBox(mark, currentBox, true)
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
          </svg>
        </div></div> : <Empty description={readOnly ? '已保存题区与扫描定位配置' : '请先在左侧步骤 1 导入该面的空白原稿或扫描样张'} />}
      </Card>
    </div>
    <Modal
      title="外部 AI 识别提示词"
      open={promptPreviewOpen}
      width={680}
      onCancel={() => setPromptPreviewOpen(false)}
      footer={<Space>
        <Button onClick={() => setPromptPreviewOpen(false)}>关闭</Button>
        <Button type="primary" icon={<CopyOutlined />} onClick={() => void copyTextToClipboard(aiPromptText, '已复制 AI 识别提示词')}>复制全部提示词</Button>
      </Space>}
    >
      <Input.TextArea rows={18} readOnly value={aiPromptText} style={{ fontFamily: 'monospace' }} />
    </Modal>
  </div>
}
