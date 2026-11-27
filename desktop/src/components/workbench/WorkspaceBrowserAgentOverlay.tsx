import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Hand, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { StatusDot } from '@/components/ui/Badge'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import type { BrowserUseTargetRect } from '@/lib/desktopHost/types'
import {
  isWorkspaceBrowserGestureActive,
  isWorkspaceBrowserSlotShown,
  subscribeWorkspaceBrowserGesture,
  subscribeWorkspaceBrowserOverlayHost,
} from '@/lib/workspace/browserGuests'
import { formatTakeoverReason } from '@/components/chat/toolCallPresentation'
import { useBrowserUseStore } from '@/stores/browserUseStore'

const SCOOT_DISTANCE_THRESHOLD_PX = 160
const MIN_DURATION_MS = 220
const MAX_DURATION_MS = 460
const HIGHLIGHT_MS = 520
const RIPPLE_MS = 520
const CLICK_PRESS_MS = 180
const TRAIL_HOLD_MS = 120
const TRAIL_FADE_MS = 460
const IDLE_DIM_MS = 2400
const MAX_TRAIL_POINTS = 24

type Point = { x: number; y: number }

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function shouldSkipCursorAnimation(tabId: string, showOverlay: boolean): boolean {
  if (!showOverlay) return true
  if (!isWorkspaceBrowserSlotShown(tabId)) return true
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return true
  if (prefersReducedMotion()) return true
  return false
}

export function computeCursorDurationMs(distancePx: number, requestedDurationMs?: number): number {
  if (typeof requestedDurationMs === 'number' && Number.isFinite(requestedDurationMs) && requestedDurationMs > 0) {
    return Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, Math.round(requestedDurationMs)))
  }
  const normalized = Math.min(1, Math.max(0, distancePx / 900))
  return Math.round(MIN_DURATION_MS + normalized * (MAX_DURATION_MS - MIN_DURATION_MS))
}

export function interpolateCursorPosition(
  from: Point,
  to: Point,
  t: number,
): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  const clamped = Math.max(0, Math.min(1, t))
  // Smooth ease-out cubic for short hops ("scoot") and long arcs alike.
  const ease = 1 - (1 - clamped) ** 3
  if (distance <= SCOOT_DISTANCE_THRESHOLD_PX) {
    return {
      x: from.x + dx * ease,
      y: from.y + dy * ease,
    }
  }
  // Curved quadratic Bezier for longer trajectories (> 160px).
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const bend = Math.min(72, distance * 0.16)
  const ctrlX = midX - (dy / distance) * bend
  const ctrlY = midY + (dx / distance) * bend
  const inv = 1 - ease
  return {
    x: inv * inv * from.x + 2 * inv * ease * ctrlX + ease * ease * to.x,
    y: inv * inv * from.y + 2 * inv * ease * ctrlY + ease * ease * to.y,
  }
}

export function sampleCursorTrajectory(from: Point, to: Point, steps = 12): Point[] {
  const count = Math.max(2, steps)
  const points: Point[] = []
  for (let i = 0; i <= count; i += 1) {
    points.push(interpolateCursorPosition(from, to, i / count))
  }
  return points
}

export function buildTrailSvgPath(points: readonly Point[]): string {
  if (points.length < 2) return ''
  let path = `M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`
  for (let i = 1; i < points.length - 1; i += 1) {
    const curr = points[i]!
    const next = points[i + 1]!
    const midX = ((curr.x + next.x) / 2).toFixed(1)
    const midY = ((curr.y + next.y) / 2).toFixed(1)
    path += ` Q ${curr.x.toFixed(1)} ${curr.y.toFixed(1)} ${midX} ${midY}`
  }
  const last = points[points.length - 1]!
  path += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`
  return path
}

function resolveInitialCursorOrigin(host: HTMLDivElement | null, to: Point): Point {
  const rect = host?.getBoundingClientRect()
  if (rect && rect.width > 80 && rect.height > 80) {
    return {
      x: Math.round(rect.width * 0.5),
      y: Math.round(rect.height * 0.78),
    }
  }
  return {
    x: Math.max(24, to.x - 160),
    y: Math.max(24, to.y + 110),
  }
}

export type WorkspaceBrowserAgentOverlayProps = {
  tabId: string
}

/**
 * Virtual cursor with curved trajectory trail, target highlight, click ripple,
 * takeover shield, and bottom-center control pill for an agent-controlled
 * Workspace Browser tab.
 *
 * Portaled into `record.slot`'s in-slot overlay host (a sibling AFTER
 * `<webview>` in `browserGuests.ts`) so it always composites ABOVE the guest
 * webview instead of underneath `WorkspaceBrowserGuestLayer`.
 */
export function WorkspaceBrowserAgentOverlay({ tabId }: WorkspaceBrowserAgentOverlayProps) {
  const t = useTranslation()
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null)
  const [gestureActive, setGestureActive] = useState<boolean>(() => isWorkspaceBrowserGestureActive())
  const tabState = useBrowserUseStore((state) => state.tabStates[tabId])
  const [cursorPos, setCursorPos] = useState<Point | null>(null)
  const [cursorVisible, setCursorVisible] = useState(false)
  const [cursorResting, setCursorResting] = useState(false)
  const [cursorPressed, setCursorPressed] = useState(false)
  const [trailPoints, setTrailPoints] = useState<Point[]>([])
  const [trailFading, setTrailFading] = useState(false)
  const [highlightRect, setHighlightRect] = useState<BrowserUseTargetRect | null>(null)
  const [activeRipple, setActiveRipple] = useState<{ x: number; y: number; seq: number } | null>(null)

  const overlayHostRef = useRef<HTMLDivElement | null>(null)
  overlayHostRef.current = overlayHost
  const cursorPosRef = useRef<Point | null>(null)
  const ackedMoveIdRef = useRef<string | null>(null)
  const rafRef = useRef<number | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rippleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trailHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trailClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => subscribeWorkspaceBrowserOverlayHost(tabId, setOverlayHost), [tabId])
  useEffect(() => subscribeWorkspaceBrowserGesture(setGestureActive), [])

  const controlState = tabState?.controlState ?? 'idle'
  const showOverlay = tabState?.showOverlay ?? true
  const cursor = tabState?.cursor ?? null
  const ripple = tabState?.ripple ?? null
  const actionLabel = tabState?.actionLabel
  const takeoverReason = tabState?.takeoverReason
  const sessionId = tabState?.sessionId

  const ackMove = useCallback((moveId: string, skipped: boolean) => {
    if (ackedMoveIdRef.current === moveId) return
    ackedMoveIdRef.current = moveId
    void getDesktopHost().browserUse.reportCursorArrived({
      moveId,
      tabId,
      skipped,
    }).catch(() => {})
  }, [tabId])

  // Cursor choreography, visible curved trajectory trail, and deadlock-proof ACK.
  useEffect(() => {
    if (!cursor) return
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    if (trailHoldTimerRef.current !== null) {
      clearTimeout(trailHoldTimerRef.current)
      trailHoldTimerRef.current = null
    }
    if (trailClearTimerRef.current !== null) {
      clearTimeout(trailClearTimerRef.current)
      trailClearTimerRef.current = null
    }

    const to: Point = { x: cursor.x, y: cursor.y }
    const schedulePostArrival = () => {
      if (cursor.targetRect) {
        setHighlightRect(cursor.targetRect)
        if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = setTimeout(() => {
          setHighlightRect(null)
          highlightTimerRef.current = null
        }, HIGHLIGHT_MS)
      }
      trailHoldTimerRef.current = setTimeout(() => {
        setTrailFading(true)
        trailHoldTimerRef.current = null
        trailClearTimerRef.current = setTimeout(() => {
          setTrailPoints([])
          setTrailFading(false)
          trailClearTimerRef.current = null
        }, TRAIL_FADE_MS)
      }, TRAIL_HOLD_MS)
      idleTimerRef.current = setTimeout(() => {
        setCursorResting(true)
        idleTimerRef.current = null
      }, IDLE_DIM_MS)
    }

    if (shouldSkipCursorAnimation(tabId, showOverlay)) {
      cursorPosRef.current = to
      setCursorPos(to)
      setCursorVisible(showOverlay)
      setCursorResting(false)
      setTrailPoints([])
      setTrailFading(false)
      ackMove(cursor.moveId, true)
      if (showOverlay) schedulePostArrival()
      return
    }

    const from = cursorPosRef.current ?? resolveInitialCursorOrigin(overlayHostRef.current, to)
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const durationMs = computeCursorDurationMs(distance, cursor.durationMs)
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    let settled = false
    const sampledTrail: Point[] = [from]

    const finish = (usedFallback = false) => {
      if (settled) return
      settled = true
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (fallbackTimerRef.current !== null) {
        clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
      cursorPosRef.current = to
      setCursorPos(to)
      if (usedFallback || sampledTrail.length < 3) {
        setTrailPoints(sampleCursorTrajectory(from, to, 12))
      } else {
        setTrailPoints([...sampledTrail.slice(-(MAX_TRAIL_POINTS - 1)), to])
      }
      ackMove(cursor.moveId, false)
      schedulePostArrival()
    }

    setCursorVisible(true)
    setCursorResting(false)
    setTrailFading(false)
    setTrailPoints([from])
    if (cursor.targetRect) {
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = null
      }
      setHighlightRect(cursor.targetRect)
    }

    const tick = (now: number) => {
      if (settled) return
      const elapsed = now - startedAt
      const progress = durationMs > 0 ? Math.min(1, elapsed / durationMs) : 1
      const pos = interpolateCursorPosition(from, to, progress)
      cursorPosRef.current = pos
      const prev = sampledTrail[sampledTrail.length - 1]
      if (!prev || Math.hypot(pos.x - prev.x, pos.y - prev.y) >= 4) {
        sampledTrail.push(pos)
        if (sampledTrail.length > MAX_TRAIL_POINTS) {
          sampledTrail.shift()
        }
      }
      setCursorPos(pos)
      setTrailPoints([...sampledTrail])
      if (progress >= 1) {
        finish(false)
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    fallbackTimerRef.current = setTimeout(() => finish(true), durationMs + 100)

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (fallbackTimerRef.current !== null) {
        clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
    }
  }, [ackMove, cursor, showOverlay, tabId])

  // Click ripple + subtle cursor press feedback.
  useEffect(() => {
    if (!ripple || !showOverlay || prefersReducedMotion()) return
    setActiveRipple({ x: ripple.x, y: ripple.y, seq: ripple.seq })
    setCursorPressed(true)
    if (pressTimerRef.current !== null) clearTimeout(pressTimerRef.current)
    pressTimerRef.current = setTimeout(() => {
      setCursorPressed(false)
      pressTimerRef.current = null
    }, CLICK_PRESS_MS)
    if (rippleTimerRef.current !== null) clearTimeout(rippleTimerRef.current)
    rippleTimerRef.current = setTimeout(() => {
      setActiveRipple(null)
      rippleTimerRef.current = null
    }, RIPPLE_MS)
  }, [ripple, showOverlay])

  // Clear ephemeral overlay visuals when returning to idle.
  useEffect(() => {
    if (controlState !== 'idle') return
    cursorPosRef.current = null
    setCursorVisible(false)
    setCursorResting(false)
    setCursorPressed(false)
    setTrailPoints([])
    setTrailFading(false)
    setHighlightRect(null)
    setActiveRipple(null)
  }, [controlState])

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current)
    if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current)
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
    if (rippleTimerRef.current !== null) clearTimeout(rippleTimerRef.current)
    if (pressTimerRef.current !== null) clearTimeout(pressTimerRef.current)
    if (trailHoldTimerRef.current !== null) clearTimeout(trailHoldTimerRef.current)
    if (trailClearTimerRef.current !== null) clearTimeout(trailClearTimerRef.current)
  }, [])

  const triggerTakeover = useCallback(() => {
    void getDesktopHost().browserUse.sendUserAction({
      tabId,
      action: 'takeover',
      reason: 'user_requested',
    }).catch(() => {})
  }, [tabId])

  const triggerStop = useCallback(() => {
    void getDesktopHost().browserUse.sendUserAction({
      tabId,
      action: 'stop',
    }).catch(() => {})
  }, [tabId])

  const triggerResume = useCallback(() => {
    if (sessionId) {
      void useBrowserUseStore.getState().resumeTakeover(sessionId)
      return
    }
    void getDesktopHost().browserUse.sendUserAction({
      tabId,
      action: 'resume',
    }).catch(() => {})
  }, [sessionId, tabId])

  const triggerCancel = useCallback(() => {
    if (sessionId) {
      void useBrowserUseStore.getState().abortTakeover(sessionId, undefined, 'user_cancelled')
      return
    }
    void getDesktopHost().browserUse.sendUserAction({
      tabId,
      action: 'cancel',
    }).catch(() => {})
  }, [sessionId, tabId])

  // Escape key triggers takeover while agent is active on a visible tab.
  useEffect(() => {
    if (controlState !== 'active') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!isWorkspaceBrowserSlotShown(tabId)) return
      event.preventDefault()
      triggerTakeover()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controlState, tabId, triggerTakeover])

  if (!overlayHost || controlState === 'idle') return null

  const isTakeover = controlState === 'takeover'
  const pillStatusText = isTakeover
    ? t('browserUse.overlay.takeoverPrompt', {
        reason: formatTakeoverReason(undefined, takeoverReason, t),
      })
    : (actionLabel || t('browserUse.overlay.controlling'))
  const trailPath = trailPoints.length >= 2 ? buildTrailSvgPath(trailPoints) : ''
  const cursorTagLabel = cursor?.label || actionLabel

  return createPortal(
    <div
      data-testid="workspace-browser-agent-overlay"
      data-control-state={controlState}
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* Active-state takeover shield: intercepts real human input so it never races CDP.
          Removed during takeover so the user interacts directly with <webview>.
          Yields pointer events during app drags (resize handles, tab reorder). */}
      {!isTakeover ? (
        <div
          data-testid="browser-agent-takeover-shield"
          aria-label={t('browserUse.overlay.shieldLabel')}
          className={`absolute inset-0 cursor-pointer ${gestureActive ? 'pointer-events-none' : 'pointer-events-auto'}`}
          onPointerDown={(event) => {
            if (isWorkspaceBrowserGestureActive()) return
            event.preventDefault()
            event.stopPropagation()
            triggerTakeover()
          }}
          onWheel={(event) => {
            if (isWorkspaceBrowserGestureActive()) return
            event.stopPropagation()
            triggerTakeover()
          }}
        />
      ) : null}

      {/* Viewport border glow: subtle info outline when active, amber border in takeover. */}
      <div
        aria-hidden="true"
        data-testid="browser-agent-viewport-frame"
        className={`pointer-events-none absolute inset-0 border-2 transition-colors duration-200 ${
          isTakeover
            ? 'border-[var(--color-warning)]'
            : 'border-[var(--color-info)]'
        }`}
      />

      {/* Curved cursor motion trajectory trail */}
      {showOverlay && !isTakeover && trailPath ? (
        <svg
          aria-hidden="true"
          data-testid="browser-agent-cursor-trail"
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible transition-opacity duration-300"
          style={{ opacity: trailFading ? 0 : 1 }}
        >
          <path
            d={trailPath}
            fill="none"
            stroke="var(--color-info)"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity="0.18"
          />
          <path
            d={trailPath}
            fill="none"
            stroke="var(--color-info)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity="0.78"
          />
          {trailPoints.slice(0, -1).map((point, index) => {
            const ratio = (index + 1) / trailPoints.length
            return (
              <circle
                key={`${index}-${Math.round(point.x)}-${Math.round(point.y)}`}
                cx={point.x}
                cy={point.y}
                r={1.4 + ratio * 1.8}
                fill="var(--color-info)"
                fillOpacity={0.14 + ratio * 0.45}
              />
            )
          })}
        </svg>
      ) : null}

      {/* Target highlight box (lights up on approach, holds 520ms after arrival) */}
      {showOverlay && !isTakeover && highlightRect ? (
        <div
          aria-hidden="true"
          data-testid="browser-agent-target-highlight"
          className="pointer-events-none absolute rounded-[var(--radius-sm)] border-2 border-[var(--color-info)] bg-[var(--color-info-container)] opacity-60 transition-opacity duration-200"
          style={{
            left: `${highlightRect.x}px`,
            top: `${highlightRect.y}px`,
            width: `${highlightRect.width}px`,
            height: `${highlightRect.height}px`,
          }}
        />
      ) : null}

      {/* Double-ring click ripple */}
      {showOverlay && !isTakeover && activeRipple ? (
        <div
          key={activeRipple.seq}
          aria-hidden="true"
          data-testid="browser-agent-click-ripple"
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
          style={{
            left: `${activeRipple.x}px`,
            top: `${activeRipple.y}px`,
          }}
        >
          <span className="block h-8 w-8 animate-ping rounded-full border-2 border-[var(--color-info)] opacity-80" />
          <span className="absolute inset-1 block rounded-full border-2 border-[var(--color-info)] bg-[var(--color-info-container)] opacity-65" />
        </div>
      ) : null}

      {/* Virtual cursor + floating action pill */}
      {showOverlay && !isTakeover && cursorPos && cursorVisible ? (
        <div
          aria-hidden="true"
          data-testid="browser-agent-virtual-cursor"
          data-resting={cursorResting ? 'true' : 'false'}
          className={`pointer-events-none absolute left-0 top-0 transition-opacity duration-200 ${cursorResting ? 'opacity-65' : 'opacity-100'}`}
          style={{
            transform: `translate3d(${cursorPos.x}px, ${cursorPos.y}px, 0)`,
          }}
        >
          <div
            className="origin-top-left transition-transform duration-150"
            style={{
              transform: cursorPressed ? 'scale(0.84)' : 'scale(1)',
            }}
          >
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              className="drop-shadow-md"
            >
              <path
                d="M4 3L19.5 11.5L12.4 13.5L9.4 20.5L4 3Z"
                fill="var(--color-info)"
                stroke="var(--color-surface-container-lowest)"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          {cursorTagLabel && !cursorResting ? (
            <span
              data-testid="browser-agent-cursor-label"
              className="absolute left-5 top-5 max-w-[200px] truncate rounded-full border border-[var(--color-info)] bg-[var(--color-info-container)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-on-info-container)] shadow-[var(--shadow-dropdown)]"
            >
              {cursorTagLabel}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Bottom-center floating control pill */}
      <div
        role="status"
        aria-live="polite"
        data-testid="browser-agent-control-pill"
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        className={`absolute bottom-4 left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-full border px-3.5 py-1.5 shadow-[var(--shadow-dropdown)] backdrop-blur-md ${
          gestureActive ? 'pointer-events-none' : 'pointer-events-auto'
        } ${
          isTakeover
            ? 'border-[var(--color-warning)] bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'
            : 'border-[var(--color-border)] bg-[var(--color-surface-glass)] text-[var(--color-text-primary)]'
        }`}
      >
        <StatusDot tone={isTakeover ? 'warning' : 'info'} size="sm" pulse />
        <span className="min-w-0 max-w-[320px] truncate text-[12px] font-medium">
          {pillStatusText}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {isTakeover ? (
            <>
              <Button
                variant="primary"
                size="xs"
                icon={<Check size={12} strokeWidth={1.75} aria-hidden="true" />}
                onClick={triggerResume}
              >
                {t('browserUse.overlay.resume')}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                icon={<X size={12} strokeWidth={1.75} aria-hidden="true" />}
                onClick={triggerCancel}
              >
                {t('browserUse.overlay.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                size="xs"
                icon={<Hand size={12} strokeWidth={1.75} aria-hidden="true" />}
                onClick={triggerTakeover}
              >
                {t('browserUse.overlay.takeover')}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                icon={<Square size={11} strokeWidth={1.75} aria-hidden="true" />}
                onClick={triggerStop}
              >
                {t('browserUse.overlay.stop')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>,
    overlayHost,
  )
}
