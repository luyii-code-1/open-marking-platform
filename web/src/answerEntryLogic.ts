import type {Question} from './api'
import {parseAnswer,answerLetters} from './objectiveLayout'

export function answerEntryKey(key:string,question:Pick<Question,'options'>):{letter?:string;offset?:number}|null{
  const letter=/^[1-7]$/.test(key)?answerLetters[Number(key)-1]:/^[a-g]$/i.test(key)?key.toUpperCase():''
  if(letter&&answerLetters.slice(0,question.options).includes(letter))return {letter}
  if(['Enter','8','ArrowRight'].includes(key)||(key==='6'&&question.options<=5))return {offset:1}
  if(key==='ArrowLeft')return {offset:-1}
  return null
}

export function chooseAnswer(question:Question,letter:string):Question{
  const answer=question.type==='single'?letter:question.answer.includes(letter)?question.answer.filter(value=>value!==letter).join(''):[...question.answer,letter].join('')
  return {...question,answer:parseAnswer(question,answer)}
}

export function completeAnswerMap(questions:Question[]):Record<string,string[]>{
  if(!questions.length)throw new Error('没有需要录入的客观题')
  const answers:Record<string,string[]>={}
  for(const question of questions){
    if(question.type==='subjective')throw new Error('标准答案录入仅适用于客观题')
    answers[question.id]=parseAnswer(question,question.answer.join(''),false)
  }
  return answers
}

export function answersComplete(questions:Question[]){
  try{completeAnswerMap(questions);return true}catch{return false}
}
