import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
const source=await readFile(new URL('../src/reviewInteraction.ts',import.meta.url),'utf8')
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
const {focusScoreInput,scorePresets,previousReview}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const calls=[]
const input={disabled:false,focus(options){calls.push(['focus',options])},select(){calls.push(['select'])}}
focusScoreInput({querySelector(){return input}})
assert.deepEqual(calls,[['focus',{preventScroll:true}],['select']],'Keyboard returns to the score and selects its old value without scrolling')
input.disabled=true;focusScoreInput({querySelector(){return input}});focusScoreInput(null)
assert.equal(calls.length,2)
assert.deepEqual(scorePresets(2,.5),[0,.5,1,1.5,2])
assert.deepEqual(scorePresets(1,.3),[0,.3,.6,.9,1])
assert.equal(scorePresets(100,.01).at(-1),100)
assert.ok(scorePresets(100,.01).length<=25)
const rows=[{id:'recent'},{id:'middle'},{id:'first'}]
assert.equal(previousReview(rows,'new')?.id,'recent')
assert.equal(previousReview(rows,'recent')?.id,'middle')
assert.equal(previousReview(rows,'middle')?.id,'first')
assert.equal(previousReview(rows,'first'),undefined)
assert.equal(previousReview([],undefined),undefined)
console.log('Review interaction passed: focus/select without scroll, fractional presets, previous review ordering and boundaries')
