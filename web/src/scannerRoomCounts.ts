type LocalScan = { group_id:string; room_tags?:{id:string}[]; status:string; scanned_sheets?:number; paired_sheets?:number }

export function scannerRoomCounts(scans:LocalScan[],groupId:string,roomId?:string){
  const local=scans.filter(scan=>scan.group_id===groupId&&
    (roomId?scan.room_tags?.some(tag=>tag.id===roomId):!scan.room_tags?.length))
  const waiting=local.filter(scan=>scan.status==='local_paired')
  return {
    scanned:local.every(scan=>scan.scanned_sheets!==undefined)?local.reduce((n,scan)=>n+scan.scanned_sheets!,0):null,
    pending:waiting.every(scan=>scan.paired_sheets!==undefined)?waiting.reduce((n,scan)=>n+scan.paired_sheets!,0):null,
  }
}
