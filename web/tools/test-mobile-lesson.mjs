import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { text } from 'node:stream/consumers'
import { createElement as h, Fragment } from 'react'
import { prerenderToNodeStream } from 'react-dom/static'
import ts from 'typescript'

// Render the real mobile shell, its lazy lesson route, and shared statistics offline.
// Inline drawer children during SSR so their controls can be inspected without DOM portals.
const require = createRequire(import.meta.url)
let offline = false
const user = { id: 'teacher', name: '教师', role: 'teacher' }
const requests = []
const catalog = { projects: [{
  id: 'exam', name: '期中', classes: [
    { id: 'own', name: '一班', grade: '高二', grade_id: 'g2' },
    { id: 'other', name: '三班', grade: '高一', grade_id: 'g1' },
  ],
  cards: [
    { id: 'unpublished', name: '未发布试卷', published: false, class_ids: ['own'] },
    { id: 'published', name: '期中卷', subject: '数学', published: true, class_ids: ['own', 'other'] },
  ],
}] }
const question = {
  id: 'q1', number: '1', points: 4, type: 'multiple', difficulty: 'hard', answer: ['A', 'C'],
  count: 2, average: 2, score_rate: 50, correct_rate: 50, correct: 1, graded: 2,
  options: { A: ['本班示例甲'], C: ['本班示例甲'], blank: ['本班示例乙'] },
}
const comparison = { grade_wide: false, classes: [{ name: '一班', averages: { total: 2, q1: 2 } }], averages: { total: 2, q1: 2 } }
const lesson = { group_id: 'published', class_id: 'own', full_score: 4, questions: [question], comparison }
const lessonUrl = '/analysis/paper-lesson?group_id=published&class_id=own'
let response = lesson
function useResource(url, initial) {
  requests.push(url)
  assert.ok(url == null || url === '/analysis/class-catalog' || url === lessonUrl, 'Unexpected API path: ' + url)
  return { loaded: true, data: url === '/analysis/class-catalog' ? catalog : url === lessonUrl ? response : initial }
}
const modules = new Map(Object.entries({
  './api': { useResource },
  './SessionActivity': { SessionActivity: () => null },
  './RealtimeStatus': { RealtimeStatus: () => null },
  './ReviewWorkspace': { ReviewWorkspace: ({children}) => children, useReviewWorkspace: () => ({ user, offline, records: [] }) },
  './MobileMarking': {},
  antd: { ...require('antd'), Drawer: ({children}) => h(Fragment, null, children) },
}))
function load(name) {
  if (modules.has(name)) return modules.get(name)
  if (name.endsWith('.css')) return {}
  if (!name.startsWith('./')) return require(name)
  const src = new URL('../src/' + name.slice(2), import.meta.url)
  const file = ['.ts', '.tsx'].map(ext => new URL(src.href + ext)).find(existsSync)
  assert.ok(file, 'Source not found: ' + name)
  const source = readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  }})
  const module = { exports: {} }
  modules.set(name, module.exports)
  new Function('require', 'exports', 'module', outputText)(load, module.exports, module)
  return module.exports
}
async function render(component, props) {
  const { prelude } = await prerenderToNodeStream(h(component, props))
  return (await text(prelude)).replaceAll('<!-- -->', '')
}

const { readLocation } = load('./examNavigation')
const MobileTeacherApp = load('./MobileTeacherApp').default
const deepLink = '#/lesson?project=exam&cls=own&card=published'
const location = readLocation(deepLink)
const props = { user, authToken: 'fixture', location, page: location.page }
const page = await render(MobileTeacherApp, props)
assert.deepEqual(requests.filter(Boolean), ['/analysis/class-catalog', lessonUrl])
assert.doesNotMatch(page, /未发布试卷/)
for (const label of [
  '讲评考试', '讲评年级标签', '讲评班级', '讲评题卡', '题单', '按题号定位', '低得分率优先', '原卷顺序',
  '课堂讲解', '本班作答', '跨班均分', '下一题', '上一题', '本班示例甲', '可见班级均分', '较难',
]) assert.ok(page.includes(label), 'Mobile lesson control or statistic missing: ' + label)

for (const scope of ['cls=unassigned', 'cls=own&card=unpublished', 'grade=id:g1&cls=own', 'grade=id:unknown']) {
  requests.length = 0
  const invalidLocation = readLocation('#/lesson?project=exam&' + scope)
  const restricted = await render(MobileTeacherApp, { ...props, location: invalidLocation })
  assert.doesNotMatch(restricted, /本班示例甲/)
  assert.deepEqual(requests.filter(Boolean), ['/analysis/class-catalog'])
}

// A late response for the previous class must never paint that class's answer details.
response = { ...lesson, class_id: 'previous' }
assert.doesNotMatch(await render(MobileTeacherApp, props), /本班示例甲/)
offline = true
requests.length = 0
assert.doesNotMatch(await render(MobileTeacherApp, props), /本班示例甲|按题号定位/)
assert.ok(requests.every(url => url == null), 'Offline marking must not load class data')

const { QuestionResult, ClassChart } = load('./LessonStatistics')
const classroom = await render(QuestionResult, { q: question, hideAnswer: true, showDistribution: false })
assert.match(classroom, /标准答案已隐藏/)
assert.doesNotMatch(classroom, /本班示例甲|完全正确率|正解/)
const bands = await render(QuestionResult, {
  q: { ...question, type: 'subjective', bands: [{ lower: 0, upper: 4, inclusive: true, count: 2 }] },
})
assert.match(bands, /得分区间/)
for (const metric of ['total', 'q1']) {
  const chart = await render(ClassChart, { comparison, metric, maximum: 4, activeClassName: '一班' })
  assert.match(chart, /可见班级均分/)
  assert.match(chart, /一班，2 分/)
}
console.log('Mobile lesson passed: native route, scoped catalog and statistics, drawer controls, classroom privacy, class comparison and offline guard')
