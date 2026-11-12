import { useRef, useState } from 'react'
import { PendingAction } from './pendingAction'

export function useAction() {
  const gate = useRef(new PendingAction())
  const [pending, setPending] = useState<string | null>(null)
  return {
    pending, busy: pending !== null,
    run: <T,>(key: string, work: () => Promise<T>) => gate.current.run(key, work, setPending),
  }
}
