import {useState} from 'react'
import {Alert,Empty,Select,Spin,Tabs} from 'antd'
import {LeftOutlined,RightOutlined} from '@ant-design/icons'
import {Button} from './Button'
import {useResource,type Row} from './api'
import './paper-lesson.css'

export type LessonScope={project?:string;grade?:string;cls?:string;card?:string}
type Question={
  id:string;number:string;type:string;points:number;average:number|null;count:number
  bands?:{lower:number;upper:number;inclusive:boolean;count:number}[]
  answer?:string[];options?:Record<string,string[]>;correct?:number;graded?:number;correct_rate?:number|null
}
type Averages=Record<string,number|undefined>
type Comparison={grade_wide:boolean;averages:Averages;classes:{name:string;averages:Averages}[]}
type Lesson={group_id:string;class_id:string;full_score:number;questions:Question[];comparison:Comparison}
const order=(a:string,b:string)=>a.localeCompare(b,'zh-CN',{numeric:true})
const gradeKey=(cls:Row)=>cls.grade_id?'id:'+cls.grade_id:'legacy:'+(cls.grade||'')
const gradeLabel=(cls:Row)=>cls.grade||'未设置年级'
const format=(value:number|null|undefined)=>value==null?'—':String(value)

function QuestionResult({q}:{q:Question}){
  if(q.type==='subjective')return <div>
    <p className="lesson-metric">班级均分 <strong>{format(q.average)}</strong> 分 <span>已评分 {q.count} 人</span></p>
    <table className="lesson-bands"><thead><tr><th>得分区间</th><th>人数</th><th>占比</th></tr></thead>
      <tbody>{q.bands?.map(b=><tr key={b.lower}><td>{b.lower} ≤ 得分 {b.inclusive?'≤':'<'} {b.upper}</td><td>{b.count}</td><td>{q.count?(100*b.count/q.count).toFixed(1)+'%':'—'}</td></tr>)}</tbody>
    </table></div>
  return <div>
    <p className="lesson-metric">正确率 <strong className="lesson-rate">{q.correct_rate==null?'—':q.correct_rate+'%'}</strong>
      <span>完全答对 {q.correct} / {q.graded} 人</span><span>班级均分 {format(q.average)} 分</span></p>
    <p>标准答案 <b>{q.answer?.join('、')||'待录入'}</b>　·　有效实考 {q.count} 人</p>
    <div className="lesson-options">{Object.entries(q.options||{}).map(([option,names])=><details key={option}>
      <summary><b>{option==='blank'?'留空':option}</b><span>{names.length} 人</span><span>{q.count?(100*names.length/q.count).toFixed(1)+'%':'—'}</span></summary>
      <div>{names.length?[...names].sort(order).join('、'):'无人选择'}</div>
    </details>)}</div>
    <small>留空计入有效实考人数。{q.type==='multiple'?'多选按全部选项一致计为答对，选中多个选项的学生列入各对应选项。':''}</small>
  </div>
}

function ClassChart({comparison,metric,maximum}:{comparison:Comparison;metric:string;maximum:number}){
  const avg=comparison.averages[metric]
  const rows=[...comparison.classes].sort((a,b)=>order(a.name,b.name))
  const ceiling=Math.max(1,maximum,...rows.map(r=>r.averages[metric]??0))
  const height=(n:number)=>Math.max(0,Math.min(100,n*100/ceiling))+'%'
  return <section className="lesson-chart" aria-label="同题卡班级均分对比">
    <p className="lesson-metric">{comparison.grade_wide?'年级均分':'可见班级均分'} <strong>{format(avg)}</strong> 分 <span>按有有效得分的学生人数加权</span></p>
    <div className="lesson-chart-scroll" tabIndex={0} aria-label="各班均分，横向滚动">
      <div className="lesson-plot" style={{minWidth:Math.max(240,rows.length*78)}}>
        {avg!=null&&<div className="lesson-mean-line" style={{bottom:height(avg)}}/>}
        {rows.map((row,index)=>{
          const v=row.averages[metric]
          return <div className="lesson-chart-column" key={index} aria-label={row.name+'，'+(v==null?'暂无成绩':v+' 分')}>
            <div className="lesson-bar" style={{height:v==null?0:height(v)}}><b>{format(v)}</b></div>
            <div className="lesson-bar-label" title={row.name}>{row.name}</div>
          </div>
        })}
      </div>
    </div>
  </section>
}

function LessonContent({card,cls}:{card:Row;cls:Row}){
  const params=new URLSearchParams({group_id:card.id,class_id:cls.id})
  const data=useResource<Lesson|null>('/analysis/paper-lesson?'+params,null)
  const [tab,setTab]=useState('questions'),[index,setIndex]=useState(0),[metric,setMetric]=useState('total')
  if(data.error)return <Alert type="error" message={data.error} action={<Button onClick={data.reload}>重试</Button>}/>
  if(!data.data)return <Spin/>
  const {questions,comparison,full_score}=data.data
  if(!questions.length)return <Empty description="题卡暂无评分项"/>
  const q=questions[Math.min(index,questions.length-1)]
  const options=questions.map((v,i)=>({value:i,label:'第 '+v.number+' 题'}))
  return <section className="class-report-panel">
    <Tabs activeKey={tab} onChange={setTab} items={[{key:'questions',label:'逐题讲评'},{key:'compare',label:'跨班均分'}]}/>
    {tab==='questions'?<>
      <div className="lesson-question-nav">
        <Button aria-label="上一题" icon={<LeftOutlined/>} disabled={index===0} onClick={()=>setIndex(index-1)}/>
        <Select aria-label="讲评题号" showSearch optionFilterProp="label" value={index} options={options} onChange={setIndex}/>
        <Button aria-label="下一题" icon={<RightOutlined/>} disabled={index>=questions.length-1} onClick={()=>setIndex(index+1)}/>
        <span>{q.type==='subjective'?'主观题':q.type==='multiple'?'多选题':'单选题'} · 满分 {q.points} 分</span>
        <Button type="link" onClick={()=>{setMetric(q.id);setTab('compare')}}>对比本题均分</Button>
      </div>
      <QuestionResult key={q.id} q={q}/>
    </>:<>
      <Select aria-label="均分对比项目" showSearch optionFilterProp="label" value={metric} options={[{value:'total',label:'整卷原始总分'},...questions.map(v=>({value:v.id,label:'第 '+v.number+' 题'}))]} onChange={setMetric}/>
      <ClassChart comparison={comparison} metric={metric} maximum={questions.find(v=>v.id===metric)?.points??full_score}/>
    </>}
  </section>
}

export function PaperLesson({initial}:{initial:LessonScope}){
  const catalog=useResource<{projects:Row[]}>('/analysis/class-catalog',{projects:[]})
  const [choice,setChoice]=useState(initial)
  if(catalog.error)return <Alert type="error" message={catalog.error} action={<Button onClick={catalog.reload}>重试</Button>}/>
  if(!catalog.loaded)return <Spin/>
  const projects=catalog.data.projects.filter(p=>p.cards.some((c:Row)=>c.published&&c.class_ids.length))
  const project=projects.find(p=>p.id===choice.project)||projects[0]
  if(!project)return <Empty description="暂无可讲评的已发布题卡"/>
  const published:Row[]=project.cards.filter((c:Row)=>c.published)
  const classes:Row[]=project.classes.filter((c:Row)=>published.some(card=>card.class_ids.includes(c.id)))
  const grades=new Map(classes.map(c=>[gradeKey(c),gradeLabel(c)]))
  const requested=classes.find(c=>c.id===choice.cls)
  const grade=choice.grade&&grades.has(choice.grade)?choice.grade:gradeKey(requested||classes[0])
  const gradeClasses=classes.filter(c=>gradeKey(c)===grade).sort((a,b)=>order(a.name,b.name))
  const cls=gradeClasses.find(c=>c.id===choice.cls)||gradeClasses[0]
  const cards=published.filter(c=>c.class_ids.includes(cls.id))
  const card=cards.find(c=>c.id===choice.card)||cards[0]
  return <section className="class-results">
    <div className="lesson-selectors">
      <label>考试<Select aria-label="讲评考试" showSearch optionFilterProp="label" value={project.id} options={projects.map(p=>({label:p.name,value:p.id}))} onChange={id=>setChoice({project:id})}/></label>
      <label>年级<Select aria-label="讲评年级标签" value={grade} options={[...grades].map(([value,label])=>({label,value}))} onChange={g=>setChoice({project:project.id,grade:g})}/></label>
      <label>班级<Select aria-label="讲评班级" showSearch optionFilterProp="label" value={cls.id} options={gradeClasses.map(c=>({label:c.name,value:c.id}))} onChange={id=>setChoice({project:project.id,grade,cls:id,card:card?.id})}/></label>
      <label>科目题卡<Select aria-label="讲评题卡" showSearch optionFilterProp="label" value={card?.id} options={cards.map(c=>({label:c.subject+' · '+c.name,value:c.id}))} onChange={id=>setChoice({project:project.id,grade,cls:cls.id,card:id})}/></label>
    </div>
    {card&&<LessonContent key={card.id+':'+cls.id} card={card} cls={cls}/>}
  </section>
}
