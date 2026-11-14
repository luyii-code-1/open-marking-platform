import {useState} from 'react'
import {Alert,App,Checkbox,Collapse,Form,Input,InputNumber,Modal,Select,Space,Typography} from 'antd'
import { Table } from './DataTable'
import {Button} from './Button'
import {send,type Row,type Template} from './api'

export function ScoringChanges({template,onSaved}:{template:Template;onSaved:()=>Promise<void>}){
  const [questionId,setQuestionId]=useState('')
  const [open,setOpen]=useState(false),[json,setJson]=useState(''),[reason,setReason]=useState(''),[report,setReport]=useState<Row>(),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),{message}=App.useApp()
  let draft:Row[]=[];try{draft=JSON.parse(json)}catch{}
  const question=template.questions.find(q=>q.id===questionId),entry=Array.isArray(draft)?draft.find(q=>q.id===questionId):undefined,rule=entry?.rule||{mode:'exact'}
  function patch(value:object){setJson(JSON.stringify(draft.map(q=>q.id===questionId?{...q,...value}:q),null,2));setReport(undefined);setConfirmed(false)}
  function patchRule(value:object){patch({rule:{...rule,...value}})}
  async function run(apply=false){setBusy(true);try{
    const questions=JSON.parse(json)
    if(apply){await send(`/templates/${template.id}/scoring`,{questions,reason,confirm:confirmed,preview_sha:report?.preview_sha},'PUT');setOpen(false);await onSaved();message.success('已重新计分，请核对后再次发布成绩')}
    else{setReport(await send(`/templates/${template.id}/scoring-preview`,{questions}));setConfirmed(false)}
  }catch(e){message.error((e as Error).message);setReport(undefined)}finally{setBusy(false)}}
  return <><Button disabled={!template.questions.some(q=>q.type!=='subjective')} onClick={()=>{setJson(JSON.stringify(template.questions.filter(q=>q.type!=='subjective').map(q=>({id:q.id,answer:q.answer,rule:q.rule||{mode:'exact'}})),null,2));setQuestionId(template.questions.find(q=>q.type!=='subjective')?.id||'');setReason('');setReport(undefined);setConfirmed(false);setOpen(true)}}>调整答案与评分</Button>
    <Modal width={850} title="答案与评分复核" open={open} onCancel={()=>!busy&&setOpen(false)} footer={<Space><Button disabled={busy} onClick={()=>setOpen(false)}>取消</Button><Button loading={busy} onClick={()=>run()}>预览影响</Button><Button type="primary" loading={busy} disabled={!report||!confirmed||!reason.trim()} onClick={()=>run(true)}>确认复核并重新计分</Button></Space>}>
      <Space direction="vertical" size={20} style={{width:'100%'}}>
        <Typography.Paragraph>预览受影响的答卷及分数，确认后重新计分并进入待发布状态。</Typography.Paragraph>
        <Form layout="vertical"><Form.Item label="题目"><Select value={questionId} onChange={setQuestionId} options={template.questions.filter(q=>q.type!=='subjective').map(q=>({value:q.id,label:`第 ${q.number} 题 · ${q.points} 分`}))}/></Form.Item>
          {entry&&question&&<><Form.Item label="标准答案"><Select mode="multiple" value={entry.answer} options={'ABCDE'.slice(0,question.options||4).split('').map(value=>({label:value,value}))} onChange={answer=>patch({answer})}/></Form.Item>
          <Form.Item label="给分方式"><Select value={rule.mode||'exact'} options={[{value:'exact',label:'全对得分'},{value:'partial',label:'漏选部分分，错选零分'},{value:'per_option',label:'按正确选项计分'}]} onChange={mode=>patch({rule:{mode}})}/></Form.Item>
          {rule.mode==='partial'&&<Form.Item label="漏选得分"><InputNumber min={0} max={question.points} value={rule.partial_points||0} onChange={v=>patchRule({partial_points:v||0})}/></Form.Item>}
          {rule.mode==='per_option'&&<><Form.Item label="每个正确选项得分"><InputNumber min={0.01} value={rule.correct_points??1} onChange={v=>patchRule({correct_points:v??1})}/></Form.Item><Form.Item label="错选处理"><Select value={rule.wrong_action||'deduct'} options={[{value:'zero',label:'整题零分'},{value:'deduct',label:'按错选数量扣分'}]} onChange={wrong_action=>patchRule({wrong_action})}/></Form.Item>{rule.wrong_action!=='zero'&&<Form.Item label="每个错选扣分"><InputNumber min={0} value={rule.wrong_penalty??1} onChange={v=>patchRule({wrong_penalty:v??1})}/></Form.Item>}</>}
          </>}
        </Form>
        <Collapse items={[{key:'json',label:'高级 JSON',children:<Input.TextArea value={json} rows={10} onChange={e=>{setJson(e.target.value);setReport(undefined);setConfirmed(false)}} aria-label="答案与评分规则JSON"/>}]}/>
        <Input.TextArea value={reason} rows={2} onChange={e=>setReason(e.target.value)} placeholder="填写调整原因"/>
        {report&&<><Alert type="warning" message={`涉及 ${report.affected_submissions} 份答卷，其中 ${report.changed_scores} 份分数变化。确认后需重新发布成绩。`}/><Table rowKey="id" dataSource={report.rows} pagination={{pageSize:8}} columns={[{title:'考号',dataIndex:'candidate_number'},{title:'受影响题目原得分',dataIndex:'before'},{title:'新得分',dataIndex:'after'}]}/><Checkbox checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>已核对影响范围，确认进入复核并重新计分</Checkbox></>}
      </Space>
    </Modal></>
}
