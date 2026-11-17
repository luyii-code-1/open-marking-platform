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
assert.equal(first.pages.length,50)
assert.deepEqual(first.pages.slice(-2).map(p=>[p.batch_id,p.side,p.sheet_number]),[['sheet24','front',25],['sheet24','back',25]])
const second=await scannerRoomState(call,'sheet0',2)
assert.equal(second.pages.length,6)
assert.equal(second.pages[0].batch_id,'sheet25')
assert.equal(second.pages.at(-1).sheet_number,28)
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
