import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'

const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const url=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64')
const objectiveUrl=url(compile(await readFile(new URL('../src/objectiveLayout.ts',import.meta.url),'utf8')))
const source=compile(await readFile(new URL('../src/answerEntryLogic.ts',import.meta.url),'utf8')).replace("'./objectiveLayout'",JSON.stringify(objectiveUrl))
const {answerEntryKey,chooseAnswer,completeAnswerMap,answersComplete}=await import(url(source))
const single={id:'single',number:1,type:'single',options:4,answer:[]}
const multi={id:'multi',number:7,type:'multiple',options:3,answer:[]}
assert.deepEqual(answerEntryKey('1',single),{letter:'A'})
assert.deepEqual(answerEntryKey('c',single),{letter:'C'})
assert.equal(answerEntryKey('5',single),null)
assert.equal(answerEntryKey('D',multi),null)
for(const key of ['6','Enter','ArrowRight'])assert.deepEqual(answerEntryKey(key,single),{offset:1})
assert.deepEqual(answerEntryKey('ArrowLeft',single),{offset:-1})
assert.deepEqual(chooseAnswer(single,'B').answer,['B'])
assert.deepEqual(chooseAnswer({...single,answer:['B']},'A').answer,['A'])
const selected=chooseAnswer(chooseAnswer(multi,'C'),'A')
assert.deepEqual(selected.answer,['A','C'])
assert.deepEqual(chooseAnswer(selected,'C').answer,['A'])
assert.equal(answersComplete([single,selected]),false)
assert.throws(()=>completeAnswerMap([single,selected]),/第1题/)
assert.deepEqual(completeAnswerMap([chooseAnswer(single,'D'),selected]),{single:['D'],multi:['A','C']})
assert.equal(answersComplete([]),false)
assert.deepEqual(single.answer,[])
console.log('Shared answer entry passed: keyboard bounds, single/multiple selection and complete answer validation')
