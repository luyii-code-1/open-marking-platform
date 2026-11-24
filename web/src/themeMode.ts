import { useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'omp-theme-mode'
const listeners = new Set<() => void>()

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  light: '浅色模式',
  dark: '深色模式',
  system: '跟随系统',
}

export function getThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {}
  return 'light'
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'dark' || mode === 'light') return mode
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode)
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.dataset.theme = resolved
    root.dataset.themeMode = mode
    root.style.colorScheme = resolved
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f141c' : '#f5f7fa')
  }
  return resolved
}

export function setThemeMode(mode: ThemeMode): ResolvedTheme {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {}
  const resolved = applyTheme(mode)
  for (const listener of listeners) listener()
  return resolved
}

export function initThemeMode(): ResolvedTheme {
  return applyTheme(getThemeMode())
}

export function nextThemeMode(current: ThemeMode): ThemeMode {
  return current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light'
}

export function useThemeMode() {
  const [mode, setModeState] = useState<ThemeMode>(getThemeMode)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => applyTheme(getThemeMode()))

  useEffect(() => {
    const sync = () => {
      const current = getThemeMode()
      setModeState(current)
      setResolved(applyTheme(current))
    }
    listeners.add(sync)
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) sync()
    }
    window.addEventListener('storage', onStorage)
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    const onMedia = () => {
      if (getThemeMode() === 'system') sync()
    }
    media?.addEventListener?.('change', onMedia)
    sync()
    return () => {
      listeners.delete(sync)
      window.removeEventListener('storage', onStorage)
      media?.removeEventListener?.('change', onMedia)
    }
  }, [])

  return {
    mode,
    resolved,
    setMode: (next: ThemeMode) => {
      const r = setThemeMode(next)
      setModeState(next)
      setResolved(r)
    },
    cycle: () => {
      const next = nextThemeMode(mode)
      const r = setThemeMode(next)
      setModeState(next)
      setResolved(r)
    },
  }
}
