import { useEffect, useRef } from 'react'

const visitorKey = 'omp-web-visitor'
let visitor = ''

function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

function browserId() {
  if (!visitor) {
    visitor = randomId()
    try {
      const stored = localStorage.getItem(visitorKey)
      if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) {
        visitor = stored
      } else {
        localStorage.setItem(visitorKey, visitor)
      }
    } catch { /* Restricted storage keeps the identifier for this document. */ }
  }
  return visitor
}

export function usePageViews(page: string | null, navigationKey = page || '') {
  const previous = useRef<string | null>(null)
  useEffect(() => {
    if (!page) return
    const key = JSON.stringify([page, navigationKey])
    if (key === previous.current) return
    const timer = window.setTimeout(() => {
      previous.current = key
      if (!navigator.onLine) return
      void fetch('/api/v1/telemetry/page-view', {
        method: 'POST', mode: 'same-origin', credentials: 'omit', keepalive: true, cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: randomId(), visitor: browserId(), page }),
      }).catch(() => {})
    }, 0)
    return () => window.clearTimeout(timer)
  }, [page, navigationKey])
}
