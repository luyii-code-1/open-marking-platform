import { useCallback, useEffect, useState } from 'react'
import { readLocation } from './examNavigation'
import type { Portal } from './Login'
import type { User } from './api'

export type Platform = 'mobile' | 'desktop'

const PLATFORM_STORAGE_KEY = 'omp-platform-override'
const LAST_TASK_PREFIX = 'omp-mobile-last-task:'

export type PlatformEnvironment = {
  userAgent: string
  maxTouchPoints: number
  width: number
  height: number
  coarsePointer: boolean
}

export type RememberedMobileTask = {
  projectId?: string
  projectName?: string
  subjectName?: string
  templateId: string
  templateName?: string
  questionId: string
  questionLabel?: string
  points?: number
  updatedAt: number
}

const MOBILE_UA_RE = /Android|iPhone|iPod|iPad|Windows Phone|HarmonyOS|Tablet|PlayBook|Silk|Mobile Safari/i
const DESKTOP_UA_RE = /Windows NT|Macintosh|X11|CrOS/i

export function readPlatformQuery(search: string): Platform | null {
  try {
    const value = new URLSearchParams(search).get('platform')?.trim().toLowerCase()
    if (value === 'mobile' || value === 'desktop') return value
  } catch {}
  return null
}

export function readStoredPlatform(): Platform | null {
  try {
    const value = globalThis.sessionStorage?.getItem(PLATFORM_STORAGE_KEY)
    if (value === 'mobile' || value === 'desktop') return value
  } catch {}
  return null
}

export function writeStoredPlatform(platform: Platform | null) {
  try {
    if (!globalThis.sessionStorage) return
    if (platform) globalThis.sessionStorage.setItem(PLATFORM_STORAGE_KEY, platform)
    else globalThis.sessionStorage.removeItem(PLATFORM_STORAGE_KEY)
  } catch {}
}

export function detectDefaultPlatform(env: PlatformEnvironment): Platform {
  const shortSide = Math.min(env.width, env.height)
  const longSide = Math.max(env.width, env.height)
  const ua = env.userAgent || ''

  const isIpadDesktopMode = /Macintosh/i.test(ua) && env.maxTouchPoints > 1
  if (isIpadDesktopMode || MOBILE_UA_RE.test(ua)) return 'mobile'
  if (DESKTOP_UA_RE.test(ua)) return 'desktop'

  if (env.coarsePointer && env.maxTouchPoints > 0 && shortSide > 0 && shortSide <= 1024 && longSide <= 1440) {
    return 'mobile'
  }
  return 'desktop'
}

export function resolvePlatform(search: string, stored: Platform | null, env: PlatformEnvironment): Platform {
  return readPlatformQuery(search) ?? stored ?? detectDefaultPlatform(env)
}

export function isMobileWideLayout(width: number, height: number): boolean {
  return width >= 560 && width > height
}

function currentEnvironment(): PlatformEnvironment {
  if (typeof window === 'undefined') {
    return { userAgent: '', maxTouchPoints: 0, width: 1280, height: 800, coarsePointer: false }
  }
  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false
  return {
    userAgent: navigator.userAgent || '',
    maxTouchPoints: navigator.maxTouchPoints || 0,
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
    coarsePointer,
  }
}

export function buildPlatformUrl(currentHref: string, platform: Platform | null): string {
  const url = new URL(currentHref)
  if (platform) url.searchParams.set('platform', platform)
  else url.searchParams.delete('platform')
  return url.pathname + url.search + url.hash
}

export function usePlatform() {
  const readNow = useCallback(() => {
    const query = readPlatformQuery(window.location.search)
    if (query) writeStoredPlatform(query)
    return resolvePlatform(window.location.search, query ?? readStoredPlatform(), currentEnvironment())
  }, [])

  const [platform, setPlatformState] = useState<Platform>(readNow)

  useEffect(() => {
    const sync = () => setPlatformState(readNow())
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [readNow])

  const setPlatform = useCallback((next: Platform) => {
    writeStoredPlatform(next)
    try {
      const nextUrl = buildPlatformUrl(window.location.href, next)
      window.history.replaceState(null, '', nextUrl)
    } catch {}
    setPlatformState(next)
  }, [])

  return { platform, setPlatform }
}

const TEACHER_PAGES = new Set(['dashboard', 'marking', 'lesson', 'teacher-templates', 'results', 'account'])
const MANAGER_PAGES = new Set([
  'dashboard', 'scanner', 'subject-catalog', 'electives', 'exams', 'teacher-templates',
  'exceptions', 'results', 'lesson', 'people', 'archives', 'account',
])

export function resolvePostLoginHash(
  currentHash: string,
  role: User['role'],
  portal: Portal,
  platform: Platform,
): string {
  const trimmed = (currentHash || '').trim()
  const loc = readLocation(trimmed)
  const isDefaultEntry = !trimmed || trimmed === '#' || trimmed === '#/' || loc.page === 'login'
  const fallback = platform === 'mobile' && role !== 'admin' && portal === 'marking' ? '#/marking' : '#/dashboard'
  if (isDefaultEntry || !trimmed.startsWith('#/')) return fallback
  if (loc.page === 'dashboard' && trimmed !== '#/dashboard') return fallback

  if (loc.page === 'http-guard') {
    return role === 'admin' ? trimmed : '#/dashboard'
  }
  if (loc.page === 'marking') {
    return role === 'admin' ? '#/dashboard' : trimmed
  }
  if (role === 'admin') {
    return trimmed
  }
  if (role === 'manager' && portal === 'admin') {
    return MANAGER_PAGES.has(loc.page) ? trimmed : '#/dashboard'
  }
  return TEACHER_PAGES.has(loc.page) ? trimmed : fallback
}

export function rememberMobileTask(userId: string, task: Omit<RememberedMobileTask, 'updatedAt'>) {
  if (!userId || !task.templateId || !task.questionId) return
  try {
    localStorage.setItem(LAST_TASK_PREFIX + userId, JSON.stringify({ ...task, updatedAt: Date.now() }))
  } catch {}
}

export function readMobileTask(userId: string): RememberedMobileTask | null {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(LAST_TASK_PREFIX + userId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RememberedMobileTask>
    if (typeof parsed.templateId === 'string' && typeof parsed.questionId === 'string') {
      return {
        projectId: typeof parsed.projectId === 'string' ? parsed.projectId : undefined,
        projectName: typeof parsed.projectName === 'string' ? parsed.projectName : undefined,
        subjectName: typeof parsed.subjectName === 'string' ? parsed.subjectName : undefined,
        templateId: parsed.templateId,
        templateName: typeof parsed.templateName === 'string' ? parsed.templateName : undefined,
        questionId: parsed.questionId,
        questionLabel: typeof parsed.questionLabel === 'string' ? parsed.questionLabel : undefined,
        points: typeof parsed.points === 'number' ? parsed.points : undefined,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      }
    }
  } catch {}
  return null
}
