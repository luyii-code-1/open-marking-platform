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
assert.deepEqual(readLocation('#/marking/review/template-a/question-b'), {page:'marking',templateId:'template-a',questionId:'question-b'})
assert.deepEqual(readLocation('#/marking'), {page:'marking'})
assert.deepEqual(readLocation('#/marking/review/template-a'), {page:'marking'})
assert.equal(options[0].children[0].children[0].value, 'unassigned')
assert.equal(options[0].children[0].children[0].children[0].value, 'g1')
assert.equal(options[1].children[0].children[0].children[0].value, 'g2')
assert.equal(options[1].children[0].children[0].children[0].label, '数学题卡')
assert.deepEqual(groupOptions(projects, subjects, []), [])
const graded=[{id:'card-a',name:'物理卷',subject_id:'s1',grade_id:'year-a',grade_name:'高一'},{id:'card-b',name:'物理卷',subject_id:'s1',grade_id:'year-b',grade_name:'高二'}]
for(const section of ['overview','template','roster','scans','marking','exceptions','results']){
  const value={projectId:'p1',subjectId:'s1',gradeId:'year-a',groupId:'card-a',section}
  assert.deepEqual(readLocation(examPath(value)),{page:'exams',...value})
  assert.equal(resolveExam(value,projects,subjects,graded).invalid,false)
}
assert.equal(resolveExam({projectId:'p1',subjectId:'s1',gradeId:'year-a',groupId:'card-b'},projects,subjects,graded).invalid,true)
assert.equal(resolveExam({projectId:'p1',subjectId:'s1',gradeId:'missing'},projects,subjects,graded).invalid,true)
const emptyGradeSubjects=[{...subjects[0],grade_ids:['new-year']}]
assert.equal(resolveExam({projectId:'p1',subjectId:'s1',gradeId:'new-year'},projects,emptyGradeSubjects,[]).invalid,false)
const fourLevels=groupOptions(projects,subjects,graded)
assert.equal(fourLevels[0].children[0].children[0].label,'高一')
assert.equal(fourLevels[0].children[0].children[1].children[0].value,'card-b')
const rowSource=ts.transpileModule(await readFile(new URL('../src/rowNavigation.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {rowNavigation}=await import(`data:text/javascript;base64,${Buffer.from(rowSource).toString('base64')}`)
globalThis.window={getSelection:()=>({toString:()=>''})}
let entered=0;const row=rowNavigation(()=>entered++,'高一物理题卡')
row.onClick({target:{closest:()=>null}});assert.equal(entered,1)
row.onClick({target:{closest:()=>({tagName:'BUTTON'})}});assert.equal(entered,1,'Row actions must not trigger navigation')
let prevented=false;const element={}
row.onKeyDown({target:element,currentTarget:element,key:'Enter',preventDefault:()=>prevented=true})
assert.equal(entered,2);assert.equal(prevented,true)
row.onKeyDown({target:{},currentTarget:element,key:'Enter',preventDefault(){}});assert.equal(entered,2,'Nested controls retain their own keyboard behavior')
window.getSelection=()=>({toString:()=> 'copied text'})
row.onClick({target:{closest:()=>null}});assert.equal(entered,2,'Copying a field must not open the row')
console.log('Exam navigation passed: four-level paths and choices, grade ownership, legacy links, empty grades and scoped creation')
