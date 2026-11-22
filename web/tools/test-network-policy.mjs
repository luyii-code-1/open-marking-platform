import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
const {outputText}=ts.transpileModule(await readFile(new URL('../src/networkPolicy.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
const {resilientFetch,setServiceSlow,serviceIsSlow}=await import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'))
const originalTimer=globalThis.setTimeout
globalThis.setTimeout=(callback)=>{queueMicrotask(callback);return 1}
try{
  let calls=0
  globalThis.fetch=async()=>{calls++;return new Response('',{status:calls<3?503:200})}
  assert.equal((await resilientFetch('/read')).status,200)
  assert.equal(calls,3)
  calls=0
  globalThis.fetch=async()=>{calls++;return new Response('',{status:503})}
  assert.equal((await resilientFetch('/score',{method:'POST',body:'score'})).status,503)
  assert.equal(calls,1,'Mutation requests must never be automatically replayed')
  calls=0
  globalThis.fetch=async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'120'}})}
  assert.equal((await resilientFetch('/read')).status,429)
  assert.equal(calls,1,'Long rate-limit windows are returned without aggressive retries')
  setServiceSlow(true);assert.equal(serviceIsSlow(),true)
}finally{globalThis.setTimeout=originalTimer}
console.log('Network retry policy passed: bounded reads, Retry-After and single-write delivery')
