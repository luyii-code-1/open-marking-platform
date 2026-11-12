import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'

const source=await readFile(new URL('../src/updatePolicy.ts',import.meta.url),'utf8')
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}})
const {canAutomaticallyUpdate,beginMutation,hasPendingMutations,automaticPwaUpdates}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const idle={now:20000,lastActivity:0,editing:false,mutating:false,dirty:false}
assert.ok(canAutomaticallyUpdate(idle))
for(const blocked of [{now:14999},{editing:true},{mutating:true},{dirty:true}])assert.equal(canAutomaticallyUpdate({...idle,...blocked}),false)
beginMutation('GET')();assert.equal(hasPendingMutations(),false)
const first=beginMutation('POST'),second=beginMutation('PUT')
first();first();assert.equal(hasPendingMutations(),true)
second();assert.equal(hasPendingMutations(),false)

let clock=100000,online=true,visible=true,ready=false,attempts=0,checks=0,reported=0,failCheck=false
const messages=[],registration=new EventTarget(),worker=new EventTarget()
registration.waiting=null;registration.installing=worker
registration.update=async()=>{checks++;if(failCheck)throw new TypeError('network')}
worker.postMessage=value=>messages.push(value)
const flush=()=>new Promise(resolve=>setTimeout(resolve,0))
const updates=automaticPwaUpdates({
  register:async()=>{attempts++;if(attempts===1)throw new TypeError('network');return registration},
  ready:()=>ready,onReady:()=>reported++,visible:()=>visible,online:()=>online,now:()=>clock,
})
try{
  await flush();assert.equal(attempts,1)
  online=false;updates.tick();await flush();assert.equal(attempts,1)
  online=true;updates.tick();await flush();assert.equal(attempts,2);assert.equal(reported,1);assert.equal(checks,1)
  registration.waiting=worker;worker.state='installed';worker.dispatchEvent(new Event('statechange'))
  assert.equal(messages.length,0,'Dirty or active pages must defer activation')
  ready=true;visible=false;updates.tick();assert.equal(messages.length,0)
  visible=true;updates.tick();assert.deepEqual(messages,[{type:'PREPARE_UPDATE'}])
  updates.tick();assert.equal(messages.length,1,'An unready peer window must not cause a tight activation loop')
  clock+=30000;updates.tick();assert.equal(messages.length,2)
  registration.waiting=null;clock+=300000;failCheck=true;updates.tick();await flush()
  assert.equal(checks,2)
  clock+=30000;failCheck=false;updates.tick();await flush();assert.equal(checks,3,'An update check must recover after network failure')
}finally{updates.stop()}
clock+=300000;updates.tick();assert.equal(checks,3)
console.log('Automatic updates passed: idle/input/write guards, registration recovery, background checks, hidden windows, activation backoff and cleanup')
