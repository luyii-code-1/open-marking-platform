import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/examNavigation.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const { examPath, readLocation, resolveExam, defaultGroup, scopedRecord, groupOptions } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const projects = [{ id: 'p1', name: '期中' }, { id: 'p2', name: '期末' }]
const subjects = [{ id: 's1', name: '数学', project_id: 'p1', group_mode: 'custom' }, { id: 's2', name: '数学', project_id: 'p2', group_mode: 'default' }]
const groups = [{ id: 'g1', name: '一中', subject_id: 's1' }, { id: 'g2', name: 'Default', is_default: true, subject_id: 's2' }]

// A copied deep link retains context and the active task after a reload/back navigation.
for (const section of ['overview', 'template', 'roster', 'scans', 'marking', 'exceptions', 'results']) {
  const value = { projectId: 'p1', subjectId: 's1', groupId: 'g1', section }
  assert.deepEqual(readLocation(examPath(value)), { page: 'exams', ...value })
}
assert.deepEqual(readLocation(examPath({ projectId: 'p2', section: 'archives' })), { page: 'exams', projectId: 'p2', section: 'archives' })
assert.deepEqual(readLocation(examPath({ projectId: 'p2', section: 'summary' })), { page: 'exams', projectId: 'p2', section: 'summary' })
assert.equal(resolveExam({ projectId: 'p1', subjectId: 's2', groupId: 'g2' }, projects, subjects, groups).invalid, true)
assert.equal(resolveExam({ projectId: 'p1', subjectId: 's1', groupId: 'g2' }, projects, subjects, groups).invalid, true)
assert.equal(resolveExam({ projectId: 'p2', subjectId: 's2', groupId: 'g2' }, projects, subjects, groups).invalid, false)
assert.equal(defaultGroup(subjects[0], groups), undefined)
assert.equal(defaultGroup(subjects[1], groups)?.id, 'g2')
assert.equal(defaultGroup(subjects[1], [...groups, { id: 'g3', name: '备用', subject_id: 's2' }]), undefined)
assert.equal(readLocation('#/exams/%').page, 'dashboard')
const encoded = { projectId: '考试 / A', subjectId: '数学', groupId: '组#1', section: 'template' }
assert.deepEqual(readLocation(examPath(encoded)), { page: 'exams', ...encoded })

// Creating/importing a child always uses the current parent, even if the input carries another ID.
const input = { name: '数学', project_id: 'p2' }
assert.deepEqual(scopedRecord(input, { project_id: 'p1' }), { name: '数学', project_id: 'p1' })
assert.equal(input.project_id, 'p2')
assert.deepEqual(scopedRecord({ name: '一中', subject_id: 's2' }, { subject_id: 's1' }), { name: '一中', subject_id: 's1' })
const options = groupOptions(projects, subjects, groups)
assert.deepEqual(readLocation('#/login/admin'), {page:'login',section:'admin'})
assert.deepEqual(readLocation('#/login/marking'), {page:'login',section:'marking'})
assert.deepEqual(readLocation('#/login/unknown'), {page:'login',section:undefined})
assert.equal(options[0].children[0].children[0].value, 'g1')
assert.equal(options[1].children[0].children[0].value, 'g2')
assert.equal(options[1].children[0].children[0].label, '默认组')
assert.deepEqual(groupOptions(projects, subjects, []), [])
console.log('Exam navigation passed: deep links, parent ownership, default group, scoped creation/import, same-name hierarchy choices')
