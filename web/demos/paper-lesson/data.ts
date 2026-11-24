import type {Comparison,Question} from '../../src/LessonStatistics'

type Item = {number:string; type:'single'|'multiple'|'subjective'; points:number; title:string; stem:string; choices:string[]; key:string; explanation:string}
export const paper:Item[]=[
  {number:'1',type:'single',points:2,title:'平均速度',stem:'一辆小车沿直线向东行驶，前 4 s 的位移为 12 m，后 6 s 的位移为 18 m。全程平均速度的大小是多少？',choices:['2 m/s','3 m/s','5 m/s','6 m/s'],key:'B',explanation:'全程位移为 30 m，总时间为 10 s，平均速度大小为 3 m/s。'},
  {number:'2',type:'multiple',points:4,title:'速度与加速度',stem:'关于直线运动中的速度和加速度，下列说法正确的是哪些？',choices:['加速度为零时，速度可以不为零','速度为零时，加速度一定为零','加速度方向与速度方向相反时，速率减小','加速度越大，物体的速度一定越大'],key:'AC',explanation:'加速度描述速度的变化快慢。速度为零的瞬间也可以有加速度，例如竖直上抛到达最高点时。'},
  {number:'3',type:'single',points:2,title:'牛顿第二定律',stem:'质量为 2 kg 的物体在水平面上运动，受到的水平合力为 6 N。物体加速度的大小是多少？',choices:['1 m/s²','2 m/s²','3 m/s²','12 m/s²'],key:'C',explanation:'由 F = ma，a = 6 ÷ 2 = 3 m/s²。题目给出的是合力。'},
  {number:'4',type:'single',points:2,title:'位移与路程',stem:'运动员沿半径为 50 m 的圆形跑道恰好跑完一圈。终点相对起点的位移大小是多少？',choices:['0 m','50 m','100 m','100π m'],key:'A',explanation:'起点与终点重合，位移为零。100π m 是跑过的路程。'},
  {number:'5～6',type:'subjective',points:8,title:'刹车过程',stem:'汽车以 12 m/s 的初速度做匀减速直线运动，加速度大小为 3 m/s²。\n（5）求停车所用时间。\n（6）求从开始刹车到停下的位移大小。',choices:[],key:'',explanation:'以初速度方向为正，0 = 12 − 3t，解得 t = 4 s。平均速度为 6 m/s，位移为 6 × 4 = 24 m。'}
]
export const classNames=['高一（1）班','高一（2）班']
type Answers=[string,string,string,string,number]
const samples:Answers[][]=[
 [['B','AC','C','A',8],['B','A','C','A',6],['B','ACD','C','D',4],['A','C','C','A',6],['B','','C','A',2],['D','AD','B','D',0],['B','AC','C','A',7],['C','A','C','A',4]],
 [['B','AC','C','A',8],['B','AC','C','A',8],['A','C','C','A',6],['B','AC','C','D',4],['B','ACD','B','A',5],['B','AC','C','A',7]]
]
function points(q:Item, answer:string|number){
  if(typeof answer==='number')return answer
  if(answer===q.key)return q.points
  return q.type==='multiple' && answer.length>0 && [...answer].every(c=>q.key.includes(c)) ? 2 : 0
}
const mean=(values:number[])=>values.reduce((a,b)=>a+b,0)/values.length
export function summary(ci:number,index:number):Question{
  const q=paper[index], rows=samples[ci], scores=rows.map(r=>points(q,r[index]))
  const base={id:'q'+index,number:q.number,type:q.type,points:q.points,average:mean(scores),count:rows.length}
  if(q.type==='subjective')return {...base,bands:[0,2,4,6].map(lower=>({lower,upper:lower+2,inclusive:lower===6,count:scores.filter(s=>s>=lower&&(lower===6||s<lower+2)).length}))}
  const options:Record<string,string[]>={A:[],B:[],C:[],D:[],blank:[]}
  rows.forEach((r,i)=>{const value=String(r[index]);for(const c of value?[...value]:['blank'])options[c].push('学生 '+String(i+1).padStart(2,'0'))})
  const correct=rows.filter(r=>r[index]===q.key).length
  return {...base,answer:[...q.key],options,correct,graded:rows.length,correct_rate:Math.round(correct/rows.length*10000)/100}
}
function averages(rows:Answers[]){
  const values:Record<string,number>={}
  paper.forEach((q,i)=>{values['q'+i]=mean(rows.map(r=>points(q,r[i])))})
  values.total=Object.values(values).reduce((a,b)=>a+b,0)
  return Object.fromEntries(Object.entries(values).map(([key,v])=>[key,Number(v.toFixed(2))]))
}
export const comparison:Comparison={grade_wide:true,averages:averages(samples.flat()),classes:samples.map((rows,i)=>({name:classNames[i],averages:averages(rows)}))}
export const fullScore=paper.reduce((sum,q)=>sum+q.points,0)
export const rate=(ci:number,i:number)=>(summary(ci,i).average??0)/paper[i].points*100
