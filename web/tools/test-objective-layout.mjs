import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/objectiveLayout.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const { parseQuestionNumbers, parseAnswer, applyAnswers, arrangeObjective, addObjective } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
let sequence = 0
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
const template = { id: uuid(), name: '批量客观题', group_id: uuid(), paper: 'A4', sides: 2, candidate_length: 3, revision: 1, layout_version: 2, questions: [] }
const config = { numbers: '1-35', type: 'single', options: 4, points: 2, columns: 3, startPage: 1 }
assert.deepEqual(parseQuestionNumbers('1-3，7、10～11'), [1, 2, 3, 7, 10, 11])
for (const invalid of ['0', '3-1', '1,1', '1-501', 'abc', '']) assert.throws(() => parseQuestionNumbers(invalid))
const questions = addObjective(template, config, uuid)
assert.equal(questions.length, 35)
assert.equal(questions[0].regions[0].page, 1)
assert.equal(questions[30].regions[0].page, 2)
assert.equal(template.questions.length, 0)
assert.throws(() => addObjective({ ...template, sides: 1 }, config, uuid), /剩余空间/)
assert.throws(() => addObjective(template, { ...config, columns: 6 }, uuid), /减少列数/)
assert.throws(() => addObjective({ ...template, questions }, config, uuid), /题号已存在/)
const area = { page: 1, x: 12, y: 100, width: 186, height: 34 }
const subjective = { ...questions[0], id: uuid(), number: 100, type: 'subjective', regions: [area] }
const mixed = addObjective({ ...template, questions: [subjective] }, { ...config, numbers: '1-6' }, uuid)
assert.equal(mixed[0].regions[0].y, 136)
assert.equal(mixed.find(q => q.id === subjective.id), subjective)
const answers = applyAnswers(questions, 'ABCD'.repeat(8) + 'ABC')
assert.equal(answers[0].answer.join(''), 'A')
assert.equal(answers[34].answer.join(''), 'C')
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
const a3 = addObjective({ ...template, paper: 'A3', sides: 1 }, { ...config, numbers: '1-60', columns: 6, options: 5 }, uuid)
assert.equal(a3.length, 60)
assert.equal(arrangeObjective({ ...template, questions }, questions.map(q => q.id), { columns: 3, startPage: 1 }).length, questions.length)

if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify({ templates: [{ ...template, questions: answers }, { ...template, paper: 'A3', sides: 1, questions: applyAnswers(a3, Array(60).fill('E').join(' ')) }] }))
console.log('Objective authoring passed: ranges, duplicates, A3/A4 placement, overflow, obstacle avoidance, answer validation and atomic paste')
