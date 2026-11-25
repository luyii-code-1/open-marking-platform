type Row=Record<string,any> & {id:string}
type Call=(method:string,args:Record<string,unknown>)=>Promise<any>
export type ScanRun={anchorId:string;previousIds:string[]}
export type Paper={id:string;number:number;duplex:boolean;front?:Row;back?:Row}
const scopeKey=(row:Row)=>row.local_group_id ? 'group:'+row.local_group_id : 'room:'+(row.room_tags||[]).map((t:Row)=>t.id).sort().join(',')
const size=50

export async function scannerRoomState(call:Call,batchId:string,page:number,run?:ScanRun){
  const room={batch_id:batchId,page_scope:'room',run:run||null}
  const state=await call('state',{...room,offset:0})
  const selected=state.batches?.find((b:Row)=>b.id===batchId)
  if(!selected)return {...state,papers:[],paper_total:0}
  const batches:Row[]=state.batches.filter((b:Row)=>b.group_id===selected.group_id&&scopeKey(b)===scopeKey(selected)&&
    (!run||b.id===run.anchorId||!run.previousIds.includes(b.id)))
    .sort((a:Row,b:Row)=>a.created_at.localeCompare(b.created_at))
  const chunks=new Map<string,Row[]>([[state.room_pages?'room:0':batchId+':0',state.pages]])
  const papers:Paper[]=[]
  let paperBase=0,faceBase=0
  const first=(page-1)*size,end=page*size
  for(const batch of batches){
    const fronts=batch.front_count||0,backs=batch.back_count||0
    const duplex=batch.sides===2||backs>0
    let count=Math.max(fronts,backs)
    const pull=async(offset:number):Promise<Row|undefined>=>{
      const pos=state.room_pages?faceBase+offset:offset,start=Math.floor(pos/size)*size
      const key=(state.room_pages?'room':batch.id)+':'+start
      if(!chunks.has(key)){
        const args=state.room_pages?room:{batch_id:batch.id}
        const response=await call('state',{...args,offset:start})
        chunks.set(key,response.pages)
      }
      const row=chunks.get(key)?.[pos-start]
      if(!row||(row.batch_id&&row.batch_id!==batch.id))return undefined
      return {...row,batch_id:batch.id,batch_status:batch.status}
    }
    // Separate passes can exclude and re-pair different sequence numbers.
    // Use the saved capture IDs for these papers, including after re-opening the room.
    const saved=duplex&&batch.total>2&&batch.capture_mode==='separate'&&batch.paired_sheets>0
    const excluded=duplex&&batch.total>(batch.pending??batch.total)+(batch.blocked||0)+(batch.uploaded||0)
    if(saved||excluded){
      const answers:Row[]=saved?await call('pageReview',{batch_id:batch.id}):[]
      const faces=new Map<string,Row>()
      for(let i=0;i<batch.total;i++){const face=await pull(i);if(face)faces.set(face.id,face)}
      const pairs:Row[][]=[]
      for(const answer of answers){
        const sides:Row[]=[]
        for(const side of answer.sides){const row=faces.get(side.id);if(row){sides.push(row);faces.delete(row.id)}}
        if(sides.length)pairs.push(sides)
      }
      if(!saved&&batch.capture_mode==='separate'){
        // Excluded captures do not participate in the manual feed order.
        const active=[...faces.values()].filter(r=>r.status!=='excluded')
        const a=active.filter(r=>r.side==='front'),b=active.filter(r=>r.side==='back')
        const length=Math.max(a.length,b.length)
        for(let j=0;j<length;j++)pairs.push([a[j],b[batch.back_order==='reverse'?length-1-j:j]].filter(Boolean))
        for(const face of faces.values())if(face.status==='excluded')pairs.push([face])
      }else{
        const bySequence=new Map<number,Row[]>()
        for(const face of faces.values()){
          const sequence=bySequence.get(face.sequence)||[]
          sequence.push(face);bySequence.set(face.sequence,sequence)
        }
        pairs.push(...[...bySequence.entries()].sort(([a],[b])=>a-b).map(([,sides])=>sides))
      }
      count=pairs.length
      for(let i=Math.max(0,first-paperBase);i<Math.min(count,end-paperBase);i++){
        const sides=pairs[i],number=paperBase+i+1
        const face=(side:string)=>{const row=sides.find(r=>r.side===side);return row&&{...row,sheet_number:number}}
        papers.push({id:batch.id+':'+sides[0].id,number,duplex,front:face('front'),back:face('back')})
      }
    }else{
      for(let i=Math.max(0,first-paperBase);i<Math.min(count,end-paperBase);i++){
        const number=paperBase+i+1
        const backIndex=batch.back_order==='reverse'?count-i-1:i
        const front=i<fronts?await pull(i):undefined,back=backIndex<backs?await pull(fronts+backIndex):undefined
        papers.push({id:batch.id+':'+i,number,duplex,front:front?.side==='front'&&front.sequence===i+1?{...front,sheet_number:number}:undefined,
          back:back?.side==='back'&&back.sequence===backIndex+1?{...back,sheet_number:number}:undefined})
      }
    }
    faceBase+=batch.total||0;paperBase+=count
  }
  return {...state,room_pages:true,paper_total:paperBase,page_total:faceBase,papers,pages:papers.flatMap(p=>[p.front,p.back].filter(Boolean))}
}
