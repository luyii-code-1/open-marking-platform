import { Tabs } from 'antd'
import { CardWorkflow } from './CardWorkflow'
import { ClassLessonReports, type ClassNavigation } from './ClassResults'
import { Gradebook } from './Gradebook'
import { ResultOverview } from './ResultOverview'
import { examPath } from './examNavigation'

type ResultsProps = {
  admin: boolean
  projectId?: string
  subjectId?: string
  gradeId?: string
  groupId?: string
  navigation?: ClassNavigation
}

export function Results({ admin, projectId, subjectId, gradeId, groupId, navigation }: ResultsProps) {
  if (projectId || groupId) {
    return (
      <>
        {admin && groupId && <CardWorkflow groupId={groupId} />}
        <Gradebook projectId={projectId} subjectId={subjectId} gradeId={gradeId} groupId={groupId} />
      </>
    )
  }

  const classTab = {
    key: 'class',
    label: '班级成绩',
    children: <ClassLessonReports admin={admin} navigation={navigation}/>,
  }

  const compareTab = {
    key: 'compare',
    label: '多次对比',
    children: <ResultOverview onOpenExam={id => { window.location.hash = examPath({ projectId: id, section: 'summary' }) }} />,
  }

  const exportTab = {
    key: 'export',
    label: '成绩导出',
    children: <Gradebook />,
  }

  return (
    <Tabs
      defaultActiveKey={admin && !navigation?.location.lessonScope && !navigation?.location.lessonCard ? 'compare' : 'class'}
      items={admin ? [compareTab, classTab, exportTab] : [classTab, compareTab, exportTab]}
    />
  )
}
