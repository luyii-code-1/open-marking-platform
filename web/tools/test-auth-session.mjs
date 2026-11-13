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
assert.equal(calls.length,2);assert.equal(calls[1].idle,500,'Trailing renewal carries the elapsed time since the last real action')
await tick(12*3600*1000);assert.equal(calls.length,2,'No idle timer generates renewal traffic')
activity.interact(true);await tick(10);activity.interact(true);activity.stop();await tick(1000)
assert.equal(calls.length,3,'Logout cancels a pending trailing renewal')
const leaving=new UserActivity(async idle=>calls.push({idle,at:now}),()=>now,schedule,cancel)
leaving.interact(true);await tick(10);leaving.interact(true);await tick(20);leaving.flushPending()
assert.equal(calls.at(-1).idle,20,'Page exit flushes the last actual input without counting exit as activity')
const flushed=calls.length;await tick(2000);leaving.flushPending()
assert.equal(calls.length,flushed,'Page exit does not manufacture a renewal when no input is pending')
leaving.stop()

function browser(local){
  const win=new EventTarget(),module={exports:{}};let handler=async()=>new Response('{}')
  vm.runInNewContext(apiSource,{exports:module.exports,module,require:name=>name==='react'?{}:name==='./sharedSession'?shared.exports:name==='./updatePolicy'?{beginMutation:()=>()=>{}}:null,
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
console.log('Shared browser login passed: persistence, cross-tab login/logout, renewal ordering, trusted input, idle behavior and stale-request isolation')
