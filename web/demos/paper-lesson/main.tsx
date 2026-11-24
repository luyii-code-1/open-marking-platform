import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ConfigProvider} from 'antd'
import {Button} from '../../src/Button'
import {uiTheme} from '../../src/uiTheme'
import {QuestionResult,ClassChart} from '../../src/LessonStatistics'
import {classNames,comparison,fullScore,paper,rate,summary} from './data'
import '../../src/paper-lesson.css'
import './style.css'

const format=(value:number)=>Number(value.toFixed(1)).toString()
function Demo(){
  const [page,setPage]=useState<'lesson'|'grades'>('lesson')
  const [ci,setClass]=useState(0),[source,setSource]=useState(0)
  const [index,setIndex]=useState(0),[sort,setSort]=useState('paper'),[section,setSection]=useState('question')
  const [classroom,setClassroom]=useState(false),[revealed,reveal]=useState(false)
  const [metric,setMetric]=useState('total')
  const order=paper.map((_,i)=>i)
  if(sort==='weak')order.sort((a,b)=>rate(ci,a)-rate(ci,b)||a-b)
  const pos=order.indexOf(index),q=paper[index],result=summary(ci,index)
  const gradeMean=comparison.averages[result.id]??0
  function select(i:number){setIndex(i);setSection('question');reveal(false)}
  function changeClass(c:number){setClass(c);setSort('paper');setMetric('total');select(0)}
  function enter(){setSource(ci);changeClass(ci);setPage('lesson');setClassroom(false)}
  function leave(){changeClass(source);setPage('grades');setClassroom(false)}
  function compare(){setSection('compare');setMetric(result.id)}
  return <main><header><span className="brand">阅卷系统</span><span>教师工作台</span><span className="sample">演示数据</span></header>
    <div className="context"><span>成绩总览　/　物理</span><label>行政班 <select value={ci} onChange={e=>changeClass(Number(e.target.value))}>{classNames.map((c,i)=><option key={c} value={i}>{c}</option>)}</select></label></div>
    <div className="headline"><div><p>高一物理 · 单元测验</p><h1>{page==='grades'?'班级成绩':'运动与力 · 试卷讲评'}</h1></div>
    {page==='lesson'?<Button onClick={leave}>返回班级成绩</Button>:<Button type="primary" onClick={enter}>讲评试卷</Button>}</div>
    {page==='grades'?<article><h2>{classNames[ci]} · 运动与力</h2><p>卷面满分 {fullScore} 分　班级均分 {comparison.classes[ci].averages.total} 分</p><table><thead><tr><th>题号</th><th>考查内容</th><th>均分</th><th>得分率</th></tr></thead><tbody>{paper.map((q,i)=><tr key={q.number}><td>{q.number}</td><td>{q.title}</td><td>{format(summary(ci,i).average??0)}</td><td>{format(rate(ci,i))}%</td></tr>)}</tbody></table></article>:
    <div className="work"><aside><h2>全卷题目</h2><select aria-label="题目排序" value={sort} onChange={e=>setSort(e.target.value)}><option value="paper">按试卷顺序</option><option value="weak">低得分率优先</option></select><nav>{order.map(i=><button type="button" aria-current={index===i?'true':undefined} key={i} onClick={()=>select(i)}><span>{paper[i].number}</span><b>{paper[i].title}</b><small>{format(rate(ci,i))}%</small></button>)}</nav><p>百分比为本班得分率</p></aside>
    <article><div className="row"><span>第 {q.number} 题　·　{q.type==='subjective'?'合并主观题':q.type==='single'?'单选题':'多选题'}　·　{q.points} 分</span><Button onClick={()=>{setClassroom(!classroom);reveal(false);setSection('question')}}>{classroom?'退出课堂讲解':'课堂讲解'}</Button></div>
    <h2 className="topic">{q.title}</h2><p className="stem">{q.stem}</p>{q.choices.length>0&&<ol>{q.choices.map((v,i)=><li key={v}><b>{'ABCD'[i]}</b>{v}</li>)}</ol>}
    {classroom?<section className="analysis"><Button type="primary" onClick={()=>reveal(!revealed)}>{revealed?'收起答案':'揭示答案'}</Button>{revealed&&<p>{q.key&&<strong>答案 {q.key}　</strong>}{q.explanation}</p>}</section>:
    <section className="analysis"><div className="tabs"><button aria-pressed={section==='question'} onClick={()=>setSection('question')}>本班作答</button><button aria-pressed={section==='compare'} onClick={compare}>跨班均分</button></div>
    {section==='question'?<><p className="metrics">本班得分率 <strong>{format(rate(ci,index))}%</strong>　 年级均分 {format(gradeMean)} / {q.points} 分</p><QuestionResult key={ci+'-'+index} q={{...result,average:Number(result.average?.toFixed(2))}}/></>:
    <><select aria-label="比较指标" value={metric} onChange={e=>setMetric(e.target.value)}><option value="total">整卷原始总分</option>{paper.map((v,i)=><option key={i} value={'q'+i}>第 {v.number} 题</option>)}</select><ClassChart comparison={comparison} metric={metric} maximum={metric==='total'?fullScore:paper[Number(metric.slice(1))].points}/></>}</section>}
    <footer><Button disabled={pos===0} onClick={()=>select(order[pos-1])}>上一题</Button><span>{pos+1} / {paper.length} 个评分项</span><Button disabled={pos===order.length-1} onClick={()=>select(order[pos+1])}>下一题</Button></footer></article></div>}
  </main>
}
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={uiTheme}><Demo/></ConfigProvider>)
