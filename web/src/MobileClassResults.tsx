import {DesktopOutlined} from '@ant-design/icons'
import {ClassLessonReports, type ClassNavigation} from './ClassResults'

export default function MobileClassResults({location, navigate, onSwitchDesktop}: ClassNavigation & {
  onSwitchDesktop: () => void
}) {
  return <main className="m-page">
    {!location.lessonCard && <header className="m-home-head">
      <h1>班级成绩</h1>
      <button type="button" className="m-icon-btn" onClick={onSwitchDesktop}><DesktopOutlined/> 桌面版</button>
    </header>}
    <ClassLessonReports admin={false} mobile navigation={{location, navigate}}/>
  </main>
}
