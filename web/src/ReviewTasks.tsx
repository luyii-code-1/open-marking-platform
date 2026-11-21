import {useEffect} from 'react'
import {Alert, Card, Progress, Segmented, Space, Tag, Typography} from 'antd'
import {ArrowLeftOutlined} from '@ant-design/icons'
import {Table} from './DataTable'
import {Button} from './Button'
import {ErrorNotice} from './Management'
import {useResource, watchChanges} from './api'
import {rowNavigation} from './rowNavigation'
import {useReviewWorkspace} from './ReviewWorkspace'
import {localProjectId, projectQuestions, questionKey, withCachedProjects,
  type AssignedQuestion, type ProjectFilter, type ReviewProject} from './reviewProjects'

const catalogChanges = ['projects','subjects','groups','templates','assignments','results']
const progressChanges = [...catalogChanges,'tasks','review-results','submissions']
function useReviewList<T>(path:string|null, changes:string[], interval:number) {
  const resource = useResource<T[]>(path,[],{live:false})
  const {reload} = resource
  useEffect(()=>{
    if (!path) return
    const refresh = ()=>{ if (!document.hidden && navigator.onLine) void reload() }
    const timer = window.setInterval(refresh,interval)
    const unwatch = watchChanges(roots=>{ if (!roots || roots.some(root=>changes.includes(root))) refresh() })
    window.addEventListener('focus',refresh)
    return ()=>{ clearInterval(timer); unwatch(); window.removeEventListener('focus',refresh) }
  },[path,reload,changes,interval])
  return resource
}

function Status({value}:{value:string}) {
  if (value==='cached') return <Tag>本机缓存</Tag>
  return value==='completed'?<Tag>已结束</Tag>:<Tag color="processing">进行中</Tag>
}

function TaskProgress({row}:{row:AssignedQuestion}) {
  if (row.ordinary_total===undefined) return <Typography.Text type="secondary">已缓存</Typography.Text>
  const total=row.ordinary_total+(row.arbitration_total||0)
  const done=(row.ordinary_completed||0)+(row.arbitration_completed||0)
  return <div className="review-task-progress">
    <span>阅卷 {row.ordinary_completed||0} / {row.ordinary_total} · 仲裁 {row.arbitration_completed||0} / {row.arbitration_total||0}</span>
    <Progress percent={total?Math.round(done/total*100):0} size="small" showInfo={false}/>
    {!!row.arbitration_pending && <Tag color="orange">待仲裁 {row.arbitration_pending} 份</Tag>}
  </div>
}

type Props = {
  projectId?:string; filter:ProjectFilter; onFilter:(filter:ProjectFilter)=>void
  onProject:(id?:string)=>void; onOpen:(templateId:string,questionId:string)=>void
}
export function ReviewTasks({projectId,filter,onFilter,onProject,onOpen}:Props) {
  const workspace=useReviewWorkspace()
  const catalog=useReviewList<ReviewProject>(workspace.offline?null:'/review-projects',catalogChanges,60000)
  const {projects,cached}=withCachedProjects(catalog.data,workspace.records)
  const project=projects.find(p=>p.id===projectId)
  if (projectId) return <ProjectTasks key={projectId} projectId={projectId} project={project} cached={cached.get(projectId)}
    catalogPending={!workspace.offline&&!catalog.loaded} catalogError={catalog.error} onBack={()=>onProject()} onOpen={onOpen}/>

  const visible=projects.filter(p=>filter==='all'||p.exam_status===filter||(filter==='in_progress'&&p.exam_status==='cached'))
  return <Card title="我的阅卷考试" extra={!workspace.offline&&<Button onClick={catalog.reload} loading={catalog.loading}>刷新</Button>}>
    <ErrorNotice error={catalog.error}/>
    <Segmented<ProjectFilter> aria-label="考试状态" value={filter} onChange={onFilter} style={{marginBottom:12}} options={[
      {value:'in_progress',label:'进行中'},{value:'completed',label:'已结束'},{value:'all',label:'全部'},
    ]}/>
    <Table<ReviewProject> rowKey="id" dataSource={visible} loading={!catalog.loaded&&catalog.loading}
      onRow={p=>rowNavigation(()=>onProject(p.id),p.name)} locale={{emptyText:projects.length?'此状态下暂无考试':'暂无分配给你的阅卷考试'}}
      columns={[
        {title:'考试项目',dataIndex:'name',render:(name,p)=><Button type="link" onClick={()=>onProject(p.id)}>{name}</Button>},
        {title:'我的科目',render:(_,p)=>p.subjects.join('、')||'—'},
        {title:'分配题数',dataIndex:'question_count',width:100},
        {title:'考试状态',width:110,render:(_,p)=><Status value={p.exam_status}/>},
      ]}/>
  </Card>
}

function ProjectTasks({projectId,project,cached,catalogPending,catalogError,onBack,onOpen}:{
  projectId:string; project?:ReviewProject; cached?:Map<string,AssignedQuestion>; catalogPending:boolean
  catalogError:string; onBack:()=>void; onOpen:Props['onOpen']
}) {
  const workspace=useReviewWorkspace()
  const path=workspace.offline||projectId===localProjectId?null:'/review-task-progress?project_id='+encodeURIComponent(projectId)
  const progress=useReviewList<AssignedQuestion>(path,progressChanges,15000)
  const rows=projectQuestions(progress.data,cached)
  const pending=rows.reduce((sum,row)=>sum+(row.arbitration_pending||0),0)
  return <Card title={<Space><Button type="text" aria-label="返回考试列表" icon={<ArrowLeftOutlined/>} onClick={onBack}/>
    {project?.name||'考试阅卷任务'}{project&&<Status value={project.exam_status}/>}</Space>}
    extra={path&&<Button onClick={progress.reload} loading={progress.loading}>刷新进度</Button>}>
    <ErrorNotice error={progress.error||catalogError}/>
    {pending>0&&<Alert type="warning" showIcon message={`本场有 ${pending} 份答卷待你仲裁`} style={{marginBottom:12}}/>}
    <Table<AssignedQuestion> rowKey={questionKey} dataSource={rows} loading={catalogPending||(!progress.loaded&&progress.loading)}
      locale={{emptyText:'本场暂无分配给你的阅卷任务'}} columns={[
        {title:'科目 / 题卡',render:(_,r)=><Space direction="vertical" size={0}><strong>{r.subject_name||r.template_name}</strong>
          <Typography.Text type="secondary">{[r.grade_name,r.card_name&&r.card_name!=='Default'?r.card_name:r.template_name].filter(Boolean).join(' · ')}</Typography.Text></Space>},
        {title:'评阅题目',render:(_,r)=><Space wrap>第 {r.question_label} 题 · {r.points} 分<Tag>{r.review_mode==='double'?'双评':'单评'}</Tag></Space>},
        {title:'我的进度',render:(_,r)=><TaskProgress row={r}/>},
        {title:'操作',width:120,render:(_,r)=><Button type={r.published?'default':'primary'} onClick={()=>onOpen(r.template_id,r.question_id)}>
          {r.published?'评分记录':r.arbitration_pending?'进入仲裁':r.cached?'继续阅卷':r.ordinary_pending?'进入阅卷':'查看任务'}</Button>},
      ]}/>
  </Card>
}
