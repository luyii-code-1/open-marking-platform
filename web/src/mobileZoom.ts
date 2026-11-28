export const MOBILE_MIN_ZOOM = 0.5
export const MOBILE_MAX_ZOOM = 4
export const MOBILE_ZOOM_STEP = 0.25
export const DOUBLE_TAP_MAX_MS = 300
export const DOUBLE_TAP_MAX_MOVE_PX = 12

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  const clamped = Math.min(MOBILE_MAX_ZOOM, Math.max(MOBILE_MIN_ZOOM, value))
  return Math.round(clamped * 100) / 100
}

export function stepZoom(current: number, direction: 1 | -1): number {
  return clampZoom(current + direction * MOBILE_ZOOM_STEP)
}

export function canZoomOut(zoom: number): boolean {
  return zoom > MOBILE_MIN_ZOOM + 1e-6
}

export function canZoomIn(zoom: number): boolean {
  return zoom < MOBILE_MAX_ZOOM - 1e-6
}

export function isDefaultZoom(zoom: number): boolean {
  return Math.abs(zoom - 1) < 1e-6
}

/**
 * Computes explicit pixel width for the answer stage inside the scrollable viewport.
 * Ensures both multi-region SVG (.review-sheet) and legacy <img> visibly scale across 50%-400%
 * without expanding outer grid/flex containers.
 */
export function computeStagePixelWidth(viewportWidth: number, zoom: number, horizontalPadding = 16): number {
  const baseWidth = Math.max(120, viewportWidth - horizontalPadding)
  return Math.max(80, Math.round(baseWidth * clampZoom(zoom)))
}

export type PinchState = {
  startDist: number
  startZoom: number
  startScrollLeft: number
  startScrollTop: number
  anchorContentX: number
  anchorContentY: number
}

export function beginPinch(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  viewportRect: { left: number; top: number },
  scrollLeft: number,
  scrollTop: number,
  currentZoom: number,
): PinchState | null {
  const startDist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
  if (!(startDist > 4)) return null
  const midX = (p1.x + p2.x) / 2 - viewportRect.left
  const midY = (p1.y + p2.y) / 2 - viewportRect.top
  return {
    startDist,
    startZoom: currentZoom,
    startScrollLeft: scrollLeft,
    startScrollTop: scrollTop,
    anchorContentX: (scrollLeft + midX) / currentZoom,
    anchorContentY: (scrollTop + midY) / currentZoom,
  }
}

export function updatePinch(
  pinch: PinchState,
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  viewportRect: { left: number; top: number },
): { zoom: number; scrollLeft: number; scrollTop: number } {
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
  const zoom = clampZoom(pinch.startZoom * (dist / pinch.startDist))
  const midX = (p1.x + p2.x) / 2 - viewportRect.left
  const midY = (p1.y + p2.y) / 2 - viewportRect.top
  const scrollLeft = Math.max(0, Math.round(pinch.anchorContentX * zoom - midX))
  const scrollTop = Math.max(0, Math.round(pinch.anchorContentY * zoom - midY))
  return { zoom, scrollLeft, scrollTop }
}

export type TapRecord = { time: number; x: number; y: number }

export function isValidDoubleTap(
  previous: TapRecord | null,
  current: TapRecord,
  pointerMovedPx: number,
): boolean {
  if (!previous) return false
  if (pointerMovedPx > DOUBLE_TAP_MAX_MOVE_PX) return false
  const dt = current.time - previous.time
  if (dt <= 0 || dt > DOUBLE_TAP_MAX_MS) return false
  const dist = Math.hypot(current.x - previous.x, current.y - previous.y)
  return dist <= DOUBLE_TAP_MAX_MOVE_PX * 2.5
}

export function toggleDoubleTapZoom(currentZoom: number): number {
  return currentZoom > 1.15 ? 1 : 2
}
