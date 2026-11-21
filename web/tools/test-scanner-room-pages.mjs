import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const source=fs.readFileSync(new URL('../src/scannerRoomPages.ts',import.meta.url),'utf8')
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {scannerRoomState}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'))
const sheets=Array.from({length:28},(_,i)=>({id:'sheet'+i,group_id:'card',room_tags:[{id:'room'}],created_at:String(i).padStart(3,'0'),total:2,front_count:1,back_count:1,status:'local_paired'}))
const all=[...sheets,{...sheets[0],id:'other-room',room_tags:[{id:'elsewhere'}]},{...sheets[0],id:'other-card',group_id:'elsewhere'}]
const calls=[]
const call=async(method,args)=>{
  calls.push(args)
  return {batches:all,pages:['front','back'].map((side,index)=>({id:args.batch_id+side,side,sequence:1})).slice(args.offset,args.offset+50),page_total:2}
}
const first=await scannerRoomState(call,'sheet0',1)
assert.equal(first.page_total,56)
assert.equal(first.paper_total,28)
assert.equal(first.pages.length,56)
assert.deepEqual(first.pages.slice(-2).map(p=>[p.batch_id,p.side,p.sheet_number]),[['sheet27','front',28],['sheet27','back',28]])
const second=await scannerRoomState(call,'sheet0',2)
assert.equal(second.pages.length,0)
assert.deepEqual(first.papers[25].front.id,'sheet25front')
assert.deepEqual(first.papers[25].back.id,'sheet25back')
assert(!calls.some(a=>String(a.batch_id).startsWith('other')))
const rows=Array.from({length:103},(_,i)=>({id:String(i),sequence:i+1,side:'front'}))
const single=async(method,args)=>({batches:[{...sheets[0],total:103,front_count:103,back_count:0}],pages:rows.slice(args.offset,args.offset+50)})
const tail=await scannerRoomState(single,'sheet0',3)
assert.equal(tail.pages.length,3)
assert.equal(tail.pages[0].sheet_number,101)
let count=0
const native=await scannerRoomState(async()=>{count++;return {room_pages:true,pages:[],page_total:0}},'sheet0',1)
assert.equal(count,1)
assert.equal(native.page_total,0)
console.log('Scanner room pages passed: continuous duplex, paging, room/card scope and per-row actions')

const run=await scannerRoomState(call,'sheet0',1,{anchorId:'sheet0',previousIds:all.slice(0,26).map(b=>b.id)})
assert.deepEqual(run.pages.map(r=>r.batch_id),['sheet0','sheet0','sheet26','sheet26','sheet27','sheet27'])
assert.equal(run.page_total,6)
console.log('Current acquisition excludes earlier records and includes every new sheet')

const passes=(side,n)=>Array.from({length:n},(_,i)=>({id:side+i,sequence:i+1,side,status:'pending',batch_id:'b'}))
const front=passes('front',55),back=passes('back',54)
function host(faces,settings={},pairs=[]){
  const b={id:'b',group_id:'g',created_at:'0',sides:2,total:faces.length,front_count:faces.filter(f=>f.side==='front').length,back_count:faces.filter(f=>f.side==='back').length,...settings}
  return async(method,args)=>method==='pageReview'?pairs:{batches:[b],room_pages:true,pages:faces.slice(args.offset,args.offset+50)}
}
const normal=host([...front,...back],{capture_mode:'duplex'})
const head=await scannerRoomState(normal,'b',1),tailPairs=await scannerRoomState(normal,'b',2)
assert.equal(head.papers.length,50)
assert.equal(head.papers[49].back.id,'back49')
assert.equal(tailPairs.papers[0].front.id,'front50')
assert.equal(tailPairs.papers.at(-1).front.id,'front54')
assert.equal(tailPairs.papers.at(-1).back,undefined)
const reverse=await scannerRoomState(host([...front,...back],{capture_mode:'separate',back_order:'reverse'}),'b',1)
assert.equal(reverse.papers[0].back,undefined)
assert.equal(reverse.papers[1].back.id,'back53')
const confirmed=await scannerRoomState(host([...front.slice(0,2),...back.slice(0,2)],{capture_mode:'separate',paired_sheets:2},[
  {sides:[front[0],back[1]]},{sides:[front[1],back[0]]}
]),'b',1)
assert.equal(confirmed.papers[0].back.id,'back1')
const excludedFront={...front[0],status:'excluded'}
const excluded=await scannerRoomState(host([excludedFront,front[1],back[1]],{capture_mode:'duplex',pending:2,blocked:0,uploaded:0}),'b',1)
assert.equal(excluded.papers[0].back,undefined)
assert.equal(excluded.papers[1].front.sequence,excluded.papers[1].back.sequence)
console.log('Physical sheets stay together across face chunks, missing sides, reverse passes and exclusions')
