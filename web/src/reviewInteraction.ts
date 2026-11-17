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

export function scoreInputError(raw:string,points:number,step=.5):string {
  const text=raw.trim()
  if(!text)return '请先输入分数'
  if(!/^-?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text))return '请输入数字，最多保留两位小数'
  const score=Number(text)
  if(!Number.isFinite(score)||score<0||score>points)return `本题满分 ${points} 分，请输入 0～${points} 分`
  if(!(step>0)||Math.round(score*100)%Math.round(step*100)!==0)return `本题按 ${step} 分递增，请调整分数`
  return ''
}

// History is displayed newest first; previous moves toward earlier reviews.
export function previousReview<T extends {id:string}>(rows:T[],currentId?:string) {
  const index=rows.findIndex(row=>row.id===currentId)
  return rows[index<0?0:index+1]
}
