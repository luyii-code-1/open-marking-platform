import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const navSource = await readFile(new URL('../src/examNavigation.ts', import.meta.url), 'utf8')
const navOut = ts.transpileModule(navSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const navUrl = `data:text/javascript;base64,${Buffer.from(navOut).toString('base64')}`

const rawSource = await readFile(new URL('../src/mobilePlatform.ts', import.meta.url), 'utf8')
const patchedSource = rawSource
  .replace("import { useCallback, useEffect, useState } from 'react'", 'const useCallback = (f) => f; const useEffect = () => {}; const useState = (v) => [typeof v === "function" ? v() : v, () => {}]')
  .replace("import { readLocation } from './examNavigation'", `import { readLocation } from '${navUrl}'`)
const { outputText } = ts.transpileModule(patchedSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
const {
  readPlatformQuery,
  detectDefaultPlatform,
  resolvePlatform,
  isMobileWideLayout,
  buildPlatformUrl,
  resolvePostLoginHash,
} = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

// 1. Explicit ?platform=mobile / desktop query parsing & precedence
assert.equal(readPlatformQuery('?platform=mobile'), 'mobile')
assert.equal(readPlatformQuery('?platform=DESKTOP&foo=1'), 'desktop')
assert.equal(readPlatformQuery('?platform=tablet'), null)
assert.equal(readPlatformQuery(''), null)

const desktopEnv = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  maxTouchPoints: 0,
  width: 1440,
  height: 900,
  coarsePointer: false,
}
assert.equal(resolvePlatform('?platform=mobile', null, desktopEnv), 'mobile')
assert.equal(resolvePlatform('?platform=desktop', 'mobile', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  maxTouchPoints: 5,
  width: 390,
  height: 844,
  coarsePointer: true,
}), 'desktop')

// 2. Default detection: phone portrait, phone landscape, tablet, narrow desktop window
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const androidPhoneUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const androidTabletUA = 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const ipadDesktopUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

assert.equal(detectDefaultPlatform({ userAgent: iphoneUA, maxTouchPoints: 5, width: 390, height: 844, coarsePointer: true }), 'mobile')
assert.equal(detectDefaultPlatform({ userAgent: iphoneUA, maxTouchPoints: 5, width: 844, height: 390, coarsePointer: true }), 'mobile', 'Phone landscape must remain mobile')
assert.equal(detectDefaultPlatform({ userAgent: androidPhoneUA, maxTouchPoints: 5, width: 915, height: 412, coarsePointer: true }), 'mobile', 'Android phone landscape must remain mobile')
assert.equal(detectDefaultPlatform({ userAgent: androidTabletUA, maxTouchPoints: 5, width: 800, height: 1280, coarsePointer: true }), 'mobile', 'Android tablet defaults to touch layout')
assert.equal(detectDefaultPlatform({ userAgent: ipadDesktopUA, maxTouchPoints: 5, width: 768, height: 1024, coarsePointer: true }), 'mobile', 'iPad defaults to touch layout')
assert.equal(detectDefaultPlatform({ userAgent: ipadDesktopUA, maxTouchPoints: 5, width: 1366, height: 1024, coarsePointer: false }), 'mobile', 'Landscape iPad with a trackpad stays in touch layout')
assert.equal(detectDefaultPlatform({ ...desktopEnv, width: 500, height: 800 }), 'desktop', 'Narrow desktop window stays desktop by default')
assert.equal(detectDefaultPlatform({ ...desktopEnv, maxTouchPoints: 10, width: 500, height: 800, coarsePointer: true }), 'desktop', 'A narrow window on a touch laptop stays desktop')
assert.equal(detectDefaultPlatform({ userAgent: 'CustomPWA/1.0', maxTouchPoints: 5, width: 390, height: 780, coarsePointer: true }), 'mobile', 'Coarse-pointer small viewport defaults to mobile')

// 3. Landscape wide layout threshold for mobile marking
assert.equal(isMobileWideLayout(390, 844), false)
assert.equal(isMobileWideLayout(520, 390), false)
assert.equal(isMobileWideLayout(667, 375), true)
assert.equal(isMobileWideLayout(844, 390), true)

// 4. Platform URL preservation
assert.equal(
  buildPlatformUrl('https://omp.gfzx.com/?foo=1#/marking/projects/p1/review/t1/q1', 'desktop'),
  '/?foo=1&platform=desktop#/marking/projects/p1/review/t1/q1',
)
assert.equal(
  buildPlatformUrl('https://omp.gfzx.com/?platform=desktop#/marking/projects/p1', 'mobile'),
  '/?platform=mobile#/marking/projects/p1',
)

// 5. Post-login deep link restoration & role authorization
const taskDeepLink = '#/marking/projects/p1/review/t1/q1'
assert.equal(resolvePostLoginHash(taskDeepLink, 'teacher', 'marking', 'mobile'), taskDeepLink)
assert.equal(resolvePostLoginHash(taskDeepLink, 'manager', 'marking', 'mobile'), taskDeepLink)
assert.equal(resolvePostLoginHash(taskDeepLink, 'admin', 'admin', 'mobile'), '#/dashboard', 'Admin is not routed into marking')
assert.equal(resolvePostLoginHash('', 'teacher', 'marking', 'mobile'), '#/marking', 'Mobile teacher default entry is marking')
assert.equal(resolvePostLoginHash('#/login/marking', 'teacher', 'marking', 'mobile'), '#/marking')
assert.equal(resolvePostLoginHash('#/login/marking', 'teacher', 'marking', 'desktop'), '#/dashboard')
assert.equal(resolvePostLoginHash('#/exams/p1', 'teacher', 'marking', 'mobile'), '#/marking', 'Teacher cannot enter management exam route')
assert.equal(resolvePostLoginHash('#/http-guard/traffic', 'teacher', 'marking', 'mobile'), '#/dashboard')
assert.equal(resolvePostLoginHash('#/http-guard/traffic', 'admin', 'admin', 'desktop'), '#/http-guard/traffic')
assert.equal(resolvePostLoginHash('#/lesson', 'teacher', 'marking', 'mobile'), '#/lesson')
assert.equal(resolvePostLoginHash('#/settings/backups', 'manager', 'admin', 'desktop'), '#/dashboard', 'Manager cannot enter system settings')
assert.equal(resolvePostLoginHash('#/conversions', 'manager', 'admin', 'mobile'), '#/dashboard')
assert.equal(resolvePostLoginHash('https://example.com', 'teacher', 'marking', 'mobile'), '#/marking')

console.log('Mobile platform & routing passed: query override, UA/CSS/landscape/tablet/narrow-desktop detection, and post-login deep-link restoration')
