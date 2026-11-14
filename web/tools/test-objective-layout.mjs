import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/objectiveLayout.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const { parseQuestionNumbers, parseAnswer, applyAnswers, arrangeObjective, addObjective } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
let sequence = 0
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
const template = { id: uuid(), name: '批量客观题', group_id: uuid(), paper: 'A4', sides: 2, candidate_length: 3, revision: 1, layout_version: 3, questions: [] }
const config = { numbers: '1-60', type: 'single', options: 4, points: 2, columns: 2, startPage: 1 }
assert.deepEqual(parseQuestionNumbers('1-3，7、10～11'), [1, 2, 3, 7, 10, 11])
for (const invalid of ['0', '3-1', '1,1', '1-501', 'abc', '']) assert.throws(() => parseQuestionNumbers(invalid))
const questions = addObjective(template, config, uuid)
assert.equal(questions.length, 60)
assert.equal(questions[0].regions[0].page, 1)
assert.equal(questions[50].regions[0].page, 2)
assert.equal(template.questions.length, 0)
assert.equal(questions[0].choice_style,'compact')
assert.equal(questions[1].regions[0].x,questions[0].regions[0].x)
assert.equal(questions[1].regions[0].y,104.8)
assert.equal(questions[5].regions[0].y,100)
assert.ok(questions[5].regions[0].x>questions[0].regions[0].x)
assert.throws(() => addObjective({ ...template, sides: 1 }, config, uuid), /剩余空间/)
assert.throws(() => addObjective(template, { ...config, columns: 8 }, uuid), /减少客观题列数/)
assert.throws(() => addObjective({ ...template, questions }, config, uuid), /题号已存在/)
const area = { page: 1, x: 12, y: 100, width: 186, height: 34 }
const subjective = { ...questions[0], id: uuid(), number: 100, type: 'subjective', regions: [area] }
const mixed = addObjective({ ...template, questions: [subjective] }, { ...config, numbers: '1-6' }, uuid)
assert.ok(mixed[0].regions[0].y>=134)
assert.equal(mixed.find(q => q.id === subjective.id), subjective)
const answers = applyAnswers(questions, 'ABCD'.repeat(15))
assert.equal(answers[0].answer.join(''), 'A')
assert.equal(answers[59].answer.join(''), 'D')
const multi = { ...questions[1], type: 'multiple', options: 3 }
assert.deepEqual(parseAnswer(multi, 'ca'), ['A', 'C'])
assert.throws(() => parseAnswer(multi, 'D'))
assert.throws(() => parseAnswer(multi, 'AA'))
assert.throws(() => parseAnswer(questions[0], 'AB'))
const pair = [questions[0], { ...multi, number: 7 }]
assert.deepEqual(applyAnswers(pair, '7: BC\n1: A').map(q => q.answer), [['A'], ['B', 'C']])
assert.throws(() => applyAnswers(pair, '1: A\n1: B'))
assert.throws(() => applyAnswers(pair, '1: A\n8: B'))
assert.throws(() => applyAnswers(pair, 'A D'))
assert.throws(() => applyAnswers(pair, 'A'))
assert.equal(questions[0].answer.length, 0)
const a3 = addObjective({ ...template, paper: 'A3', sides: 1 }, { ...config, numbers: '1-80', columns: 4, options: 5 }, uuid)
assert.equal(a3.length, 80)
assert.equal(arrangeObjective({ ...template, questions }, questions.map(q => q.id), { columns: 2, startPage: 1 }).length, questions.length)

const framed={...template,paper:'A3',sheet_columns:3,print_notes:[{page:1,x:12,y:100,width:125,height:5}]}
const auto=addObjective(framed,{...config,numbers:'1-8',columns:0,order:'row'},uuid)
const slots=auto.map(q=>q.regions[0])
assert.ok(slots[0].y>=105 && slots[0].y===slots[1].y && slots[1].y===slots[2].y)
assert.ok(slots[0].x<slots[1].x && slots[1].x<slots[2].x)
assert.equal(slots[3].x,slots[0].x)
assert.ok(slots[3].y>slots[0].y)
assert.equal(new Set(auto.map(q=>q.choice_group)).size,1)

const geometrySource=await readFile(new URL('../src/sheetRegions.ts',import.meta.url),'utf8')
const geometry=ts.transpileModule(geometrySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {subjectiveRegion,uniformSubjectiveWidths}=await import('data:text/javascript;base64,'+Buffer.from(geometry).toString('base64'))
const oldRegions=[20,170,300].map(x=>({page:1,x,y:120,width:35,height:20}))
const adjusted=uniformSubjectiveWidths({...framed,questions:[{...subjective,regions:oldRegions}]})
const fixed=adjusted.questions[0].regions
assert.deepEqual(fixed.map(r=>r.width),[126.6,126.6,126.6])
for(const r of fixed){
  const dragged=subjectiveRegion(framed,1,{x:r.x+4,y:120},{x:410,y:160})
  assert.equal(dragged.x,r.x);assert.equal(dragged.width,r.width);assert.equal(dragged.height,40)
}

const layouts=[{...template,questions:answers},... [2,3].map(sheet_columns=>{
  const sheet={...template,paper:'A3',sheet_columns,sides:2}
  const rows=addObjective(sheet,{...config,numbers:'1-360',columns:sheet_columns===3?3:4,options:5},uuid)
  assert.ok(rows.some(q=>q.regions[0].x>210))
  assert.ok(rows.some(q=>q.regions[0].page===2))
  return {...sheet,questions:applyAnswers(rows,Array(360).fill('E').join(' '))}
})]
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify({ templates:layouts }))
console.log('Objective authoring passed: ranges, duplicates, A3/A4 placement, overflow, obstacle avoidance, answer validation and atomic paste')
