import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
let source=await readFile(new URL('../src/reviewImages.ts',import.meta.url),'utf8')
source=source.replace("import {request,requestBlob} from './api'",'const request=globalThis.apiRequest,requestBlob=globalThis.apiBlob')
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
let proxyCalls=0,directCalls=0,mode='good'
const blob=new Blob(['full-page']),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')
globalThis.apiBlob=async()=>{proxyCalls++;return blob}
globalThis.createImageBitmap=async value=>{assert.equal(await value.text(),'full-page');return {width:840,height:1188,close(){}}}
globalThis.fetch=async(url,options)=>{directCalls++;assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');if(mode==='cors')throw new TypeError('CORS');return {ok:mode!=='expired',blob:async()=>mode==='wrong'?new Blob(['wrong']):blob}}
const {downloadReviewSheet}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const manifest={pages:[{key:'page:hash',sha256:sha,direct_url:'https://example.test/signed',proxy_url:'/tasks/t/image-source/0',width:840,height:1188}],regions:[{page:0,rect:[40,440,400,120]},{page:0,rect:[40,600,400,80]}]}
let sheet=await downloadReviewSheet(manifest);assert.equal(sheet.pages.length,1);assert.equal(directCalls,1);assert.equal(proxyCalls,0);assert.equal(await sheet.pages[0].blob.text(),'full-page');assert.equal(JSON.stringify(sheet).includes('https://'),false)
for(mode of ['cors','expired','wrong']){const before=proxyCalls;await downloadReviewSheet(manifest);assert.equal(proxyCalls,before+1)}
const before=directCalls;await downloadReviewSheet({...manifest,pages:[{...manifest.pages[0],direct_url:undefined}]});assert.equal(directCalls,before)
await assert.rejects(downloadReviewSheet({...manifest,regions:[{page:0,rect:[0,0,841,100]}]}),/区域/)
console.log('Review images passed: full-page download, multi-region reuse, CORS/expired/hash fallback, proxy mode, bounds and no persisted signed URL')
