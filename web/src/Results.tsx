import {Tabs} from 'antd'
import {Gradebook} from './Gradebook'
import {ResultOverview} from './ResultOverview'
import {CardWorkflow} from './CardWorkflow'
import {examPath} from './examNavigation'

export function Results({admin,projectId,subjectId,gradeId,groupId}:{admin:boolean;projectId?:string;subjectId?:string;gradeId?:string;groupId?:string;projectOnly?:boolean}){
  if(projectId||groupId)return <>{admin&&groupId&&<CardWorkflow groupId={groupId}/>}<Gradebook projectId={projectId} subjectId={subjectId} gradeId={gradeId} groupId={groupId}/></>
  return <Tabs items={[{key:'compare',label:'多次对比',children:<ResultOverview onOpenExam={id=>{window.location.hash=examPath({projectId:id,section:'summary'})}}/>},{key:'export',label:'导出',children:<Gradebook/>}]}/>
}
