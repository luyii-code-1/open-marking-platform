import {useEffect,useRef,useState} from 'react'
import {Alert,App,Collapse,Empty,Input,Select,Space,Typography} from 'antd'
import {LeftOutlined,RightOutlined} from '@ant-design/icons'
import {Button} from './Button'
import type {Question} from './api'
import {applyAnswers,answerLetters} from './objectiveLayout'
import {answerEntryKey,chooseAnswer} from './answerEntryLogic'

export function AnswerEntry({questions,onChange,readOnly=false,active=true}:{questions:Question[];onChange:(questions:Question[])=>void;readOnly?:boolean;active?:boolean}){
  const rows=questions.filter(question=>question.type!=='subjective').sort((a,b)=>a.number-b.number)
  const [index,setIndex]=useState(0),[pasted,setPasted]=useState(''),[error,setError]=useState('')
  const keys=useRef<HTMLDivElement>(null),{message}=App.useApp()
  const current=rows[Math.min(index,rows.length-1)]
  useEffect(()=>{if(!active)return;setIndex(0);setPasted('');setError('');const frame=requestAnimationFrame(()=>keys.current?.focus());return()=>cancelAnimationFrame(frame)},[active])
  function move(offset:number){setIndex(value=>Math.max(0,Math.min(rows.length-1,value+offset)));keys.current?.focus()}
  function choose(letter:string){
    if(!current||readOnly)return
    try{
      const next=chooseAnswer(current,letter)
      onChange(questions.map(question=>question.id===next.id?next:question));setError('')
      if(current.type==='single')setIndex(value=>Math.min(value+1,rows.length-1))
      keys.current?.focus()
    }catch(e){setError((e as Error).message)}
  }
  if(!current)return <Empty description="没有待录入的客观题"/>
  return <Space direction="vertical" size={16} style={{width:'100%'}}>
    <Space wrap><Typography.Text type="secondary">已录入 {rows.filter(question=>question.answer.length).length} / {rows.length} 题</Typography.Text><Select aria-label="答案录入题号" value={current.id} options={rows.map(question=>({value:question.id,label:`第 ${question.number} 题${question.answer.length?' · '+question.answer.join(''):' · 待录入'}`}))} onChange={id=>{setIndex(rows.findIndex(question=>question.id===id));keys.current?.focus()}}/></Space>
    <div className="answer-entry" ref={keys} tabIndex={0} role="group" aria-label="点击选项或使用数字键录入标准答案" onKeyDown={event=>{
      if(event.target!==event.currentTarget||readOnly||event.repeat||event.nativeEvent.isComposing||event.ctrlKey||event.altKey||event.metaKey)return
      const action=answerEntryKey(event.key,current)
      if(!action)return
      event.preventDefault();if(action.letter)choose(action.letter);else move(action.offset||0)
    }}>
      <Typography.Text type="secondary">{Math.min(index+1,rows.length)} / {rows.length} · {current.type==='single'?'单选题':'多选题'}</Typography.Text><Typography.Title level={3}>第 {current.number} 题</Typography.Title>
      <div className="answer-buttons">{[...answerLetters.slice(0,current.options)].map((letter,option)=><Button size="large" key={letter} disabled={readOnly} aria-label={`选项 ${letter}，快捷键 ${option+1}`} aria-pressed={current.answer.includes(letter)} type={current.answer.includes(letter)?'primary':'default'} onClick={()=>choose(letter)}>{letter}</Button>)}</div>
      <Typography.Text type="secondary">数字 1–5 或 A–E 选择答案。单选自动下一题，多选按 Enter 或 6 继续。</Typography.Text>
      <Space className="answer-pagination"><Button icon={<LeftOutlined/>} disabled={index===0||readOnly} onClick={()=>move(-1)}>上一题</Button><Button icon={<RightOutlined/>} iconPosition="end" disabled={index>=rows.length-1||readOnly} onClick={()=>move(1)}>下一题</Button></Space>
    </div>

    {error&&<Alert type="error" showIcon message={error}/>}
    <Collapse style={{width:'100%'}} items={[{key:'paste',label:'粘贴整组答案',children:<Space direction="vertical" size={12} style={{width:'100%'}}><Typography.Text type="secondary">按上方题号顺序用空格或换行分隔，例如 A BC D；也可每行填写“1: A”。全为单选时支持连续字母。</Typography.Text><Input.TextArea rows={5} disabled={readOnly} value={pasted} onChange={event=>{setPasted(event.target.value);setError('')}} aria-label="整组标准答案"/><Button disabled={readOnly||!pasted.trim()} onClick={()=>{try{const next=applyAnswers(questions,pasted);onChange(next);setError('');message.success('答案已校验并填入')}catch(e){setError((e as Error).message)}}}>校验并填入答案</Button></Space>} ]}/>
  </Space>
}
