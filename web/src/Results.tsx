import { useState } from 'react'
import { Tabs } from 'antd'
import { CardWorkflow } from './CardWorkflow'
import { ClassResults } from './ClassResults'
import { Gradebook } from './Gradebook'
import { PaperLesson, type LessonScope } from './PaperLesson'
import { ResultOverview } from './ResultOverview'
import { examPath } from './examNavigation'

type ResultsProps = {
  admin: boolean
  projectId?: string
  subjectId?: string
  gradeId?: string
  groupId?: string
}

export function Results({ admin, projectId, subjectId, gradeId, groupId }: ResultsProps) {
  const [lessonScope, setLessonScope] = useState<LessonScope | null>(null)
  const [classRefreshKey, setClassRefreshKey] = useState(0)

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
    children: (
      <>
        <div style={{ display: lessonScope ? 'none' : undefined }}>
          <ClassResults
            admin={admin}
            refreshKey={classRefreshKey}
            onLesson={scope => setLessonScope(scope)}
          />
        </div>
        {lessonScope && (
          <PaperLesson
            key={`${lessonScope.project || ''}:${lessonScope.cls || ''}:${lessonScope.card || ''}`}
            initial={lessonScope}
            onBack={() => {
              setLessonScope(null)
              setClassRefreshKey(k => k + 1)
            }}
          />
        )}
      </>
    ),
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
      defaultActiveKey={admin ? 'compare' : 'class'}
      items={admin ? [compareTab, classTab, exportTab] : [classTab, compareTab, exportTab]}
    />
  )
}
