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

const SCOOT_DISTANCE_THRESHOLD_PX = 196
const MIN_DURATION_MS = 160
const MAX_DURATION_MS = 380
const HIGHLIGHT_MS = 80
const RIPPLE_MS = 420
const IDLE_FADE_MS = 2000

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
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
): { x: number; y: number } {
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
  // Curved quadratic Bezier for longer trajectories (> 196px).
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const bend = Math.min(64, distance * 0.14)
  const ctrlX = midX - (dy / distance) * bend
  const ctrlY = midY + (dx / distance) * bend
  const inv = 1 - ease
  return {
    x: inv * inv * from.x + 2 * inv * ease * ctrlX + ease * ease * to.x,
    y: inv * inv * from.y + 2 * inv * ease * ctrlY + ease * ease * to.y,
  }
}

export type WorkspaceBrowserAgentOverlayProps = {
  tabId: string
}

/**
 * Virtual cursor, takeover shield, and bottom-center control pill for an
 * agent-controlled Workspace Browser tab.
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
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null)
  const [cursorVisible, setCursorVisible] = useState(false)
  const [highlightRect, setHighlightRect] = useState<BrowserUseTargetRect | null>(null)
  const [activeRipple, setActiveRipple] = useState<{ x: number; y: number; seq: number } | null>(null)

  const cursorPosRef = useRef<{ x: number; y: number } | null>(null)
  const ackedMoveIdRef = useRef<string | null>(null)
  const rafRef = useRef<number | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rippleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Cursor choreography + deadlock-proof ACK.
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

    const to = { x: cursor.x, y: cursor.y }
    const flashHighlightAndFade = () => {
      if (cursor.targetRect) {
        setHighlightRect(cursor.targetRect)
        if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = setTimeout(() => {
          setHighlightRect(null)
          highlightTimerRef.current = null
        }, HIGHLIGHT_MS)
      }
      idleTimerRef.current = setTimeout(() => {
        setCursorVisible(false)
        idleTimerRef.current = null
      }, IDLE_FADE_MS)
    }

    if (shouldSkipCursorAnimation(tabId, showOverlay)) {
      cursorPosRef.current = to
      setCursorPos(to)
      setCursorVisible(showOverlay)
      ackMove(cursor.moveId, true)
      if (showOverlay) flashHighlightAndFade()
      return
    }

    const from = cursorPosRef.current ?? { x: Math.max(0, to.x - 48), y: Math.max(0, to.y - 32) }
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const durationMs = computeCursorDurationMs(distance, cursor.durationMs)
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    let settled = false

    const finish = () => {
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
      ackMove(cursor.moveId, false)
      flashHighlightAndFade()
    }

    setCursorVisible(true)
    const tick = (now: number) => {
      if (settled) return
      const elapsed = now - startedAt
      const progress = durationMs > 0 ? Math.min(1, elapsed / durationMs) : 1
      const pos = interpolateCursorPosition(from, to, progress)
      cursorPosRef.current = pos
      setCursorPos(pos)
      if (progress >= 1) {
        finish()
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    fallbackTimerRef.current = setTimeout(finish, durationMs + 100)

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

  // Click ripple animation.
  useEffect(() => {
    if (!ripple || !showOverlay || prefersReducedMotion()) return
    setActiveRipple({ x: ripple.x, y: ripple.y, seq: ripple.seq })
    if (rippleTimerRef.current !== null) clearTimeout(rippleTimerRef.current)
    rippleTimerRef.current = setTimeout(() => {
      setActiveRipple(null)
      rippleTimerRef.current = null
    }, RIPPLE_MS)
  }, [ripple, showOverlay])

  // Clear timers on unmount or return to idle.
  useEffect(() => {
    if (controlState !== 'idle') return
    setCursorVisible(false)
    setHighlightRect(null)
    setActiveRipple(null)
  }, [controlState])

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current)
    if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current)
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current)
    if (rippleTimerRef.current !== null) clearTimeout(rippleTimerRef.current)
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
          role="region"
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

      {/* Viewport border glow: subtle info outline when active, amber ring in takeover. */}
      <div
        aria-hidden="true"
        data-testid="browser-agent-viewport-frame"
        className={`pointer-events-none absolute inset-0 transition-shadow duration-200 motion-reduce:transition-none ${
          isTakeover
            ? 'v6c-ring-waiting'
            : 'v6c-ring-running'
        }`}
      />

      {/* Target highlight box (80ms) */}
      {showOverlay && !isTakeover && highlightRect ? (
        <div
          aria-hidden="true"
          data-testid="browser-agent-target-highlight"
          className="pointer-events-none absolute rounded-[var(--radius-sm)] border-2 border-[var(--color-info)] bg-[var(--color-info-container)] opacity-60"
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
          <span className="block h-7 w-7 animate-ping rounded-full border-2 border-[var(--color-info)] opacity-75" />
          <span className="absolute inset-1 block rounded-full border border-[var(--color-info)] bg-[var(--color-info-container)] opacity-60" />
        </div>
      ) : null}

      {/* Virtual cursor */}
      {showOverlay && !isTakeover && cursorPos && cursorVisible ? (
        <div
          aria-hidden="true"
          data-testid="browser-agent-virtual-cursor"
          className="pointer-events-none absolute left-0 top-0 transition-opacity duration-200 motion-reduce:transition-none"
          style={{
            transform: `translate3d(${cursorPos.x}px, ${cursorPos.y}px, 0)`,
          }}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            className="drop-shadow-sm"
          >
            <path
              d="M4 3L19 11.5L12.2 13.4L9.2 20L4 3Z"
              fill="var(--color-info)"
              stroke="var(--color-surface-container-lowest)"
              strokeWidth="1.75"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      ) : null}

      {/* Bottom-center floating control bar */}
      <div
        role="status"
        aria-live="polite"
        data-testid="browser-agent-control-pill"
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        className={`dropdown-glass absolute bottom-4 left-1/2 z-[var(--z-sticky)] flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-[var(--radius-xl)] px-3 py-1.5 text-[var(--color-text-primary)] ${
          gestureActive ? 'pointer-events-none' : 'pointer-events-auto'
        } ${isTakeover ? 'v6c-ring-waiting' : ''}`}
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
