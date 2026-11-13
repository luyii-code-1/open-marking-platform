import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { indexedDB } from 'fake-indexeddb'

globalThis.indexedDB=indexedDB
globalThis.sessionStorage={setItem(){}}
async function sourceUrl(name,replacements={}){
  let source=await readFile(new URL('../src/'+name,import.meta.url),'utf8')
  for(const [from,to] of Object.entries(replacements))source=source.replaceAll(from,to)
  const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
}
const storeUrl=await sourceUrl('reviewStore.ts'),store=await import(storeUrl)
const {syncReviewRecords}=await import(await sourceUrl('reviewSync.ts',{"'./reviewStore'":JSON.stringify(storeUrl)}))
const owner='teacher-1',question={id:'q1',number:1,type:'subjective',points:10,step:.5},template={id:'t1',name:'题卡',group_id:'g1',revision:1}
const task=id=>({id,question_id:'q1',status:'claimed',score_revision:0})
const image=new Blob(['answer-image'],{type:'image/png'})
let offline=false,login=false,mismatch=false,protocol=true,responseLost=false,conflict='',calls=0
const receipts=new Map()
async function transport(path,body){
  if(offline)throw new TypeError('Server unavailable')
  if(login)return {status:401,body:{}}
  if(path==='/auth/me')return {status:200,body:{id:mismatch?'other-teacher':owner}}
  if(path==='/review/offline-capabilities')return {status:protocol?200:404,body:{protocols:protocol?[1]:[]}}
  calls++
  if(conflict)return {status:409,body:{detail:conflict}}
  const row=receipts.get(body.idempotency_key)||{id:path.split('/')[2],status:'completed',score:body.score,score_revision:1,accepted_operation:{id:body.idempotency_key,score:body.score}}
  receipts.set(body.idempotency_key,row)
  if(responseLost){responseLost=false;throw new TypeError('Response lost after server commit')}
  return {status:200,body:row}
}
await store.cacheReview(owner,task('one'),template,question,image)
await store.saveReviewDraft(owner,'one',4.5)
await store.settleReviewWrites()
// A new module connection represents reopening after refresh, sharing IndexedDB.
const reopened=await import(await sourceUrl('reviewStore.ts')+'#reopen')
assert.equal((await reopened.getReview(owner,'one')).draft,4.5)
assert.equal(await (await reopened.getReview(owner,'one')).image.text(),'answer-image')
assert.equal((await store.listReviews('other-teacher')).length,0)
const [first,second]=await Promise.all([store.enqueueReview(owner,'one',4.5),reopened.enqueueReview(owner,'one',4.5)])
assert.equal(first.operation.id,second.operation.id,'Two tabs must share one queued operation')
await assert.rejects(store.saveReviewDraft(owner,'one',6))
await store.enqueueReview(owner,'one',4.5) // recovery clears the failed write for this record
offline=true;assert.equal((await syncReviewRecords(owner,transport)).state,'offline');assert.equal((await reopened.getReview(owner,'one')).status,'queued')
offline=false;responseLost=true
assert.equal((await syncReviewRecords(owner,transport)).state,'offline')
assert.equal(receipts.size,1);assert.equal((await store.getReview(owner,'one')).operation.id,first.operation.id)
assert.equal((await syncReviewRecords(owner,transport)).sent,1)
assert.equal(receipts.size,1);assert.equal((await store.getReview(owner,'one')).status,'confirmed')
await store.cacheReview(owner,task('two'),template,question,image);await store.enqueueReview(owner,'two',3)
const before=calls
mismatch=true;assert.equal((await syncReviewRecords(owner,transport)).state,'login');assert.equal(calls,before)
mismatch=false;login=true;assert.equal((await syncReviewRecords(owner,transport)).state,'login');assert.equal(calls,before)
login=false;protocol=false;assert.equal((await syncReviewRecords(owner,transport)).state,'upgrade');assert.equal(calls,before)
protocol=true;conflict='任务已失效，请重新领取'
await syncReviewRecords(owner,transport)
assert.equal((await store.getReview(owner,'two')).status,'conflict')
assert.equal((await store.getReview(owner,'two')).operation.score,3)
const conflictCalls=calls;await syncReviewRecords(owner,transport);assert.equal(calls,conflictCalls,'Conflicts must not retry forever')
store.lockReviewUpdate(true);await assert.rejects(store.cacheReview(owner,task('three'),template,question,image));store.lockReviewUpdate(false)
await store.cacheReview(owner,task('three'),template,question,image)
const saving=store.saveReviewDraft(owner,'three',2.5);await store.settleReviewWrites();await saving
assert.equal((await store.getReview(owner,'three')).draft,2.5)
// Check the page-side update handshake without browser/UI automation.
const workerEvents=new EventTarget(),windowEvents=new EventTarget(),replies=[]
let reloaded=0,dirty=false
workerEvents.controller={postMessage(value){replies.push(value)}}
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{serviceWorker:workerEvents}})
globalThis.window=windowEvents
globalThis.document={activeElement:null,querySelector(){return {getAttribute(){return 'test-build'}}}}
globalThis.location={reload(){reloaded++}}
const navigationUrl='data:text/javascript,export const hasUnsavedChanges=()=>globalThis.testDirty()'
globalThis.testDirty=()=>dirty
const policyUrl=await sourceUrl('updatePolicy.ts'),policy=await import(policyUrl)
let clock=Date.now();const realNow=Date.now;Date.now=()=>clock
await import(await sourceUrl('pwaCoordinator.ts',{"'./reviewStore'":JSON.stringify(storeUrl),"'./useNavigation'":JSON.stringify(navigationUrl),"'./updatePolicy'":JSON.stringify(policyUrl)}))
clock+=16000
const source={postMessage(value){replies.push(value)}}
function message(data){const event=new Event('message');event.data=data;event.source=source;workerEvents.dispatchEvent(event)}
dirty=true;message({type:'CHECK_UPDATE',requestId:'dirty'})
await new Promise(resolve=>setTimeout(resolve,10))
assert.equal(store.isReviewUpdateLocked(),false);assert.ok(replies.some(r=>r.requestId==='dirty'&&!r.ready))
message({type:'UPDATE_ABORTED'});assert.equal(store.isReviewUpdateLocked(),false)
dirty=false
document.activeElement={matches(){return true}}
message({type:'CHECK_UPDATE',requestId:'input'});assert.ok(replies.some(r=>r.requestId==='input'&&!r.ready))
document.activeElement=null
const finish=policy.beginMutation('POST')
message({type:'CHECK_UPDATE',requestId:'posting'});assert.ok(replies.some(r=>r.requestId==='posting'&&!r.ready));finish()
message({type:'CHECK_UPDATE',requestId:'resumed'})
await new Promise(resolve=>setTimeout(resolve,10))
windowEvents.dispatchEvent(new Event('pointerdown'))
assert.ok(replies.some(r=>r.type==='UPDATE_CANCEL'&&r.requestId==='resumed'));assert.equal(store.isReviewUpdateLocked(),false)
clock+=16000
const form={isConnected:true},inputEvent=new Event('input')
Object.defineProperty(inputEvent,'target',{value:{closest(){return form}}})
windowEvents.dispatchEvent(inputEvent);clock+=16000
message({type:'CHECK_UPDATE',requestId:'form'});assert.ok(replies.some(r=>r.requestId==='form'&&!r.ready),'Blurred form changes must still defer updates')
form.isConnected=false
const write=store.saveReviewDraft(owner,'three',3.5)
message({type:'CHECK_UPDATE',requestId:'safe'})
await write;await new Promise(resolve=>setTimeout(resolve,10))
assert.ok(replies.some(r=>r.requestId==='safe'&&r.ready));assert.equal((await store.getReview(owner,'three')).draft,3.5)
message({type:'UPDATE_COMMIT'});workerEvents.dispatchEvent(new Event('controllerchange'));assert.equal(reloaded,1)
store.lockReviewUpdate(false)
Date.now=realNow
const sheet={pages:[{blob:new Blob(['full-sheet']),width:840,height:1188,key:'page:hash'}],regions:[{page:0,rect:[40,440,400,120]}]}
await store.cacheReview(owner,task('full-sheet'),template,question,new Blob([]),sheet)
const restoredSheet=(await reopened.getReview(owner,'full-sheet')).sheet
assert.equal(await restoredSheet.pages[0].blob.text(),'full-sheet');assert.deepEqual(restoredSheet.regions,sheet.regions)
console.log('Offline grading passed: IndexedDB refresh, images/drafts, account isolation, two-tab idempotency, response loss, auth pause, protocol gating, conflict retention and page update handshake')
