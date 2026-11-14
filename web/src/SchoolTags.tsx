import {Tag} from 'antd'

const colors=['blue','green','purple','cyan','geekblue','magenta']
export function gradeColor(name:string){
  const index=['高一','高二','高三'].indexOf(name)
  return colors[index>=0?index:Array.from(name).reduce((n,c)=>n+c.charCodeAt(0),0)%colors.length]
}
export function GradeTag({name}:{name?:string}){
  return name?<Tag color={gradeColor(name)}>{name}</Tag>:<>待设置</>
}
