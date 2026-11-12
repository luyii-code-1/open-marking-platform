import assert from 'node:assert/strict'
import vm from 'node:vm'
import path from 'node:path'
import {readFile} from 'node:fs/promises'

const origin='https://marking.test',root=path.resolve('dist'),handlers=new Map(),stores=new Map()
let offline=false,skipped=0,claimed=0
let clients=[],replies=new Map(),messages=[]
const key=request=>new URL(typeof request==='string'?request:request.url,origin).pathname
const caches={
  async keys(){return [...stores.keys()]},
  async delete(name){return stores.delete(name)},
  async open(name){
    if(!stores.has(name))stores.set(name,new Map())
    const data=stores.get(name)
    return {
      async addAll(urls){for(const url of urls)data.set(key(url),new Response(await readFile(path.join(root,key(url)))))},
      async match(request){return data.get(key(request))?.clone()},
    }
  },
}
// The app must neither read nor delete an unrelated app's cache.
stores.set('unrelated',new Map([['/index.html',new Response('other app')]]))
stores.set('omp-shell-old',new Map([['/assets/previous.js',new Response('previous-version')]]))
stores.set('omp-shell-older',new Map())
stores.set('omp-review-private',new Map())
const self={location:{origin},addEventListener:(name,callback)=>handlers.set(name,callback),clients:{async claim(){claimed++},async matchAll(){return clients}},async skipWaiting(){skipped++}}
const context=vm.createContext({self,caches,URL,Response,setTimeout:(f,ms)=>setTimeout(f,Math.min(ms,50)),clearTimeout,fetch:async request=>{if(offline)throw new TypeError('offline');return new Response(`network:${key(request)}`)}})
vm.runInContext(await readFile(path.join(root,'worker.js'),'utf8'),context)
async function event(name,value={}) {
  const waits=[];let response
  handlers.get(name)({...value,waitUntil:promise=>waits.push(promise),respondWith:promise=>{response=Promise.resolve(promise)}})
  await Promise.all(waits)
  return response
}
await event('install')
assert.equal(skipped,0,'Installing an update must not activate it before confirmation')
const current=(await caches.keys()).find(name=>stores.get(name)?.has('/index.html')&&name.startsWith('omp-shell-'))
assert.ok(current)
await event('activate')
assert.equal(claimed,1);assert.ok(stores.has('unrelated'));assert.ok(stores.has('omp-shell-old'),'Old shell must remain while old windows are open')
for(const request of [
  {url:origin+'/api/v1/results?group_id=x',method:'GET',mode:'cors'},
  {url:origin+'/api/v1/tasks/x/score',method:'POST',mode:'cors'},
  {url:origin+'/api/v1/archive-download/secret',method:'GET',mode:'navigate'},
  {url:'https://external.test/index.html',method:'GET',mode:'cors'},
])assert.equal(await event('fetch',{request}),undefined,'Private/API/cross-origin requests must bypass the worker')
offline=true
const page=await event('fetch',{request:{url:origin+'/',method:'GET',mode:'navigate'}})
assert.match(await page.text(),/Open Marking Platform/)
const asset=[...stores.get(current).keys()].find(name=>name.endsWith('.js'))
assert.ok(asset)
assert.ok((await event('fetch',{request:{url:origin+asset,method:'GET',mode:'cors'}})).ok)
assert.equal(await event('fetch',{request:{url:origin+asset+'?private=1',method:'GET',mode:'cors'}}),undefined)
assert.ok(![...stores.get(current).keys()].some(url=>url.startsWith('/api/')))
await event('message',{data:{type:'OTHER'}});assert.equal(skipped,0)
function client(id){return {id,url:origin+'/',postMessage(data){messages.push({id,...data});if(data.type==='CHECK_UPDATE'&&replies.has(id))queueMicrotask(()=>void event('message',{source:{id},data:{type:'UPDATE_READY',requestId:data.requestId,ready:replies.get(id)}}))}}}
clients=[client('one'),client('two')];replies.set('one',true);replies.set('two',false)
await event('message',{source:client('one'),data:{type:'PREPARE_UPDATE'}})
assert.equal(skipped,0);assert.ok(messages.some(m=>m.type==='UPDATE_ABORTED'))
messages=[];replies.set('two',true)
await event('message',{source:client('one'),data:{type:'PREPARE_UPDATE'}})
assert.equal(skipped,1);assert.equal(messages.filter(m=>m.type==='UPDATE_COMMIT').length,2)
replies.delete('two');messages=[]
await event('message',{source:client('one'),data:{type:'PREPARE_UPDATE'}})
assert.equal(skipped,1,'Non-responsive windows must prevent update');assert.ok(messages.some(m=>m.type==='UPDATE_ABORTED'))
await event('message',{source:client('one'),data:{type:'SKIP_WAITING'}})
assert.equal(skipped,1,'Legacy clients must not force-update other windows')
assert.equal(await (await event('fetch',{request:{url:origin+'/assets/previous.js',method:'GET',mode:'cors'}})).text(),'previous-version')
const version=current.slice('omp-shell-'.length)
await event('message',{source:client('one'),data:{type:'CLIENT_READY',build:version}})
assert.ok(stores.has('omp-shell-older'))
await event('message',{source:{id:'two'},data:{type:'CLIENT_READY',build:version}})
assert.equal([...stores.keys()].filter(k=>k.startsWith('omp-shell-')).length,2)
assert.ok(stores.has('unrelated')&&stores.has('omp-review-private'),'Only shell caches may be pruned')
clients=[client('one')]
await event('message',{source:client('one'),data:{type:'SKIP_WAITING'}});assert.equal(skipped,2)
console.log('PWA worker passed: pinned offline shell, API bypass, two-window readiness/refusal/timeout, legacy gating, old assets and isolated cache pruning')
