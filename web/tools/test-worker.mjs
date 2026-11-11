import assert from 'node:assert/strict'
import vm from 'node:vm'
import path from 'node:path'
import {readFile} from 'node:fs/promises'

const origin='https://marking.test',root=path.resolve('dist'),handlers=new Map(),stores=new Map()
let offline=false,skipped=0,claimed=0
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
stores.set('omp-shell-old',new Map())
const self={location:{origin},addEventListener:(name,callback)=>handlers.set(name,callback),clients:{async claim(){claimed++}},async skipWaiting(){skipped++}}
const context=vm.createContext({self,caches,URL,Response,fetch:async request=>{if(offline)throw new TypeError('offline');return new Response(`network:${key(request)}`)}})
vm.runInContext(await readFile(path.join(root,'worker.js'),'utf8'),context)
async function event(name,value={}) {
  const waits=[];let response
  handlers.get(name)({...value,waitUntil:promise=>waits.push(promise),respondWith:promise=>{response=Promise.resolve(promise)}})
  await Promise.all(waits)
  return response
}
await event('install')
assert.equal(skipped,0,'Installing an update must not activate it before confirmation')
const current=(await caches.keys()).find(name=>name.startsWith('omp-shell-')&&name!=='omp-shell-old')
assert.ok(current)
await event('activate')
assert.equal(claimed,1);assert.ok(stores.has('unrelated'));assert.ok(!stores.has('omp-shell-old'))
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
await event('message',{data:{type:'SKIP_WAITING'}});assert.equal(skipped,1)
console.log('PWA worker: shell install/offline assets, private API bypass, isolated caches, confirmed update passed')
