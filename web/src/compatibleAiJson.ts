import type { ExternalPage, ImageBox, Question, Template } from './api'

export type AiPromptContext = {
  paper: 'A4' | 'A3'
  page: number
  sides: number
  statistics: boolean
  anonymous: boolean
  candidateLength: number
  nextQuestionNumber: number
  sheetName?: string
}

export type ParsedAiChoice = {
  number: number
  type: 'single' | 'multiple'
  options: number
  points: number
  title: string
  cells: ImageBox[]
  region: ImageBox
}

export type ParsedAiSubjective = {
  number: number
  points: number
  regions: ImageBox[]
}

export type ParsedAiLayout = {
  anchors: ImageBox[]
  candidate?: ImageBox[][]
  candidateLength?: number
  absent?: ImageBox
  choices: ParsedAiChoice[]
  subjective: ParsedAiSubjective[]
  warnings: string[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

function pageDimensions(paper: 'A4' | 'A3'): [number, number] {
  return paper === 'A3' ? [420, 297] : [210, 297]
}

export function enclosingBox(cells: ImageBox[]): ImageBox {
  const x = Math.min(...cells.map(c => c.x))
  const y = Math.min(...cells.map(c => c.y))
  return {
    x: round2(x),
    y: round2(y),
    width: round2(Math.max(...cells.map(c => c.x + c.width)) - x),
    height: round2(Math.max(...cells.map(c => c.y + c.height)) - y),
  }
}

function splitGrid(box: ImageBox, cols: number, rows: number): ImageBox[][] {
  const cw = box.width / cols
  const ch = box.height / rows
  return Array.from({ length: cols }, (_, c) =>
    Array.from({ length: rows }, (_, r) => ({
      x: round2(box.x + c * cw),
      y: round2(box.y + r * ch),
      width: round2(cw),
      height: round2(ch),
    })),
  )
}

function splitOptionCells(box: ImageBox, count: number, rows = 1, vertical = false): ImageBox[] {
  if (vertical) {
    return splitGrid(box, 1, count)[0]
  }
  const safeRows = Math.max(1, Math.min(rows, count))
  if (safeRows === 1) {
    return splitGrid(box, count, 1).flat()
  }
  const cols = Math.ceil(count / safeRows)
  const cells: ImageBox[] = []
  const w = box.width / cols
  const h = box.height / safeRows
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols)
    const c = i % cols
    cells.push({ x: round2(box.x + c * w), y: round2(box.y + r * h), width: round2(w), height: round2(h) })
  }
  return cells
}

function clampToPage(box: ImageBox, pageW: number, pageH: number, minSize = 1): ImageBox | null {
  if (![box.x, box.y, box.width, box.height].every(v => typeof v === 'number' && Number.isFinite(v))) return null
  const x1 = Math.max(0, Math.min(pageW, box.x))
  const y1 = Math.max(0, Math.min(pageH, box.y))
  const x2 = Math.max(0, Math.min(pageW, box.x + box.width))
  const y2 = Math.max(0, Math.min(pageH, box.y + box.height))
  const w = round2(x2 - x1)
  const h = round2(y2 - y1)
  if (w < minSize || h < minSize) return null
  return { x: round2(x1), y: round2(y1), width: w, height: h }
}

export function buildCompatibleAiPrompt(ctx: AiPromptContext): string {
  const [pageW, pageH] = pageDimensions(ctx.paper)
  const sideText = ctx.page === 1 ? '正面（第 1 面）' : '背面（第 2 面）'
  if (ctx.statistics) {
    const candidateRule = ctx.anonymous || ctx.page !== 1
      ? '- 本统计卡为匿名统计或背面，**无需识别准考证号区、缺考标记、主观题或考试题卡得分结构**，请勿输出 `candidate`、`absent`、`subjective`。'
      : `- 本统计卡第 1 面启用了准考证号（默认 ${ctx.candidateLength} 位），请识别准考证号填涂区（\`candidate\`）；**无需识别主观题、分值或缺考标记**。`
    const example = {
      coord_unit: 'norm1000',
      page: ctx.page,
      anchors: [
        { x: 24, y: 20, width: 22, height: 16 },
        { x: 954, y: 20, width: 22, height: 16 },
        { x: 954, y: 964, width: 22, height: 16 },
        { x: 24, y: 964, width: 22, height: 16 },
      ],
      ...(!ctx.anonymous && ctx.page === 1
        ? { candidate: { length: ctx.candidateLength, direction: 'vertical', reverse: false, box: { x: 640, y: 110, width: 290, height: 210 } } }
        : {}),
      choices: [
        { number: ctx.nextQuestionNumber, title: '题目简述（选填）', type: 'single', options: 4, rows: 1, direction: 'horizontal', box: { x: 80, y: 240, width: 420, height: 28 } },
        { number: ctx.nextQuestionNumber + 1, title: '多选示例', type: 'multiple', options: 16, rows: 2, direction: 'horizontal', box: { x: 80, y: 290, width: 820, height: 56 } },
      ],
    }
    return [
      `你是一个专业的统计表/答题卡版面识别助手。请根据我发给你的这张已校正【${ctx.paper} ${sideText}】图片，完成统计选择题识别，并严格按“先发识别概要 → 等待用户确认 → 再发送最终 JSON”的两步流程执行。`,
      '',
      '【第一步：先发【识别概要】并等待用户确认（暂不直接输出最终 JSON）】',
      '请先通览整张图片并向我发送一份简洁清晰的【识别概要】，包含：',
      `1. 当前纸面：${ctx.paper} ${sideText}（实际尺寸 ${pageW}×${pageH} mm）。`,
      '2. 统计选择题清单：总题数、各题题号、题目简述、单选/多选、选项范围（如 A–D、A–P）与选项行数。',
      !ctx.anonymous && ctx.page === 1
        ? `3. 准考证号填涂区：识别到的位数（默认 ${ctx.candidateLength} 位）及数字排列方向（竖向/横向）。`
        : '3. 匿名统计/背面说明：不识别准考证号、主观题、分值及缺考标记。',
      '4. 定位块情况：四角定位黑块是否清晰可见，以及是否有需要我核对的模糊位置。',
      '发送完【识别概要】后，请明确询问我“请核对以上识别概要，回复「确认」后我将发送最终 JSON，或请指出需要修改的地方”。**在我回复确认前，不要直接发送最终 JSON**（除非我明确要求跳过确认直接输出）。',
      '',
      '【第二步：用户确认后再输出最终 JSON】',
      '收到我的确认或修正意见后，只输出一个严格合法的 JSON 对象（用 ```json 代码块包裹），必须满足：',
      `1. 坐标系统一使用 \`coord_unit: "norm1000"\`：整张图片左上角为 (0, 0)，右下角为 (1000, 1000)。所有框使用 \`{ "x": 左上角X, "y": 左上角Y, "width": 宽度, "height": 高度 }\`。`,
      '2. 这是**统计项目**，不需要识别普通考试题卡的主观题、分值、缺考标记。',
      candidateRule,
      '3. 完整输出全部统计选择题（`choices`）：包含 `number`、`title`（选填）、`type`（`"single"` / `"multiple"`）、`options`（2–26）、`rows`、`direction`（`"horizontal"` / `"vertical"`）以及紧贴填涂格的 `box`（或逐项坐标 `cells`）。',
      '4. `anchors` 为可选：若纸面有四角黑色定位块，请紧贴黑块本身框出（不要框入旁边虚线或边框）；若四角对称，可额外给 1 个标题/固定文字块作方向参照。',
      '',
      '【最终 JSON 输出格式示例】',
      '```json',
      JSON.stringify(example, null, 2),
      '```',
    ].join('\n')
  }

  const example = {
    coord_unit: 'norm1000',
    page: ctx.page,
    anchors: [
      { x: 24, y: 20, width: 22, height: 16 },
      { x: 954, y: 20, width: 22, height: 16 },
      { x: 954, y: 964, width: 22, height: 16 },
      { x: 24, y: 964, width: 22, height: 16 },
      { x: 180, y: 38, width: 160, height: 34 },
    ],
    ...(ctx.page === 1
      ? {
          candidate: { length: ctx.candidateLength, direction: 'vertical', reverse: false, box: { x: 640, y: 105, width: 290, height: 220 } },
          absent: { x: 560, y: 120, width: 24, height: 16 },
        }
      : {}),
    choices: [
      { number: 1, type: 'single', options: 4, points: 3, direction: 'horizontal', box: { x: 80, y: 350, width: 165, height: 18 } },
      { numbers: '2-5', type: 'single', options: 4, points: 3, direction: 'horizontal', box: { x: 80, y: 372, width: 165, height: 74 } },
    ],
    subjective: [
      { number: 16, points: 10, regions: [{ x: 65, y: 470, width: 870, height: 180 }] },
      { number: 17, points: 12, regions: [{ x: 65, y: 665, width: 870, height: 240 }] },
    ],
  }

  return [
    `你是一个专业的考试答题卡版面识别助手。请根据我发给你的这张已校正【${ctx.paper} ${sideText}】答题卡图片，完整识别所有客观题、主观题及定位/考号区，并严格按“先发识别概要 → 等待用户确认 → 再发送最终 JSON”的两步流程执行。`,
    '',
    '【第一步：先发【识别概要】并等待用户确认（暂不直接输出最终 JSON）】',
    '请先仔细核对整张答题卡并向我发送一份简洁清晰的【识别概要】，逐项列出：',
    `1. 当前纸面：${ctx.paper} ${sideText}（实际尺寸 ${pageW}×${pageH} mm）。`,
    ctx.page === 1
      ? `2. 准考证号与缺考标记：准考证号位数（默认 ${ctx.candidateLength} 位）与排列方向、是否检测到缺考填涂格。`
      : '2. 当前为背面（第 2 面）：不含准考证号与缺考标记。',
    '3. 客观题清单：总题数、题号范围（如 1–12 题）、单选/多选分布、选项数（3–7）及卷面分值。',
    '4. 主观题清单：总题数、全部题号、每题卷面分值，以及哪些题包含多块续答区域。',
    '5. 定位块与待核对项：四角定位块是否清晰、是否存在未标分值或模糊题号等需要我确认的地方。',
    '发送完【识别概要】后，请明确询问我“请核对以上识别概要，回复「确认」后我将发送最终 JSON，或请指出需要补充/修改的地方”。**在我回复确认前，不要直接发送最终 JSON**（除非我明确要求跳过确认直接输出）。',
    '',
    '【第二步：用户确认后再输出最终 JSON】',
    '收到我的确认或修正意见后，只输出一个严格合法的 JSON 对象（用 ```json 代码块包裹），必须满足：',
    `1. 坐标系统一使用 \`coord_unit: "norm1000"\`：整张图片左上角为 (0, 0)，右下角为 (1000, 1000)。所有框使用 \`{ "x": 左上角X, "y": 左上角Y, "width": 宽度, "height": 高度 }\`。`,
    '2. **必须完整输出当前面的所有客观题（`choices`）和所有主观题（`subjective`）**，与已确认的概要完全一致，不得遗漏任何题号或跨栏续区：',
    '   - 客观题 `choices`：每题提供 `number`（或连续同列矩阵用 `numbers: "1-5"`）、`type`（`"single"` / `"multiple"`）、`options`（3–7）、`points`（未标出填 2）、`direction`（`"horizontal"` / `"vertical"`），以及紧贴选项填涂格的 `box`（或逐项坐标数组 `cells`）。',
    '   - 主观题 `subjective`：每题提供 `number`、`points`（未标出填 10）、`regions` 数组（包住作答框内部区域；同一题若有多块续答区请全部放入 `regions`）。',
    ctx.page === 1
      ? `3. 第 1 面一并输出准考证号填涂区 \`candidate\`（\`length\` 为位数，\`direction\` 为 \`"vertical"\` 或 \`"horizontal"\`，\`box\` 紧贴填涂格矩阵）与缺考填涂格 \`absent\`（如有）。`
      : '3. 当前为背面（第 2 面），无需输出 `candidate` 与 `absent`。',
    '4. `anchors`：识别纸面四周的 4 个黑色定位块（紧贴黑块本身，避免框入旁边虚线或边框），若四角对称请额外加 1 个标题/固定文字块作为方向辨识参照。',
    '',
    '【最终 JSON 输出格式示例】',
    '```json',
    JSON.stringify(example, null, 2),
    '```',
  ].join('\n')
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('未在粘贴内容中找到有效的 JSON 对象，请确认已复制完整结果')
  }
  return candidate.slice(start, end + 1)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1')
}

function convertBox(
  raw: unknown,
  unit: 'norm1000' | 'norm1' | 'mm' | 'px',
  pageW: number,
  pageH: number,
  imgW: number,
  imgH: number,
  minSize = 1,
): ImageBox | null {
  let x = 0, y = 0, w = 0, h = 0
  if (Array.isArray(raw) && raw.length === 4 && raw.every(v => typeof v === 'number' && Number.isFinite(v))) {
    const [a, b, c, d] = raw as [number, number, number, number]
    x = Math.min(a, c); y = Math.min(b, d); w = Math.abs(c - a); h = Math.abs(d - b)
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (Array.isArray(obj.box_2d) && obj.box_2d.length === 4 && obj.box_2d.every(v => typeof v === 'number')) {
      const [ymin, xmin, ymax, xmax] = obj.box_2d as [number, number, number, number]
      x = Math.min(xmin, xmax); y = Math.min(ymin, ymax); w = Math.abs(xmax - xmin); h = Math.abs(ymax - ymin)
    } else if (Array.isArray(obj.bbox) && obj.bbox.length === 4 && obj.bbox.every(v => typeof v === 'number')) {
      const [x1, y1, x2, y2] = obj.bbox as [number, number, number, number]
      x = Math.min(x1, x2); y = Math.min(y1, y2); w = Math.abs(x2 - x1); h = Math.abs(y2 - y1)
    } else if (typeof obj.x === 'number' && typeof obj.y === 'number' && (typeof obj.width === 'number' || typeof obj.w === 'number') && (typeof obj.height === 'number' || typeof obj.h === 'number')) {
      x = obj.x; y = obj.y
      w = typeof obj.width === 'number' ? obj.width : (obj.w as number)
      h = typeof obj.height === 'number' ? obj.height : (obj.h as number)
    } else if (typeof obj.x1 === 'number' && typeof obj.y1 === 'number' && typeof obj.x2 === 'number' && typeof obj.y2 === 'number') {
      x = Math.min(obj.x1, obj.x2); y = Math.min(obj.y1, obj.y2); w = Math.abs(obj.x2 - obj.x1); h = Math.abs(obj.y2 - obj.y1)
    } else if (typeof obj.left === 'number' && typeof obj.top === 'number' && typeof obj.right === 'number' && typeof obj.bottom === 'number') {
      x = Math.min(obj.left, obj.right); y = Math.min(obj.top, obj.bottom); w = Math.abs(obj.right - obj.left); h = Math.abs(obj.bottom - obj.top)
    } else {
      return null
    }
  } else {
    return null
  }

  let mx = x, my = y, mw = w, mh = h
  if (unit === 'norm1000') {
    mx = x / 1000 * pageW
    my = y / 1000 * pageH
    mw = w / 1000 * pageW
    mh = h / 1000 * pageH
  } else if (unit === 'norm1') {
    mx = x * pageW
    my = y * pageH
    mw = w * pageW
    mh = h * pageH
  } else if (unit === 'px') {
    mx = x / Math.max(1, imgW) * pageW
    my = y / Math.max(1, imgH) * pageH
    mw = w / Math.max(1, imgW) * pageW
    mh = h / Math.max(1, imgH) * pageH
  }
  return clampToPage({ x: round2(mx), y: round2(my), width: round2(mw), height: round2(mh) }, pageW, pageH, minSize)
}

function parseNumberList(raw: unknown): number[] {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return [raw]
  if (Array.isArray(raw)) {
    return raw.map(v => Number(v)).filter(v => Number.isInteger(v) && v > 0)
  }
  if (typeof raw === 'string') {
    const out: number[] = []
    for (const part of raw.split(/[,，\s]+/).filter(Boolean)) {
      const range = part.match(/^(\d+)\s*[-~至]\s*(\d+)$/)
      if (range) {
        const a = Number(range[1]), b = Number(range[2])
        if (a > 0 && b >= a && b - a <= 100) {
          for (let n = a; n <= b; n++) out.push(n)
        }
      } else if (/^\d+$/.test(part)) {
        const n = Number(part)
        if (n > 0) out.push(n)
      }
    }
    return out
  }
  return []
}

function detectCoordUnit(data: Record<string, unknown>, pageW: number, pageH: number): 'norm1000' | 'norm1' | 'mm' | 'px' {
  const declared = String(data.coord_unit || data.unit || '').toLowerCase()
  if (declared === 'norm1000' || declared === '1000' || declared === 'thousand') return 'norm1000'
  if (declared === 'norm1' || declared === 'normalized' || declared === 'ratio') return 'norm1'
  if (declared === 'mm' || declared === 'millimeter') return 'mm'
  if (declared === 'px' || declared === 'pixel') return 'px'
  // Auto-detect based on numeric magnitude when AI omits coord_unit.
  const numbers: number[] = []
  const walk = (node: unknown, depth = 0) => {
    if (depth > 5 || numbers.length > 60 || !node) return
    if (typeof node === 'object') {
      const o = node as Record<string, unknown>
      for (const k of ['x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'left', 'top', 'right', 'bottom']) {
        if (typeof o[k] === 'number' && Number.isFinite(o[k] as number)) numbers.push(o[k] as number)
      }
      if (Array.isArray(o.box_2d)) o.box_2d.forEach(v => { if (typeof v === 'number') numbers.push(v) })
      if (Array.isArray(node)) node.forEach(item => walk(item, depth + 1))
      else Object.values(o).forEach(v => { if (v && typeof v === 'object') walk(v, depth + 1) })
    }
  }
  walk(data)
  if (!numbers.length) return 'norm1000'
  const maxVal = Math.max(...numbers)
  if (maxVal <= 1.05) return 'norm1'
  if (maxVal <= Math.max(pageW, pageH) + 5 && declared === '') {
    // Could be mm or norm1000; if values exceed page dimensions or >= 450, it's norm1000.
    return maxVal > Math.max(pageW, pageH) ? 'norm1000' : 'norm1000'
  }
  return maxVal > 1050 ? 'px' : 'norm1000'
}

export function parseCompatibleAiJson(rawText: string, ctx: AiPromptContext): ParsedAiLayout {
  const jsonStr = extractJsonText(rawText)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch (err) {
    throw new Error(`JSON 语法错误：${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('顶层必须是 JSON 对象')
  }
  const data = parsed as Record<string, unknown>
  const [pageW, pageH] = pageDimensions(ctx.paper)
  const unit = detectCoordUnit(data, pageW, pageH)
  const imgW = typeof data.image_width === 'number' && data.image_width > 0 ? data.image_width : pageW * 4
  const imgH = typeof data.image_height === 'number' && data.image_height > 0 ? data.image_height : pageH * 4
  const warnings: string[] = []

  // 1. Anchors
  const anchors: ImageBox[] = []
  if (Array.isArray(data.anchors)) {
    for (const item of data.anchors.slice(0, 8)) {
      const box = convertBox(item && typeof item === 'object' && 'box' in (item as Record<string, unknown>) ? (item as Record<string, unknown>).box : item, unit, pageW, pageH, imgW, imgH, 3)
      if (box && box.width <= 36 && box.height <= 36) anchors.push(box)
      else warnings.push('已跳过 1 个尺寸超出 3–36 mm 范围的定位块')
    }
  }

  // 2. Candidate grid
  let candidate: ImageBox[][] | undefined
  let candidateLength: number | undefined
  if (!ctx.anonymous && ctx.page === 1 && data.candidate) {
    const rawCand = data.candidate as Record<string, unknown> | unknown[]
    if (Array.isArray(rawCand) && rawCand.every(col => Array.isArray(col) && col.length === 10)) {
      const cols = rawCand.map(col => (col as unknown[]).map(c => convertBox(c, unit, pageW, pageH, imgW, imgH, 1)).filter((c): c is ImageBox => !!c))
      if (cols.length >= 1 && cols.every(col => col.length === 10)) {
        candidate = cols
        candidateLength = cols.length
      }
    } else if (rawCand && typeof rawCand === 'object' && !Array.isArray(rawCand)) {
      if (Array.isArray(rawCand.columns)) {
        const cols = rawCand.columns.map(col => Array.isArray(col) ? col.map(c => convertBox(c, unit, pageW, pageH, imgW, imgH, 1)).filter((c): c is ImageBox => !!c) : [])
        if (cols.length >= 1 && cols.every(col => col.length === 10)) {
          candidate = cols
          candidateLength = cols.length
        }
      }
      if (!candidate) {
        const box = convertBox(rawCand.box ?? rawCand, unit, pageW, pageH, imgW, imgH, 4)
        const length = typeof rawCand.length === 'number' && Number.isInteger(rawCand.length) && rawCand.length >= 1 && rawCand.length <= 20
          ? rawCand.length
          : ctx.candidateLength
        const horizontal = String(rawCand.direction || '').toLowerCase() === 'horizontal' || rawCand.transpose === true
        const reverse = rawCand.reverse === true
        if (box) {
          const partition = horizontal ? splitGrid(box, 10, length) : splitGrid(box, length, 10)
          const digits = horizontal ? Array.from({ length }, (_, r) => partition.map(col => col[r])) : partition
          candidate = reverse ? digits.map(col => [...col].reverse()) : digits
          candidateLength = length
        }
      }
    }
  }

  // 3. Absent mark
  let absent: ImageBox | undefined
  if (!ctx.statistics && ctx.page === 1 && data.absent) {
    const box = convertBox(typeof data.absent === 'object' && data.absent && 'box' in (data.absent as Record<string, unknown>) ? (data.absent as Record<string, unknown>).box : data.absent, unit, pageW, pageH, imgW, imgH, 1)
    if (box) absent = box
  }

  // 4. Objective / statistics choices
  const minOpts = ctx.statistics ? 2 : 3
  const maxOpts = ctx.statistics ? 26 : 7
  const choices: ParsedAiChoice[] = []
  const rawChoices = Array.isArray(data.choices) ? data.choices : Array.isArray(data.objective) ? data.objective : []
  let autoNum = ctx.nextQuestionNumber
  for (const entry of rawChoices) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const qType: 'single' | 'multiple' = String(item.type || '').toLowerCase() === 'multiple' ? 'multiple' : 'single'
    const points = ctx.statistics ? 0 : (typeof item.points === 'number' && item.points > 0 ? round2(item.points) : 2)
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 64) : ''
    const vertical = String(item.direction || '').toLowerCase() === 'vertical' || item.transpose === true
    const rawCells = Array.isArray(item.cells) ? item.cells : Array.isArray(item.options_boxes) ? item.options_boxes : null

    if (rawCells && rawCells.length >= minOpts && rawCells.length <= maxOpts) {
      const cells = rawCells.map(c => convertBox(c, unit, pageW, pageH, imgW, imgH, 1)).filter((c): c is ImageBox => !!c)
      if (cells.length === rawCells.length) {
        const num = typeof item.number === 'number' && Number.isInteger(item.number) && item.number > 0 ? item.number : autoNum
        autoNum = Math.max(autoNum, num + 1)
        choices.push({ number: num, type: qType, options: cells.length, points, title, cells, region: enclosingBox(cells) })
        continue
      }
    }

    const optCount = Math.max(minOpts, Math.min(maxOpts, Number(item.options) || 4))
    const box = convertBox(item.box ?? item.region ?? item, unit, pageW, pageH, imgW, imgH, 1.5)
    if (!box) {
      warnings.push(`客观题 ${item.number ?? item.numbers ?? '?'} 坐标无效，已跳过`)
      continue
    }
    const nums = item.numbers !== undefined ? parseNumberList(item.numbers) : parseNumberList(item.number)
    const finalNums = nums.length ? nums : [autoNum]
    if (finalNums.length === 1) {
      const rows = typeof item.rows === 'number' && item.rows >= 1 ? Math.round(item.rows) : (ctx.statistics && optCount > 13 ? 2 : 1)
      const cells = splitOptionCells(box, optCount, rows, vertical)
      autoNum = Math.max(autoNum, finalNums[0] + 1)
      choices.push({ number: finalNums[0], type: qType, options: optCount, points, title, cells, region: enclosingBox(cells) })
    } else {
      const count = finalNums.length
      if (vertical) {
        const cols = splitGrid(box, count, optCount)
        finalNums.forEach((num, idx) => {
          const cells = cols[idx]
          choices.push({ number: num, type: qType, options: optCount, points, title, cells, region: enclosingBox(cells) })
        })
      } else {
        const cols = splitGrid(box, optCount, count)
        finalNums.forEach((num, idx) => {
          const cells = cols.map(col => col[idx])
          choices.push({ number: num, type: qType, options: optCount, points, title, cells, region: enclosingBox(cells) })
        })
      }
      autoNum = Math.max(autoNum, Math.max(...finalNums) + 1)
    }
  }

  // 5. Subjective questions (exam mode only)
  const subjective: ParsedAiSubjective[] = []
  const rawSub = Array.isArray(data.subjective) ? data.subjective : []
  if (!ctx.statistics) {
    for (const entry of rawSub) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const points = typeof item.points === 'number' && item.points > 0 ? round2(item.points) : 10
      const rawRegions = Array.isArray(item.regions) ? item.regions : (item.box ? [item.box] : [item])
      const regions = rawRegions.map(r => convertBox(r, unit, pageW, pageH, imgW, imgH, 2)).filter((r): r is ImageBox => !!r)
      if (!regions.length) {
        warnings.push(`主观题 ${item.number ?? '?'} 区域坐标无效，已跳过`)
        continue
      }
      const num = typeof item.number === 'number' && Number.isInteger(item.number) && item.number > 0 ? item.number : autoNum
      autoNum = Math.max(autoNum, num + 1)
      subjective.push({ number: num, points, regions })
    }
  } else if (rawSub.length > 0) {
    warnings.push(`统计模式已自动忽略 ${rawSub.length} 道主观题`)
  }

  if (!anchors.length && !candidate && !absent && !choices.length && !subjective.length) {
    throw new Error('JSON 解析成功，但未包含任何可导入的定位块、考号或题目坐标')
  }

  return { anchors, candidate, candidateLength, absent, choices, subjective, warnings }
}

export function exportCompatibleToAiJson(template: Template, page: number): string {
  const [pageW, pageH] = pageDimensions(template.paper)
  const toNorm = (b: ImageBox) => ({
    x: round2(b.x / pageW * 1000),
    y: round2(b.y / pageH * 1000),
    width: round2(b.width / pageW * 1000),
    height: round2(b.height / pageH * 1000),
  })
  const face: ExternalPage = template.external_sheet?.pages[String(page)] ?? { anchors: [] }
  const statistics = template.statistics_sheet === true || template.statistics_mode === true
  const pageQuestions = template.questions.filter(q => q.regions.some(r => r.page === page))
  const choices = pageQuestions
    .filter(q => q.type !== 'subjective')
    .sort((a, b) => a.number - b.number)
    .map(q => ({
      number: q.number,
      ...(statistics && q.title ? { title: q.title } : {}),
      type: q.type,
      options: q.options,
      ...(!statistics ? { points: q.points } : {}),
      cells: (q.external_options || []).map(toNorm),
    }))
  const subjective = statistics
    ? []
    : pageQuestions
        .filter(q => q.type === 'subjective')
        .sort((a, b) => a.number - b.number)
        .map(q => ({
          number: q.number,
          points: q.points,
          regions: q.regions.filter(r => r.page === page).map(toNorm),
        }))

  const payload: Record<string, unknown> = {
    coord_unit: 'norm1000',
    page,
    anchors: face.anchors.map(toNorm),
  }
  if (page === 1 && face.candidate?.length) {
    payload.candidate = {
      length: face.candidate.length,
      box: toNorm(enclosingBox(face.candidate.flat())),
      columns: face.candidate.map(col => col.map(toNorm)),
    }
  }
  if (!statistics && page === 1 && face.absent) {
    payload.absent = toNorm(face.absent)
  }
  payload.choices = choices
  if (!statistics) payload.subjective = subjective
  return JSON.stringify(payload, null, 2)
}
