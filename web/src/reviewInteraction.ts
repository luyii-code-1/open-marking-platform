export function focusScoreInput(container: Pick<HTMLElement, 'querySelector'> | null) {
  const input=container?.querySelector<HTMLInputElement>('input')
  if(!input||input.disabled)return
  input.focus({preventScroll:true})
  input.select()
}

export function scorePresets(points:number,step:number) {
  const interval=Math.max(.01,step)
  const count=Math.floor((points+1e-8)/interval)
  // Keep the familiar first values and full marks available on large score ranges.
  const values=Array.from({length:Math.min(count+1,24)},(_,i)=>Number((i*interval).toFixed(2)))
  if(values.at(-1)!==points)values.push(points)
  return values
}

// History is displayed newest first; previous moves toward earlier reviews.
export function previousReview<T extends {id:string}>(rows:T[],currentId?:string) {
  const index=rows.findIndex(row=>row.id===currentId)
  return rows[index<0?0:index+1]
}
