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
let customUseResource = null
function useResource(url, initial) {
  if (customUseResource) return customUseResource(url, initial)
  requests.push(url)
  assert.ok(url == null || url === '/analysis/class-catalog' || url === lessonUrl, 'Unexpected API path: ' + url)
  return { loaded: true, data: url === '/analysis/class-catalog' ? catalog : url === lessonUrl ? response : initial }
}
const AdmList = Object.assign(({ children, header }) => h('div', null, header, children), {
  Item: ({ title, description, extra, children }) => h('div', null, title, description, extra, children),
})
const AdmTabBar = Object.assign(({ children }) => h('nav', null, children), {
  Item: ({ title }) => h('span', null, title),
})
const AdmCapsuleTabs = Object.assign(({ children }) => h('div', null, children), {
  Tab: ({ title, children }) => h('div', null, title, children),
})
const AdmCollapse = Object.assign(({ children }) => h('div', null, children), {
  Panel: ({ title, children }) => h('div', null, title, children),
})
const antdMobileStub = {
  ActionSheet: () => null,
  Button: ({ children }) => h('button', { type: 'button' }, children),
  CapsuleTabs: AdmCapsuleTabs,
  Collapse: AdmCollapse,
  ConfigProvider: ({ children }) => h(Fragment, null, children),
  Dialog: { confirm: async () => true },
  Empty: ({ description }) => h('div', null, description),
  ErrorBlock: ({ title, description, children }) => h('div', null, title, description, children),
  Input: ({ value, placeholder }) => h('input', { value, placeholder, readOnly: true }),
  List: AdmList,
  NavBar: ({ back, right, children }) => h('header', null, back, children, right),
  NoticeBar: ({ content, extra }) => h('div', null, content, extra),
  Popup: ({ children }) => h(Fragment, null, children),
  ProgressBar: ({ percent }) => h('div', { 'data-percent': percent }),
  SafeArea: () => null,
  SearchBar: ({ placeholder }) => h('input', { placeholder, readOnly: true }),
  Selector: ({ options = [], 'aria-label': label }) => h('div', { 'aria-label': label }, options.map(o => h('span', { key: o.value }, o.label))),
  Space: ({ children }) => h('div', null, children),
  SpinLoading: () => h('div', null, 'loading'),
  Stepper: () => h('div', null),
  Switch: () => h('input', { type: 'checkbox', readOnly: true }),
  TabBar: AdmTabBar,
  Tag: ({ children }) => h('span', null, children),
  TextArea: () => h('textarea', { readOnly: true }),
}
const modules = new Map(Object.entries({
  './api': { useResource, watchChanges: () => () => {} },
  './SessionActivity': { SessionActivity: () => null },
  './RealtimeStatus': { RealtimeStatus: () => null },
  './ReviewWorkspace': { ReviewWorkspace: ({children}) => children, useReviewWorkspace: () => ({ user, offline, records: [], pendingCount: 0, openQueueModal: () => {} }) },
  './WorkspaceNotifications': { WorkspaceNotificationsProvider: ({children}) => children, WorkspaceNotificationButton: () => null, useWorkspaceNotifications: () => ({ templateNotices: [], slow: false, setOpen: () => {} }) },
  './MobileMarking': {},
  './ResultExport': { ResultExport: () => h('button', { type: 'button' }, '导出') },
  './MobileResultExport': { MobileResultExport: () => h('button', { type: 'button' }, '导出') },
  'antd-mobile': antdMobileStub,
  'antd-mobile/es/locales/zh-CN': { default: {} },
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

const { readLocation, classResultsPath } = load('./examNavigation')
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

// Verify MobileClassResults renders total/card/lesson routes cleanly without hook order errors
offline = false
const MobileClassResults = load('./MobileClassResults').default
customUseResource = (url, initial) => {
  if (url === '/analysis/class-catalog') return { loaded: true, data: catalog }
  if (url === lessonUrl) return { loaded: true, data: lesson }
  if (url && url.startsWith('/analysis/project/class-summary')) return { loaded: true, data: { columns: [{ id: 'published', subject: '数学' }], students: [{ student_id: 's1', name: '学生甲', candidate_number: '001', class_rank: 1, total: 92, status: 'completed', scores: { published: { status: 'completed', raw: 92 } } }] } }
  if (url && url.startsWith('/analysis/reports')) return { loaded: true, data: { summary: { records: 1, completed: 1, pending: 0, absent: 0, unscanned: 0 }, reports: { items: { columns: [{ key: 'name', title: '姓名' }, { key: 'q1', title: '第1题' }], rows: [{ student_id: 's1', name: '学生甲', q1: 4 }] } } } }
  return { loaded: true, data: initial }
}
const classSummaryHtml = await render(MobileClassResults, { location: readLocation('#/results?project=exam&cls=own'), navigate: () => {}, onSwitchDesktop: () => {} })
assert.match(classSummaryHtml, /班级成绩总表/)
assert.match(classSummaryHtml, /学生甲/)
assert.match(classSummaryHtml, /导出/)
const cardReportHtml = await render(MobileClassResults, { location: readLocation('#/results?project=exam&cls=own&card=published'), navigate: () => {}, onSwitchDesktop: () => {} })
assert.match(cardReportHtml, /小题分/)
assert.match(cardReportHtml, /成绩与名次/)
assert.match(cardReportHtml, /导出/)
const fromResultsLessonHtml = await render(MobileClassResults, { location: readLocation(classResultsPath({ project: 'exam', cls: 'own' }, 'published')), navigate: () => {}, onSwitchDesktop: () => {} })
assert.match(fromResultsLessonHtml, /返回班级成绩/)
assert.match(fromResultsLessonHtml, /本班示例甲/)

// Invalid explicit card or mismatched grade+cls must not load student details or silently fall back
const invalidDetailCalls = []
customUseResource = (url, initial) => {
  if (url === '/analysis/class-catalog') return { loaded: true, data: catalog }
  if (url) invalidDetailCalls.push(url)
  return { loaded: true, data: initial }
}
const badCardHtml = await render(MobileClassResults, { location: readLocation('#/results?project=exam&cls=own&card=nonexistent'), navigate: () => {}, onSwitchDesktop: () => {} })
assert.doesNotMatch(badCardHtml, /学生甲|班级成绩总表/)
assert.match(badCardHtml, /重新选择班级|查看本班总表/)
assert.deepEqual(invalidDetailCalls, [], 'Invalid explicit card must not fetch student details')

const badGradeHtml = await render(MobileClassResults, { location: readLocation('#/results?project=exam&grade=id:g1&cls=own'), navigate: () => {}, onSwitchDesktop: () => {} })
assert.doesNotMatch(badGradeHtml, /学生甲|班级成绩总表/)
assert.match(badGradeHtml, /重新选择班级/)
assert.deepEqual(invalidDetailCalls, [], 'Mismatched grade+cls must not fetch student details')
customUseResource = null
console.log('Mobile lesson passed: native route, scoped catalog and statistics, drawer controls, classroom privacy, class comparison, class results/reports/export, and offline guard')
