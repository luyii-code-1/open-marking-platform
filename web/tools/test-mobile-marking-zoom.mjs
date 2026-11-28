import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const zoomSource = await readFile(new URL('../src/mobileZoom.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(zoomSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
})
const zoom = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

// 1. Zoom range 50%–400% & boundary states
assert.equal(zoom.MOBILE_MIN_ZOOM, 0.5)
assert.equal(zoom.MOBILE_MAX_ZOOM, 4)
assert.equal(zoom.clampZoom(0.1), 0.5)
assert.equal(zoom.clampZoom(9), 4)
assert.equal(zoom.stepZoom(1, 1), 1.25)
assert.equal(zoom.stepZoom(1, -1), 0.75)
assert.equal(zoom.stepZoom(0.5, -1), 0.5)
assert.equal(zoom.stepZoom(4, 1), 4)
assert.equal(zoom.canZoomOut(0.5), false)
assert.equal(zoom.canZoomOut(0.75), true)
assert.equal(zoom.canZoomIn(4), false)
assert.equal(zoom.canZoomIn(3.75), true)
assert.equal(zoom.isDefaultZoom(1), true)
assert.equal(zoom.isDefaultZoom(1.25), false)

// 2. Stage pixel width scales visibly on narrow portrait & landscape screens
const w100 = zoom.computeStagePixelWidth(360, 1)
const w125 = zoom.computeStagePixelWidth(360, 1.25)
const w50 = zoom.computeStagePixelWidth(360, 0.5)
const w400 = zoom.computeStagePixelWidth(360, 4)
assert.equal(w100, 344)
assert.ok(w125 > w100, 'Pressing + must increase stage width')
assert.ok(w50 < w100, 'Pressing - must decrease stage width')
assert.equal(w400, 344 * 4)

// 3. Two-finger pinch zooms around pinch midpoint
const pinch = zoom.beginPinch({ x: 100, y: 200 }, { x: 200, y: 200 }, { left: 0, top: 50 }, 0, 0, 1)
assert.ok(pinch)
const zoomed = zoom.updatePinch(pinch, { x: 50, y: 200 }, { x: 250, y: 200 }, { left: 0, top: 50 })
assert.equal(zoomed.zoom, 2)
assert.equal(zoomed.scrollLeft, 150)
assert.equal(zoomed.scrollTop, 150)

// 4. Double-tap zoom rejects single-finger drag & accepts clean double-tap
const t1 = { time: 1000, x: 120, y: 240 }
assert.equal(zoom.isValidDoubleTap(t1, { time: 1180, x: 124, y: 242 }, 4), true)
assert.equal(zoom.isValidDoubleTap(t1, { time: 1180, x: 124, y: 242 }, 22), false, 'Single-finger drag must not trigger double-tap')
assert.equal(zoom.isValidDoubleTap(t1, { time: 1500, x: 120, y: 240 }, 0), false, 'Slow taps must not trigger double-tap')
assert.equal(zoom.toggleDoubleTapZoom(1), 2)
assert.equal(zoom.toggleDoubleTapZoom(2), 1)

// 5. CSS & component contract checks for zoom toolbar bounds, safe areas, notifications, and queue access
const [teacherCss, scoreCss, markingTsx, appTsx, workspaceTsx, notifyTsx] = await Promise.all([
  readFile(new URL('../src/mobile-teacher.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/mobile-score-layout.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/MobileMarking.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/MobileTeacherApp.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ReviewWorkspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/WorkspaceNotifications.tsx', import.meta.url), 'utf8'),
])

assert.match(teacherCss, /\.m-zoom-bar\s*\{[\s\S]*max-width:\s*100%[\s\S]*flex-wrap:\s*wrap/, 'Zoom bar must wrap within viewport width')
assert.match(teacherCss, /\.m-zoom-bar button\s*\{[\s\S]*min-width:\s*44px[\s\S]*min-height:\s*44px/, 'Zoom buttons must keep 44px touch targets')
assert.match(teacherCss, /\.m-sheet-stage \.review-sheet,[\s\S]*max-width:\s*none/, 'SVG .review-sheet must allow scaling past 100%')
assert.match(teacherCss, /\.m-reading\s*\{[\s\S]*touch-action:\s*pan-x pan-y/, 'Reading viewport must allow 1-finger panning in all directions')
assert.match(scoreCss, /max-height:\s*430px[\s\S]*\.m-presets/, 'Short keyboard viewport must keep presets compact and actions reachable')
assert.match(scoreCss, /\.m-marking\.is-landscape \.m-deck/, 'Landscape score deck rules must exist')
assert.match(markingTsx, /pendingCount[\s\S]*openQueueModal/, 'MobileMarking must expose local queue modal when records are pending')
assert.match(markingTsx, /待汇总/, 'MobileMarking history must explicitly display 待汇总 when final_score is null')
assert.match(markingTsx, /historyError[\s\S]*历史评分加载失败/, 'History load error must not render as empty history')
assert.match(markingTsx, /progress\.error[\s\S]*评阅进度加载失败/, 'Progress load error must not render as zero progress')
assert.match(appTsx, /WorkspaceNotificationsProvider\s+isAdmin=\{false\}\s+offline=\{offlineAccess\}/, 'MobileTeacherApp must mount teacher-only offline-guarded notifications')
assert.match(appTsx, /created_at/, 'MobileHome must display exam creation time')
assert.match(appTsx, /阅卷 \$\{row\.ordinary_completed/, 'MobileProjectQuestions must display ordinary and arbitration progress')
assert.match(workspaceTsx, /openQueueModal/, 'ReviewWorkspace must expose openQueueModal')
assert.match(notifyTsx, /offline\s*=\s*false/, 'WorkspaceNotificationsProvider must guard offline identity from polling')

console.log('Mobile marking zoom & parity passed: 50%-400% zoom, pinch center, drag-safe double-tap, 44px wrapping toolbar, notifications, and queue access')
