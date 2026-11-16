export const paperFonts=[{value:'OMP Sans',label:'黑体'},{value:'OMP Serif',label:'宋体'}]
export function paperFont(value:string){
  const name=value.replace(/["']/g,'').split(',')[0].trim().toLowerCase()
  if(/serif|times|simsun|songti|fangsong|宋|仿宋|楷/.test(name)&&!/sans/.test(name))return 'OMP Serif'
  if(/sans|arial|helvetica|calibri|courier|mono|yahei|simhei|heiti|dengxian|黑|雅黑|等线/.test(name))return 'OMP Sans'
  return ''
}
export function hexColor(value:string){
  const input=value.trim().toLowerCase()
  if(/^#[0-9a-f]{6}$/.test(input))return input.toUpperCase()
  if(/^#[0-9a-f]{3}$/.test(input))return '#'+[...input.slice(1)].map(char=>char+char).join('').toUpperCase()
  const rgb=/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(1(?:\.0*)?))?\s*\)$/.exec(input)
  if(rgb&&rgb.slice(1,4).every(part=>Number(part)<=255))return '#'+rgb.slice(1,4).map(part=>Number(part).toString(16).padStart(2,'0')).join('').toUpperCase()
  const names:Record<string,string>={black:'#000000',white:'#FFFFFF',red:'#FF0000',blue:'#0000FF',green:'#008000',yellow:'#FFFF00'}
  return names[input]||''
}
export function pointLength(value:string,min:number,max:number){
  const match=/^(-?\d+(?:\.\d+)?)\s*(pt|px|mm|cm|in)?$/i.exec(value.trim())
  if(!match)return ''
  const factors:Record<string,number>={pt:1,px:.75,mm:72/25.4,cm:720/25.4,in:72}
  const points=Number(match[1])*(factors[match[2]?.toLowerCase()||'pt'])
  return Number.isFinite(points)&&points>=min&&points<=max?String(Math.round(points*100)/100)+'pt':''
}
export function enclosedText(value:string){return value.replace(/[\u0000-\u001f\u007f]/g,'').trim()}
export function enclosedTextError(value:string){const count=[...enclosedText(value)].length;return count<1?'请输入带圈文字':count>8?'带圈文字最多 8 个字':''}
export function paragraphIndent(left:number,first:number){return Math.max(0,Math.min(144,Math.max(left,-first)))}

export class EditorHistory<T>{
  private entries:T[]=[]
  private cursor=-1
  private group=''
  private time=0
  reset(value:T){this.entries=[value];this.cursor=0;this.group='';this.time=0}
  record(value:T,group='command',time=Date.now()){
    const merge=group==='typing'&&this.group===group&&time-this.time<650&&this.cursor>0&&this.cursor===this.entries.length-1
    this.entries=this.entries.slice(0,this.cursor+1)
    if(merge)this.entries[this.cursor]=value
    else {this.entries.push(value);this.cursor++;if(this.entries.length>100){this.entries.shift();this.cursor--}}
    this.group=group;this.time=time
  }
  undo(){this.group='';if(this.cursor<=0)return null;return this.entries[--this.cursor]}
  redo(){this.group='';if(this.cursor>=this.entries.length-1)return null;return this.entries[++this.cursor]}
  breakGroup(){this.group=''}
}
