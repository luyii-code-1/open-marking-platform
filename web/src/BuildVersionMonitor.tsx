import { useEffect, useState } from 'react'
import { serverBuild, workerBuild, type BuildMetadata } from './buildVersion'
import { canPreparePwaUpdate, forceReloadClient, requestPwaUpdateNow, watchPwaUpdateState } from './pwaCoordinator'
import { settleReviewWrites } from './reviewStore'

const AUTO_FORCE_TIMEOUT_SECONDS = 8

export function BuildVersionMonitor() {
  const [committing, setCommitting] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [available, setAvailable] = useState<BuildMetadata | null>(null)
  const [dismissed, setDismissed] = useState('')
  const [applying, setApplying] = useState(false)
  const [forcing, setForcing] = useState(false)
  const [countdown, setCountdown] = useState(AUTO_FORCE_TIMEOUT_SECONDS)
  const [notice, setNotice] = useState('')

  useEffect(() => watchPwaUpdateState(state => setCommitting(state.committing)), [])

  const updatingOverlay = committing || reloading

  useEffect(() => {
    if (!updatingOverlay) {
      setCountdown(AUTO_FORCE_TIMEOUT_SECONDS)
      return
    }
    setCountdown(AUTO_FORCE_TIMEOUT_SECONDS)
    const started = Date.now()
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000)
      const left = Math.max(0, AUTO_FORCE_TIMEOUT_SECONDS - elapsed)
      setCountdown(left)
      if (left <= 0) {
        clearInterval(interval)
        setForcing(true)
        void forceReloadClient()
      }
    }, 500)
    return () => clearInterval(interval)
  }, [updatingOverlay])

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
    if (!available || applying || forcing) return
    setApplying(true)
    setNotice('')
    const fallbackTimer = setTimeout(() => {
      setForcing(true)
      void forceReloadClient()
    }, AUTO_FORCE_TIMEOUT_SECONDS * 1000)
    try {
      const result = await requestPwaUpdateNow(available.shell_version)
      if (result === 'committed' || result === 'reloading') {
        setReloading(true)
        return
      }
      clearTimeout(fallbackTimer)
      if (result === 'deferred') {
        setNotice('检测到未保存操作或其它标签页正在编辑；可直接点击「强制刷新」立即切换。')
      } else if (result === 'unavailable') {
        setNotice('缓存版本尚未就绪，可点击「强制刷新」从服务端重新加载。')
      }
    } finally {
      clearTimeout(fallbackTimer)
      setApplying(false)
    }
  }

  async function forceNow() {
    if (forcing) return
    setForcing(true)
    setReloading(true)
    await forceReloadClient()
  }

  if (updatingOverlay) {
    return (
      <div role="status" aria-live="polite" className="pwa-updating-mask">
        <div className="pwa-updating-card">
          <div className="pwa-updating-spinner" aria-hidden="true" />
          <strong>正在更新到最新版本{available ? `（${available.build_number}）` : ''}</strong>
          <p>{forcing ? '正在清理旧缓存并强制刷新…' : `正在切换版本，${countdown} 秒后若未完成将自动强制刷新。`}</p>
          <div className="pwa-updating-actions">
            <button type="button" className="pwa-update-btn primary" disabled={forcing} onClick={() => void forceNow()}>
              {forcing ? '正在强制刷新…' : '立即强制刷新'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!available || dismissed === available.shell_version) return null

  return (
    <aside role="status" aria-live="polite" className="pwa-update-toast">
      <div className="pwa-update-toast-body">
        <strong>发现新版本（{available.build_number}）</strong>
        <span>{notice || '空闲时将自动切换，也可立即更新或强制刷新。'}</span>
      </div>
      <div className="pwa-update-toast-actions">
        <button type="button" className="pwa-update-btn primary" disabled={applying || forcing} onClick={() => void applyNow()}>
          {applying ? '正在更新…' : '立即更新'}
        </button>
        <button type="button" className="pwa-update-btn" disabled={forcing} onClick={() => void forceNow()}>
          {forcing ? '刷新中…' : '强制刷新'}
        </button>
        <button type="button" className="pwa-update-btn ghost" disabled={applying || forcing} onClick={() => setDismissed(available.shell_version)}>
          稍后
        </button>
      </div>
    </aside>
  )
}
