type Row=Record<string,any> & {id:string}
type Call=(method:string,args:Record<string,unknown>)=>Promise<any>
const roomKey=(row:Row)=>(row.room_tags||[]).map((t:Row)=>t.id).sort().join(',')

export type ScanRun={anchorId:string;previousIds:string[]}

export async function scannerRoomState(call:Call,batchId:string,page:number,run?:ScanRun){
  const offset=(page-1)*50
  const state=await call('state',{batch_id:batchId,offset,page_scope:'room',run:run||null})
  if(!batchId||state.room_pages)return state
  const selected=state.batches.find((b:Row)=>b.id===batchId)
  if(!selected)return state
  const sheets:Row[]=state.batches.filter((b:Row)=>b.group_id===selected.group_id&&roomKey(b)===roomKey(selected)&&
    (!run||b.id===run.anchorId||!run.previousIds.includes(b.id)))
    .sort((a:Row,b:Row)=>a.created_at.localeCompare(b.created_at))
  const rows:Row[]=[]
  let position=0,sheetNumber=0
  for(const sheet of sheets){
    const total=sheet.total||0
    const from=Math.max(0,offset-position),to=Math.min(total,offset+50-position)
    if(from<to){
      for(let start=Math.floor(from/50)*50;start<to;start+=50){
        const response=sheet.id===batchId&&start===offset?state:await call('state',{batch_id:sheet.id,offset:start})
        for(const row of response.pages.slice(Math.max(0,from-start),Math.min(50,to-start))){
          rows.push({...row,batch_id:sheet.id,batch_status:sheet.status,sheet_number:sheetNumber+row.sequence})
        }
      }
    }
    position+=total
    sheetNumber+=Math.max(sheet.front_count||0,sheet.back_count||0)
  }
  return {...state,room_pages:true,page_total:position,pages:rows}
}
