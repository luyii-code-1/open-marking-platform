import { useEffect, useState } from 'react'
import { serverBuild, workerBuild, type BuildMetadata } from './buildVersion'
import { canPreparePwaUpdate, requestPwaUpdateNow, watchPwaUpdateState } from './pwaCoordinator'
import { settleReviewWrites } from './reviewStore'

export function BuildVersionMonitor() {
  const [committing, setCommitting] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [available, setAvailable] = useState<BuildMetadata | null>(null)
  const [dismissed, setDismissed] = useState('')
  const [applying, setApplying] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => watchPwaUpdateState(state => setCommitting(state.committing)), [])

  useEffect(() => {
    if (!import.meta.env.PROD) return
    let stopped = false
    let checking = false
    let checkedAt = 0
    let pending = false
    let lastPrepareAt = 0

    async function check() {
      if (checking || !navigator.onLine || document.visibilityState !== 'visible' || Date.now() - checkedAt < (pending ? 10000 : 60000)) return
      checking = true
      try {
        const remote = await serverBuild()
        const current = document.querySelector('meta[name="omp-build"]')?.getAttribute('content')
        const controller = navigator.serviceWorker?.controller
        const controlled = controller ? await workerBuild(controller).catch(() => undefined) : undefined
        if (stopped) return
        checkedAt = Date.now()
        const matches = remote.shell_version === current && (!controller || controlled === current)
        pending = !matches
        if (matches) {
          setAvailable(null)
          setNotice('')
          return
        }
        setAvailable(remote)
        const registration = await navigator.serviceWorker?.getRegistration()
        await registration?.update().catch(() => {})
        if (stopped) return
        if (registration?.installing) {
          const installing = registration.installing
          await new Promise<void>(resolve => {
            const done = () => {
              clearTimeout(waitTimer)
              installing.removeEventListener('statechange', onState)
              resolve()
            }
            const onState = () => {
              if (installing.state === 'installed' || installing.state === 'activated' || installing.state === 'redundant') done()
            }
            const waitTimer = setTimeout(done, 8000)
            if (installing.state === 'installed' || installing.state === 'activated' || installing.state === 'redundant') done()
            else installing.addEventListener('statechange', onState)
          })
          if (stopped) return
        }
        const waiting = registration?.waiting
        if (waiting) {
          const waitingVersion = await workerBuild(waiting).catch(() => undefined)
          if (!stopped && waitingVersion === remote.shell_version && canPreparePwaUpdate() && Date.now() - lastPrepareAt >= 15000) {
            lastPrepareAt = Date.now()
            waiting.postMessage({ type: 'PREPARE_UPDATE' })
            return
          }
        }
        const reloadKey = `omp-refreshed-build:${remote.shell_version}`
        if ((controlled === remote.shell_version || !controller) && current !== remote.shell_version && canPreparePwaUpdate() && !sessionStorage.getItem(reloadKey)) {
          setReloading(true)
          await settleReviewWrites()
          if (!stopped && canPreparePwaUpdate()) {
            sessionStorage.setItem(reloadKey, '1')
            window.location.reload()
          } else if (!stopped) {
            setReloading(false)
          }
        }
      } catch {
        /* Retry after connectivity recovers. */
      } finally {
        checking = false
      }
    }

    // Every application launch verifies the server build, including uncontrolled tabs.
    void check()
    const timer = setInterval(check, 5000)
    const offline = () => {
      setReloading(false)
      setApplying(false)
    }
    window.addEventListener('offline', offline)
    window.addEventListener('online', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  async function applyNow() {
    if (!available || applying) return
    setApplying(true)
    setNotice('')
    try {
      const result = await requestPwaUpdateNow(available.shell_version)
      if (result === 'deferred') {
        setNotice('当前或其它已打开的标签页存在未保存操作，保存或关闭后将自动更新。')
      } else if (result === 'unavailable') {
        setNotice('新版本仍在准备中，请稍后再试。')
      }
    } finally {
      setApplying(false)
    }
  }

  if (committing || reloading) {
    return (
      <div role="status" className="pwa-updating-mask">
        正在更新客户端，请稍候…
      </div>
    )
  }

  if (!available || dismissed === available.shell_version) return null

  return (
    <aside role="status" aria-live="polite" className="pwa-update-toast">
      <div className="pwa-update-toast-body">
        <strong>发现新版本（{available.build_number}）</strong>
        <span>{notice || '空闲时将自动切换，也可立即更新。'}</span>
      </div>
      <div className="pwa-update-toast-actions">
        <button type="button" className="pwa-update-btn primary" disabled={applying} onClick={() => void applyNow()}>
          {applying ? '正在更新…' : '立即更新'}
        </button>
        <button type="button" className="pwa-update-btn" disabled={applying} onClick={() => setDismissed(available.shell_version)}>
          稍后
        </button>
      </div>
    </aside>
  )
}
