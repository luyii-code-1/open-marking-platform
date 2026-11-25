import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const compile=async file=>ts.transpileModule(await readFile(new URL('../src/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const sharedSource=await compile('sharedSession.ts'),apiSource=await compile('api.ts')
const shared={exports:{}}
vm.runInNewContext(sharedSource,{exports:shared.exports,module:shared,setTimeout,clearTimeout})
const {SharedSession,UserActivity,sessionKey}=shared.exports
function storage(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)}}
const persistent=storage(),old=storage();old.setItem('omp-token','legacy');old.setItem('omp-review-user','user-a')
const a=new SharedSession(persistent,old,()=>5000),b=new SharedSession(persistent,storage(),()=>5000)
assert.equal(a.token(),'legacy');assert.equal(old.getItem('omp-token'),null)
const changes=[];b.subscribe(value=>changes.push(value?.token||''))
a.login('shared',{expires_at:112,server_time:100,user:{id:'user-a'}});b.refresh()
assert.equal(b.token(),'shared');assert.equal(a.snapshot().deadline,17000)
assert.equal(new SharedSession(persistent,storage()).token(),'shared','Reload uses the same persistent login')
b.update('shared',{expires_at:200,server_time:110});a.refresh()
a.update('shared',{expires_at:150,server_time:110})
assert.equal(a.snapshot().expires_at,200,'A stale reply cannot shorten a renewed lease')
b.login('next',{expires_at:300,server_time:110,user:{id:'user-b'}})
assert.equal(a.clear('shared'),false,'An old 401 or logout cannot clear a new login')
assert.equal(a.update('shared',{expires_at:500,server_time:120}),false)
assert.equal(a.token(),'next');assert.equal(a.snapshot().user_id,'user-b')
b.clear('next');a.refresh();assert.equal(a.token(),'');assert.equal(persistent.getItem(sessionKey),null)
const stale=storage();stale.setItem('omp-token','legacy')
assert.equal(new SharedSession(persistent,stale).token(),'','Migration cannot resurrect a logged-out legacy tab')

let now=0,serial=0;const jobs=new Map(),calls=[]
const schedule=(fn,ms)=>{const id=++serial;jobs.set(id,{at:now+ms,fn});return id},cancel=id=>jobs.delete(id)
const tick=async ms=>{now+=ms;for(const [id,job] of [...jobs])if(job.at<=now){jobs.delete(id);job.fn()}await Promise.resolve();await Promise.resolve()}
const activity=new UserActivity(async idle=>calls.push({idle,at:now}),()=>now,schedule,cancel)
activity.interact(false);assert.equal(calls.length,0)
activity.interact(true);await tick(100);activity.interact(true);await tick(400);activity.interact(true);await tick(500)
assert.equal(calls.length,1,'Repeated input must not write a session lease every second')
await tick(29000)
assert.equal(calls.length,2);assert.equal(calls[1].idle,29500,'Trailing renewal carries the elapsed time since the last real action')
await tick(12*3600*1000);assert.equal(calls.length,2,'No idle timer generates renewal traffic')
activity.interact(true);await tick(10);activity.interact(true);activity.stop();await tick(1000)
assert.equal(calls.length,3,'Logout cancels a pending trailing renewal')
const leaving=new UserActivity(async idle=>calls.push({idle,at:now}),()=>now,schedule,cancel)
leaving.interact(true);await tick(10);leaving.interact(true);await tick(20);leaving.flushPending()
assert.equal(calls.at(-1).idle,20,'Page exit flushes the last actual input without counting exit as activity')
const flushed=calls.length;await tick(2000);leaving.flushPending()
assert.equal(calls.length,flushed,'Page exit does not manufacture a renewal when no input is pending')
leaving.stop()

// Native browser timers reject a UserActivity instance as their receiver.
const browserTimers={exports:{}}
let nativeScheduled=0,nativeCancelled=0
vm.runInNewContext(sharedSource,{exports:browserTimers.exports,module:browserTimers,
  setTimeout:function(){assert.equal(this,undefined);nativeScheduled++;return 1},
  clearTimeout:function(){assert.equal(this,undefined);nativeCancelled++}})
const nativeActivity=new browserTimers.exports.UserActivity(async()=>{},()=>1)
nativeActivity.interact(true);await new Promise(resolve=>setImmediate(resolve))
nativeActivity.interact(true);nativeActivity.stop()
assert.equal(nativeScheduled,1);assert.equal(nativeCancelled,1)

const subscriptions=[],timers=new Map(),sockets=[]
class MockSocket {
  static OPEN=1
  static CLOSED=3
  readyState=0
  constructor(){sockets.push(this)}
  close(){assert.equal(this.readyState,MockSocket.OPEN,'Finish the handshake before closing');this.readyState=3}
  send(){assert.fail('A retired connection must not authenticate')}
}
const realtime={exports:{}}
vm.runInNewContext(await compile('RealtimeStatus.tsx'),{
  module:realtime,exports:realtime.exports,
  require:name=>name==='react'?{useRef:current=>({current}),useEffect:fn=>subscriptions.push(fn)}:{currentToken:()=>'session'},
  WebSocket:MockSocket,URL,location:new URL('https://exam.test'),navigator:{onLine:true},
  window:new EventTarget(),document:new EventTarget(),
  setTimeout:fn=>{const id=Symbol();timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id),
})
realtime.exports.RealtimeStatus({user:{id:'teacher'}})
const startSocket=subscriptions.at(-1)
startSocket()()
assert.equal(timers.size,0,'A remount before the scheduled connection leaves no socket')
const stopSocket=startSocket()
for(const run of timers.values())run()
assert.equal(sockets.length,1);stopSocket()
sockets[0].readyState=MockSocket.OPEN;sockets[0].onopen()
assert.equal(sockets[0].readyState,MockSocket.CLOSED)

const nav={exports:{}},windowEvents=new EventTarget()
let disposeGuard
vm.runInNewContext(await compile('useNavigation.ts'),{exports:nav.exports,module:nav,
  window:windowEvents,require:()=>({useEffect:effect=>{disposeGuard=effect()}})})
nav.exports.useUnsavedChanges(true,true)
const refresh=new Event('beforeunload',{cancelable:true})
Object.defineProperty(refresh,'returnValue',{writable:true,value:''})
windowEvents.dispatchEvent(refresh)
assert.ok(refresh.defaultPrevented)
assert.ok(nav.exports.hasUnsavedChanges())
assert.ok(nav.exports.confirmLeaving(),'A durable upload can continue after in-app navigation')
disposeGuard()
assert.equal(windowEvents.dispatchEvent(new Event('beforeunload',{cancelable:true})),true)
assert.equal(nav.exports.hasUnsavedChanges(),false)

const readsModule={exports:{}}
vm.runInNewContext(await compile('resourceReads.ts'),{module:readsModule,exports:readsModule.exports,structuredClone})
const reads=new readsModule.exports.ResourceReads()
const resolvers=[]
const startRead=()=>new Promise(resolve=>resolvers.push(resolve))
const oldRead=reads.read('a','/dashboard',startRead)
const joined=reads.read('a','/dashboard',startRead)
const otherUser=reads.read('b','/dashboard',startRead)
assert.equal(resolvers.length,2,'Concurrent readers may only share a GET within one session')
reads.invalidate()
const fresh=reads.read('a','/dashboard',startRead)
resolvers[0]({count:1});resolvers[1]({count:2})
const original=await oldRead
const copy=await joined
assert.equal(copy.count,original.count);assert.notEqual(copy,original)
assert.equal((await otherUser).count,2)
const refreshed=reads.read('a','/dashboard',startRead,true)
const afterRefresh=reads.read('a','/dashboard',startRead)
resolvers[2]({count:3});resolvers[3]({count:4})
assert.equal((await fresh).count,3);assert.equal((await refreshed).count,4);assert.equal((await afterRefresh).count,4)
assert.equal(await reads.read('a','/dashboard',async()=>5),5,'Completed results must not survive as a private API cache')

function browser(local){
  const win=new EventTarget(),module={exports:{}};let handler=async()=>new Response('{}')
  const dependencies={react:{},'./sharedSession':shared.exports,'./resourceReads':readsModule.exports,'./networkPolicy':{resilientFetch:(...args)=>handler(...args)},'./updatePolicy':{beginMutation:()=>()=>{},watchMutations:()=>{},hasPendingMutations:()=>false}}
  vm.runInNewContext(apiSource,{exports:module.exports,module,require:name=>dependencies[name],
    localStorage:local,sessionStorage:storage(),window:win,EventTarget,Event,CustomEvent,Headers,FormData,fetch:(...args)=>handler(...args),setTimeout,clearTimeout})
  return {api:module.exports,setFetch:fn=>handler=fn,refresh(){const event=new Event('storage');Object.defineProperty(event,'key',{value:sessionKey});win.dispatchEvent(event)}}
}
const local=storage(),first=browser(local),second=browser(local),lease={expires_at:100,server_time:1,user:{id:'a'}}
first.api.setToken('one',lease);second.refresh();assert.equal(second.api.currentToken(),'one')
let complete
first.setFetch(()=>new Promise(resolve=>complete=resolve))
const pending=first.api.request('/dashboard').catch(error=>error)
second.api.setToken('two',lease);complete(new Response('{"detail":"expired"}',{status:401}));await pending
assert.equal(first.api.currentToken(),'two','An in-flight request from the old login cannot sign out the replacement login')
first.setFetch(async()=>new Response('{"detail":"wrong password"}',{status:401}))
await first.api.request('/auth/login',{method:'POST',body:'{}'}).catch(()=>{})
assert.equal(first.api.currentToken(),'two','An invalid login attempt does not invalidate an existing session')
await first.api.request('/dashboard').catch(()=>{});second.refresh()
assert.equal(first.api.currentToken(),'');assert.equal(second.api.currentToken(),'')
first.api.setToken('kicked-token',lease)
first.setFetch(async()=>new Response('{"detail":"replaced"}',{status:401,headers:{'X-OMP-Session-Ended':'replaced'}}))
await first.api.request('/dashboard').catch(()=>{})
assert.equal(first.api.currentToken(),'')
assert.ok(first.api.currentSessionNotice().includes('其他设备登录'),'Replaced session stores kicked-offline notice')
first.api.setToken('fresh-token',lease)
assert.equal(first.api.currentSessionNotice(),'','Fresh login clears previous session notice')
console.log('Shared browser login passed: persistence, cross-tab login/logout, renewal ordering, trusted input, idle behavior, kicked notice and stale-request isolation')
