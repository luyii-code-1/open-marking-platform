import type { Question, Region, Template } from './api'

export const answerLetters = 'ABCDE'
export function parseQuestionNumbers(input: string): number[] {
  const numbers: number[] = []
  for (const part of input.trim().replace(/[，、；;]/g, ',').replace(/[–—~～]/g, '-').split(/[\s,]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!match) throw new Error(`题号格式不正确：${part}`)
    const from = Number(match[1]), to = Number(match[2] || match[1])
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from > 500) throw new Error('题号须为正整数，范围按从小到大填写，每批不超过500题')
    for (let number = from; number <= to; number++) numbers.push(number)
    if (numbers.length > 500) throw new Error('每批不超过500题')
  }
  if (!numbers.length) throw new Error('请填写题号，例如 1-20,23,25-30')
  if (new Set(numbers).size !== numbers.length) throw new Error('填写的题号有重复')
  return numbers.sort((a, b) => a - b)
}

export function parseAnswer(question: Pick<Question, 'number' | 'type' | 'options'>, input: string, allowEmpty = true) {
  const value = input.trim().toUpperCase()
  if (!value && allowEmpty) return []
  if (!value || [...value].some(letter => !answerLetters.slice(0, question.options).includes(letter))) throw new Error(`第${question.number}题只能填写 ${answerLetters.slice(0, question.options)} 中的选项`)
  if (new Set(value).size !== value.length) throw new Error(`第${question.number}题答案重复`)
  if (question.type === 'single' && value.length !== 1) throw new Error(`第${question.number}题是单选题，只能填写一个答案`)
  return [...value].sort()
}

export function applyAnswers(questions: Question[], input: string) {
  const objective = questions.filter(q => q.type !== 'subjective').sort((a, b) => a.number - b.number)
  const source = input.trim().toUpperCase()
  if (!objective.length) throw new Error('请先创建客观题')
  if (!source) throw new Error('请粘贴答案')
  const lines = source.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const numbered = lines.every(line => /^\d+\s*[.、:：\s]\s*[A-E]+$/.test(line))
  const answers = new Map<string, string[]>()
  if (numbered) {
    const seen = new Set<number>()
    for (const line of lines) {
      const [, numberText, text] = /^(\d+)\s*[.、:：\s]\s*([A-E]+)$/.exec(line)!
      const number = Number(numberText), question = objective.find(q => q.number === number)
      if (!question) throw new Error(`第${number}题不存在或不是客观题`)
      if (seen.has(number)) throw new Error(`第${number}题重复出现`)
      seen.add(number); answers.set(question.id, parseAnswer(question, text, false))
    }
    if (answers.size !== objective.length) throw new Error(`需要${objective.length}题答案，当前仅匹配${answers.size}题`)
  } else {
    const values = /^[A-E]+$/.test(source) && objective.every(q => q.type === 'single') ? [...source] : source.split(/[\s,，;；]+/).filter(Boolean)
    if (values.length !== objective.length) throw new Error(`需要${objective.length}题答案，当前有${values.length}项；多选题答案请用空格或换行分隔`)
    objective.forEach((q, index) => answers.set(q.id, parseAnswer(q, values[index], false)))
  }
  return questions.map(q => answers.has(q.id) ? { ...q, answer: answers.get(q.id)! } : q)
}

type Layout = { columns: number; startPage: number }
const overlaps = (a: Region, b: Region) => a.page === b.page && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
export function arrangeObjective(template: Template, ids: string[], { columns, startPage }: Layout) {
  const selected = new Set(ids), target = template.questions.filter(q => selected.has(q.id)).sort((a, b) => a.number - b.number)
  if (!target.length || target.some(q => q.type === 'subjective')) throw new Error('请选择需要排布的客观题')
  if (!Number.isInteger(columns) || columns < 1 || columns > 10 || !Number.isInteger(startPage) || startPage < 1 || startPage > template.sides) throw new Error('排布列数或起始面无效')
  const paperWidth = template.paper === 'A3' ? 420 : 210, gap = 6
  const width = Math.floor(((paperWidth - 24 - (columns - 1) * gap) / columns) * 10) / 10
  if (target.some(q => width < 12 + q.options * 6)) throw new Error('当前列数放不下选项，请减少列数')
  const occupied = template.questions.filter(q => !selected.has(q.id)).flatMap(q => q.regions)
  const slots: Region[] = []
  for (let page = startPage; page <= template.sides; page++)
    for (let y = 100; y + 16 <= 289; y += 18)
      for (let col = 0; col < columns; col++) {
        const slot = { page, x: Math.round((12 + col * (width + gap)) * 10) / 10, y, width, height: 16 }
        if (!occupied.some(region => overlaps(region, slot))) slots.push(slot)
      }
  if (slots.length < target.length) throw new Error(`剩余空间可放${slots.length}题，需要${target.length}题；请增加列数、启用背面或调整已有区域`)
  const positions = new Map(target.map((q, index) => [q.id, slots[index]]))
  return template.questions.map(q => positions.has(q.id) ? { ...q, regions: [positions.get(q.id)!] } : q)
}

export function addObjective(template: Template, config: Layout & { numbers: string; type: 'single' | 'multiple'; options: number; points: number }, uuid = () => crypto.randomUUID()) {
  const numbers = parseQuestionNumbers(config.numbers), existing = new Set(template.questions.map(q => q.number))
  const duplicate = numbers.filter(number => existing.has(number))
  if (duplicate.length) throw new Error(`题号已存在：${duplicate.join('、')}`)
  if (![3, 4, 5].includes(config.options) || !['single', 'multiple'].includes(config.type) || !Number.isFinite(config.points) || config.points <= 0 || Math.abs(config.points * 100 - Math.round(config.points * 100)) > 1e-7) throw new Error('请选择3/4/5个选项，分值须为最多两位小数的正数')
  const created: Question[] = numbers.map(number => ({ id: uuid(), number, type: config.type, options: config.options, points: config.points, answer: [], rule: { mode: 'exact' }, regions: [], review_mode: 'single', threshold: 0 }))
  return arrangeObjective({ ...template, questions: [...template.questions, ...created].sort((a, b) => a.number - b.number) }, created.map(q => q.id), config)
}
