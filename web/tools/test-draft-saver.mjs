import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
const source=await readFile(new URL('../src/draftSaver.ts',import.meta.url),'utf8')
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
const {DraftSaver}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
let resolve,requests=[]
const saver=new DraftSaver({id:'a',name:'start'},job=>{requests.push(job);return new Promise(r=>resolve=r)},()=>{})
saver.edit({...saver.value,name:'first'})
const pending=saver.flush();assert.equal(saver.flush(),pending)
assert.throws(()=>saver.load({id:'b'}))
saver.edit({...saver.value,name:'second'})
resolve({...requests[0].value,draft_version:1});await new Promise(r=>setTimeout(r,0))
assert.equal(saver.value.name,'second');assert.equal(requests[1].base_version,1)
resolve({...requests[1].value,draft_version:2});await pending
assert.equal(saver.dirty,false);assert.equal(saver.value.name,'second')
let fail=true,jobs=[]
const retry=new DraftSaver({id:'r',name:'draft'},async job=>{jobs.push(job);if(fail)throw new Error('network');return {...job.value,draft_version:jobs.length}},()=>{})
retry.edit({...retry.value,name:'one'});await assert.rejects(retry.flush());assert.equal(retry.dirty,true)
retry.edit({...retry.value,name:'two'});fail=false;await retry.flush()
assert.equal(jobs[0].request_id,jobs[1].request_id);assert.equal(jobs[2].value.name,'two');assert.equal(retry.dirty,false)
console.log('Draft writer: concurrent edits, serialization, retry identity and switching passed')
