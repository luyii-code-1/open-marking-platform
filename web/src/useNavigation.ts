import { useEffect, useRef, useState } from 'react'
import { readLocation } from './examNavigation'

const unsaved = new Set<symbol>()
export const confirmLeaving = () => !unsaved.size || window.confirm('题卡有未保存修改，确认离开当前页面？')

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const id = Symbol(); unsaved.add(id)
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { unsaved.delete(id); window.removeEventListener('beforeunload', beforeUnload) }
  }, [dirty])
}

export function useNavigation() {
  const [location, setLocation] = useState(() => readLocation(window.location.hash))
  const previous = useRef(window.location.hash)
  useEffect(() => {
    const changed = () => {
      const next = window.location.hash
      if (next === previous.current) return
      const before = readLocation(previous.current), after = readLocation(next)
      const sameGroup = before.page === 'exams' && after.page === 'exams' && !!before.groupId && before.groupId === after.groupId && before.subjectId === after.subjectId && before.projectId === after.projectId
      if (!sameGroup && !confirmLeaving()) { window.history.replaceState(null, '', previous.current || '#/dashboard'); return }
      previous.current = next; setLocation(readLocation(next))
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  function navigate(path: string, replace = false) {
    if (replace) {
      window.history.replaceState(null, '', path); previous.current = path; setLocation(readLocation(path))
    } else window.location.hash = path
  }
  return { location, navigate }
}
