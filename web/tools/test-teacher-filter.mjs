import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'

const code=await readFile(new URL('../src/teacherFilter.ts',import.meta.url),'utf8')
const {outputText}=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}})
const {matchingTeachers,emptyTeacherFilter}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'))
const users=['a','b','c'].map(id=>({id}))
const classes=[
  {id:'1',grade_id:'g1',teacher_ids:['a','b'],teaching:{a:{subjects:['数学']},b:{subjects:['语文'],homeroom:true}}},
  {id:'2',grade_id:'g2',teacher_ids:['a'],teaching:{a:{subjects:['语文'],homeroom:true}}},
  {id:'3',grade:'g1',teacher_ids:['a']}
]
function ids(filter){return matchingTeachers(users,classes,{...emptyTeacherFilter,...filter}).map(u=>u.id)}
assert.deepEqual(ids({}),['a','b','c'])
assert.deepEqual(ids({grades:['g1'],subjects:['语文']}),['b'])
assert.deepEqual(ids({grades:['g1','g2'],subjects:['语文'],homeroom:true}),['a','b'])
assert.deepEqual(ids({classes:['1'],subjects:['数学','语文']}),['a','b'])
assert.deepEqual(ids({classes:['3']}),['a'])
assert.deepEqual(ids({classes:['3'],subjects:['数学']}),[])
console.log('Teacher relationship filter checks passed.')
