import { useEffect } from 'react'
import { App, Breadcrumb, Button, Card, Empty, Space, Spin, Tabs, Tag, Typography } from 'antd'
import { ArrowLeftOutlined, RightOutlined } from '@ant-design/icons'
import { send, useResource, type Row, type Template } from './api'
import { HierarchyDelete } from './HierarchyDelete'
import { EntityTable, ErrorNotice } from './EntityTable'
import { ArchiveManager } from './ArchiveManager'
import { Roster } from './Roster'
import { TemplateEditor } from './TemplateEditor'
import { Scans } from './Management'
import { Marking } from './Marking'
import { Exceptions } from './Exceptions'
import { Results } from './Results'
import { ProjectStorage } from './StorageConnections'
import { defaultGroup, examPath, groupSections, resolveExam, type ExamLocation } from './examNavigation'

const { Title, Text } = Typography
const groupName = (group: Row) => group.is_default || group.name === 'Default' ? '默认组' : group.name

export function Exams({ location, navigate }: { location: ExamLocation; navigate: (path: string, replace?: boolean) => void }) {
  const { message } = App.useApp()
  const projects = useResource<Row[]>('/projects', []), subjects = useResource<Row[]>('/subjects', []), groups = useResource<Row[]>('/groups', [])
  const ready = projects.loaded && subjects.loaded && groups.loaded
  const { project, subject, group, invalid } = resolveExam(location, projects.data, subjects.data, groups.data)
  const go = (value: ExamLocation) => navigate(examPath(value))
  const base = { projectId: project?.id, subjectId: subject?.id, groupId: group?.id }
  const direct = subject && !location.groupId ? defaultGroup(subject, groups.data) : undefined
  useEffect(() => { if (ready && direct && project) navigate(examPath({ projectId: project.id, subjectId: subject!.id, groupId: direct.id }), true) }, [ready, direct?.id, project?.id, subject?.id, location.groupId])
  const error = projects.error || subjects.error || groups.error
  const refresh = async () => { await Promise.all([projects.reload(), subjects.reload(), groups.reload()]) }
  const enterSubject = (s: Row) => {
    const only = defaultGroup(s, groups.data)
    go({ projectId: project!.id, subjectId: s.id, groupId: only?.id })
  }
  if (error && (!ready || invalid)) return <ErrorNotice error={error} retry={refresh} />
  if (!ready || direct) return <div className="workspace-loading"><Spin /></div>
  if (invalid) return <Card><Empty description="该考试位置不存在或已不可访问"><Button onClick={() => go({})}>返回考试项目</Button></Empty></Card>

  const crumbs = [
    { title: <a href={examPath()}>考试项目</a> },
    ...(project ? [{ title: <a href={examPath({ projectId: project.id })}>{project.name}</a> }] : []),
    ...(subject ? [{ title: <a href={examPath({ projectId: project!.id, subjectId: subject.id })}>{subject.name}</a> }] : []),
    ...(group ? [{ title: groupName(group) }] : []),
  ]
  const newSubject = async (row?: Row) => { await refresh(); if (row?.id) go({ projectId: project!.id, subjectId: row.id }) }
  return <div className="exam-workspace">
    <ErrorNotice error={error} retry={refresh} />
    <Breadcrumb items={crumbs} />
    {project && <div className="workspace-heading"><Space align="start"><Button icon={<ArrowLeftOutlined />} aria-label={group && subject?.group_mode !== 'default' ? '返回题卡组列表' : subject ? '返回科目列表' : '返回考试项目'} onClick={() => go(group && subject?.group_mode !== 'default' ? { projectId: project.id, subjectId: subject!.id } : subject ? { projectId: project.id } : {})} /><div><Title level={3}>{group ? groupName(group) : subject?.name || project.name}</Title><Text type="secondary">{group ? `${subject!.name} · ${group.frozen ? '成绩已发布' : '成绩未发布'}` : subject ? `${groups.data.filter(g => g.subject_id === subject.id).length} 个题卡组` : `${subjects.data.filter(s => s.project_id === project.id).length} 门科目`}</Text></div></Space><HierarchyDelete kind={group ? 'groups' : subject ? 'subjects' : 'projects'} target={group || subject || project} onDeleted={async () => { navigate(examPath(group ? { projectId: project.id, subjectId: subject!.id } : subject ? { projectId: project.id } : {}), true); await refresh() }} /></div>}
    {!project ? <EntityTable path="/projects" title="考试项目" fields={[{ name: 'name', label: '考试名称' }]} onCreated={async row => { await refresh(); if (row?.id) go({ projectId: row.id }) }} columns={[
      { title: '考试名称', dataIndex: 'name', render: (name: string, row: Row) => <a href={examPath({ projectId: row.id })}>{name}</a> },
      { title: '科目', render: (_: unknown, row: Row) => `${subjects.data.filter(s => s.project_id === row.id).length} 门` },
      { title: '操作', render: (_: unknown, row: Row) => <Space><Button onClick={() => go({ projectId: row.id })}>进入考试<RightOutlined /></Button><HierarchyDelete kind="projects" target={row} onDeleted={refresh} /></Space> },
    ]} /> : group ? <GroupWorkspace key={group.id} group={group} project={project} section={location.section || 'overview'} onSection={section => go({ ...base, section })} /> : subject ? subject.group_mode === 'default' && !groups.data.some(g=>g.subject_id===subject.id) ? <Card><Empty description="此科目尚无默认题卡组"><Button type="primary" onClick={async()=>{try{const created=await send<Row>(`/subjects/${subject.id}/default-group`);await refresh();go({...base,groupId:created.id})}catch(e){message.error((e as Error).message)}}}>创建默认题卡组</Button></Empty></Card> : <EntityTable key={subject.id} path="/groups" title="题卡组" scope={{ subject_id: subject.id }} fields={[{ name: 'name', label: '组名称（学校 / 年级 / 卷别）' }]} onCreated={async row => { await refresh(); if (row?.id) go({ ...base, groupId: row.id }) }} columns={[
      { title: '组名称', dataIndex: 'name', render: (_: string, row: Row) => <a href={examPath({ ...base, groupId: row.id })}>{groupName(row)}</a> },
      { title: '题卡', render: (_: unknown, row: Row) => row.template_id ? '已发布' : '待配置' },
      { title: '成绩', render: (_: unknown, row: Row) => <Tag color={row.frozen ? 'green' : 'default'}>{row.frozen ? '已发布' : '未发布'}</Tag> },
      { title: '操作', render: (_: unknown, row: Row) => <Space><Button onClick={() => go({ ...base, groupId: row.id })}>进入工作台<RightOutlined /></Button><HierarchyDelete kind="groups" target={row} onDeleted={refresh} /></Space> },
    ]} /> : <Tabs activeKey={location.section || 'subjects'} onChange={section => go({ projectId: project.id, section })} items={[
      { key: 'subjects', label: '科目', children: <EntityTable key={project.id} path="/subjects" title="科目" scope={{ project_id: project.id }} onCreated={newSubject} fields={[{ name: 'name', label: '科目名称' }, { name: 'group_mode', label: '分组方式', type: 'select', initial: 'default', options: [{ label: '统一使用一份题卡', value: 'default' }, { label: '按学校 / 年级 / 卷别分组', value: 'custom' }] }]} columns={[
        { title: '科目名称', dataIndex: 'name', render: (name: string, row: Row) => <Button type="link" className="table-name-link" onClick={() => enterSubject(row)}>{name}</Button> },
        { title: '题卡组', render: (_: unknown, row: Row) => row.group_mode === 'default' ? '统一题卡' : `${groups.data.filter(g => g.subject_id === row.id).length} 个组` },
        { title: '操作', render: (_: unknown, row: Row) => <Space><Button onClick={() => enterSubject(row)}>进入科目<RightOutlined /></Button><HierarchyDelete kind="subjects" target={row} onDeleted={refresh} /></Space> },
      ]} /> },
      { key: 'summary', label: '跨科成绩', children: <Results admin projectId={project.id} projectOnly /> },
      { key: 'archives', label: '归档与释放', children: <ArchiveManager projectId={project.id} /> },
      { key: 'storage', label: '存储设置', children: <ProjectStorage project={project} onSaved={refresh} /> },
    ]} />}
  </div>
}

function GroupWorkspace({ group, project, section, onSection }: { group: Row; project: Row; section: string; onSection: (section: string) => void }) {
  return <Tabs activeKey={section} onChange={onSection} items={groupSections.map(([key, label]) => ({ key, label, children:
    key === 'overview' ? <GroupOverview group={group} onSection={onSection} /> :
    (key === 'scans' || key === 'marking') && !group.template_id ? <Card><Empty description={key === 'scans' ? '发布题卡后即可建立扫描批次' : '发布题卡后即可分配教师与阅卷'}><Button type="primary" onClick={() => onSection('template')}>配置题卡</Button></Empty></Card> :
    key === 'template' ? <TemplateEditor groupId={group.id} /> : key === 'roster' ? <Roster groupId={group.id} /> :
    key === 'scans' ? <Scans groupId={group.id} /> : key === 'marking' ? <Marking admin groupId={group.id} /> :
    key === 'exceptions' ? <Exceptions groupId={group.id} /> : <Results admin groupId={group.id} projectId={project.id} />,
  }))} />
}

function GroupOverview({ group, onSection }: { group: Row; onSection: (section: string) => void }) {
  const templates = useResource<Template[]>('/templates', []), roster = useResource<any>(`/groups/${group.id}/roster`, null)
  const template = templates.data.find(t => t.id === group.template_id), drafts = templates.data.filter(t => t.group_id === group.id && t.status === 'draft')
  const entries = [
    { key: 'template', label: '题卡设计', detail: template ? `${template.name} · 已发布` : drafts.length ? `${drafts.length} 份草稿待发布` : '创建或从题卡库选用版式', action: template ? '查看题卡' : '配置题卡' },
    { key: 'roster', label: '应考名单', detail: roster.data?.configured ? `${roster.data.students.length} 名应考学生` : '选择班级或学生', action: '管理名单' },
    { key: 'scans', label: '扫描与补扫', detail: '采集批次、纠正页面与处理补扫', action: '管理扫描' },
    { key: 'marking', label: '阅卷', detail: '分配教师、评阅作答与查看进度', action: '进入阅卷' },
    { key: 'exceptions', label: '异常核查', detail: '核查识别与评阅中的待处理事项', action: '查看异常' },
    { key: 'results', label: '成绩', detail: group.frozen ? '成绩已发布' : '检查统计并确认发布', action: '查看成绩' },
  ]
  return <><ErrorNotice error={templates.error || roster.error} /><div className="group-work-grid">{entries.map(item => <Card key={item.key}><Title level={4}>{item.label}</Title><Text type="secondary">{item.detail}</Text><Button type={(!template && item.key === 'template') ? 'primary' : 'default'} onClick={() => onSection(item.key)}>{item.action}<RightOutlined /></Button></Card>)}</div></>
}
