import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  sessionsApi,
  type SessionContextSnapshot,
  type SessionUsageSnapshot,
} from '../../api/sessions'
import { useTranslation } from '../../i18n'
import type { ChatState } from '../../types/chat'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { useDismissable } from '../../hooks/useDismissable'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { deriveSessionUsageMetrics } from '../../lib/sessionUsageMetrics'
import { useContextUsageStore, type ContextUsageRevision } from '@/stores/contextUsageStore'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import {
  ContextUsageDetails,
  type ContextUsageDetailsStatus,
  type ContextUsageSessionStats,
} from './ContextUsageDetails'

type Props = {
  sessionId?: string
  chatState: ChatState
  messageCount: number
  /** Changes with session content even when a bounded history keeps its display count unchanged. */
  contentRevision?: number
  runtimeSelectionKey?: string
  fallbackModelLabel?: string
  draft?: boolean
  compact?: boolean
  /**
   * Bump to force an immediate refresh that bypasses the auto-refresh
   * throttle and any stale in-flight request. Used after context compaction
   * and after a replacement runtime confirms it has started.
   */
  refreshNonce?: number
  /**
   * Keep the indicator mounted (it still tracks the session) but draw no
   * trigger: the phone composer opens the breakdown from its + sheet instead
   * of spending a 44px toolbar slot on it.
   */
  hideTrigger?: boolean
}

export type ContextUsageIndicatorHandle = {
  open: () => void
}

const ACTIVE_REFRESH_MS = 30_000
// Lifetime totals only change when a turn completes, but a turn can run for minutes and the
// user is staring at the panel while it does. Polling is scoped to the open popover/sheet —
// a closed panel costs nothing — and the request it makes is the single-control `usageOnly`
// path, not the full inspection.
const USAGE_POLL_MS = 3_000
// Right after a completed turn, compaction, or runtime restart the CLI can
// still be settling, so retry the event-driven refresh once.
const FORCED_REFRESH_RETRY_MS = 5_000

const POPOVER_WIDTH = 340
const POPOVER_GAP = 8
const VIEWPORT_MARGIN = 16
// The collapsed panel is much shorter than the old always-expanded breakdown; the expanded
// section scrolls inside the panel via overflow-y-auto instead of growing the cap back.
const POPOVER_MAX_HEIGHT = 340

type PopoverPosition = {
  top?: number
  bottom?: number
  left: number
  width: number
  maxHeight: number
}

function formatPercent(value: number | undefined) {
  const percent = Math.max(0, Math.min(100, value ?? 0))
  return `${percent.toFixed(percent >= 10 || Number.isInteger(percent) ? 0 : 1)}%`
}

function formatUpdatedAt(timestamp: number | null, t: ReturnType<typeof useTranslation>) {
  if (!timestamp) return t('contextIndicator.updatedUnknown')
  const elapsedMs = Date.now() - timestamp
  if (elapsedMs < 60_000) return t('contextIndicator.updatedNow')
  const minutes = Math.max(1, Math.floor(elapsedMs / 60_000))
  return t('contextIndicator.updatedMinutes', { count: minutes })
}

function pickUsedContextCategory(context: SessionContextSnapshot) {
  const ignored = new Set(['free space', 'autocompact buffer'])
  // No top-N cap: the segmented bar compresses any count into one strip, and the collapsible
  // breakdown is the diagnostic view where the long tail (MCP tools, memory files) matters.
  return context.categories
    .filter((category) => category.tokens > 0 && !category.isDeferred && !ignored.has(category.name.toLowerCase()))
    .sort((a, b) => b.tokens - a.tokens)
}

function firstNonEmpty(...values: Array<string | undefined | null>) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function isCliNotRunningError(error: string | null) {
  return error?.toLowerCase().includes('cli session is not running') ?? false
}

function isDocumentVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * The toolbar's context ring: an outline-colored track with an arc drawn to
 * `percentage`. `null` means no reading yet (track only); `loading` swaps the
 * arc for a quarter-turn spinner on the same track, so the control keeps its
 * footprint while the first inspection is in flight.
 */
function ContextRing({
  size,
  loading,
  percentage,
  color,
}: {
  size: number
  loading: boolean
  percentage: number | null
  color: string
}) {
  const radius = 6.25
  const circumference = 2 * Math.PI * radius
  const arc = loading ? 0.25 : percentage === null ? 0 : Math.max(0, Math.min(100, percentage)) / 100
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-testid="context-usage-ring"
      className={`shrink-0 -rotate-90 ${loading ? 'motion-safe:animate-spin' : ''}`}
    >
      <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--color-outline)" strokeWidth="2.5" />
      {arc > 0 && (
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke={loading ? 'var(--color-text-tertiary)' : color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - arc)}
        />
      )}
    </svg>
  )
}

function shouldFetchContext(
  sessionId: string | undefined,
  draft: boolean,
  messageCount: number,
  chatState: ChatState,
) {
  return Boolean(sessionId) && !draft && (messageCount > 0 || chatState !== 'idle')
}

export const ContextUsageIndicator = forwardRef<ContextUsageIndicatorHandle, Props>(function ContextUsageIndicator({
  sessionId,
  chatState,
  messageCount,
  contentRevision = 0,
  runtimeSelectionKey = '',
  fallbackModelLabel,
  draft = false,
  compact = false,
  refreshNonce = 0,
  hideTrigger = false,
}, handleRef) {
  const t = useTranslation()
  // `compact` also fires for the desktop composer, which narrows for the right
  // panel rather than for touch, so the phone touch target keys off the
  // viewport instead — see the trigger's height below.
  const isMobileBrowser = useMobileViewport() && !isDesktopRuntime()
  // Narrow composer (Workbench / small window) and real H5 share the sheet
  // presentation so the breakdown is never clipped by chat-column overflow.
  const preferSheet = compact || isMobileBrowser
  const contextEnabled = shouldFetchContext(sessionId, draft, messageCount, chatState)
  const cached = useContextUsageStore((state) => sessionId ? state.bySession[sessionId] : undefined)
  const context = contextEnabled ? cached?.context ?? null : null
  const contextSource = cached?.source ?? null
  const loading = contextEnabled && (!cached || cached.inFlight !== null)
  const error = cached?.error ?? null
  const updatedAt = cached?.updatedAt ?? null
  const inspectionModel = cached?.model ?? null
  const [usage, setUsage] = useState<SessionUsageSnapshot | null>(null)
  const usageSessionIdRef = useRef<string | undefined>(undefined)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const contextEnabledRef = useRef(contextEnabled)
  contextEnabledRef.current = contextEnabled
  const revisionRef = useRef<ContextUsageRevision>({ runtimeSelectionKey, refreshNonce, messageCount, contentRevision, chatState })
  revisionRef.current = { runtimeSelectionKey, refreshNonce, messageCount, contentRevision, chatState }

  const closeDetails = useCallback(() => {
    setDetailsOpen(false)
  }, [])

  const refresh = useCallback(async (mode: 'restore' | 'auto' | 'manual' | 'force' = 'manual'): Promise<boolean> => {
    if (!contextEnabledRef.current || !sessionId) return false
    return useContextUsageStore.getState().refresh(sessionId, revisionRef.current, mode, isDocumentVisible())
  }, [sessionId])

  const forceRefreshWithRetry = useCallback(() => {
    if (!contextEnabledRef.current) return () => {}
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    void refresh('force').then((ok) => {
      if (ok || cancelled) return
      retryTimer = setTimeout(() => {
        void refresh('force')
      }, FORCED_REFRESH_RETRY_MS)
    })
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [refresh])

  const cancelBoundaryRetryRef = useRef<(() => void) | null>(null)
  const cancelBoundaryRetry = useCallback(() => {
    cancelBoundaryRetryRef.current?.()
    cancelBoundaryRetryRef.current = null
  }, [])
  // A normal streaming frame or history hydration must not cancel recovery
  // for the boundary being inspected. Identity changes and unmount still do.
  useEffect(() => cancelBoundaryRetry, [cancelBoundaryRetry, contextEnabled, runtimeSelectionKey, sessionId])

  const previousRef = useRef<(ContextUsageRevision & { sessionId?: string; enabled: boolean }) | null>(null)
  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = { sessionId, enabled: contextEnabled, ...revisionRef.current }
    if (!contextEnabled) {
      if (sessionId) useContextUsageStore.getState().clearSession(sessionId)
      return
    }
    // A tab switch restores that session's reading/request. Counters from two
    // different sessions must never be compared as compaction or turn events.
    if (!previous || previous.sessionId !== sessionId || !previous.enabled) {
      void refresh('restore')
    } else if (previous.refreshNonce !== refreshNonce || (previous.chatState !== 'idle' && chatState === 'idle')) {
      // Turn completion, compaction and replacement-runtime readiness bypass
      // both the throttle and requests issued before the boundary.
      cancelBoundaryRetry()
      cancelBoundaryRetryRef.current = forceRefreshWithRetry()
    } else if (previous.runtimeSelectionKey !== runtimeSelectionKey) {
      void refresh('restore')
    } else if (previous.messageCount !== messageCount || previous.contentRevision !== contentRevision) {
      void refresh('auto')
    }
  }, [cancelBoundaryRetry, chatState, contextEnabled, contentRevision, forceRefreshWithRetry, messageCount, refresh, refreshNonce, runtimeSelectionKey, sessionId])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const refreshIfVisible = () => {
      if (!isDocumentVisible()) return
      void refresh('restore')
    }
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => document.removeEventListener('visibilitychange', refreshIfVisible)
  }, [refresh])

  useEffect(() => {
    if (chatState === 'idle') return
    const timer = setInterval(() => {
      void refresh('auto')
    }, ACTIVE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [chatState, messageCount, refresh])

  // Lifetime session totals, polled only while the breakdown is on screen. The request is the
  // single-control `usageOnly` one, so a 3s cadence costs far less than the context refresh it
  // sits next to, and closing the panel takes the timer with it — nothing runs in the
  // background, and a hidden document skips its ticks rather than queueing them.
  useEffect(() => {
    if (!detailsOpen || !sessionId) return
    if (typeof sessionsApi.getSessionUsage !== 'function') return
    let cancelled = false
    // The poll interval is shorter than the request deadline, so a slow server would otherwise
    // let ticks stack up behind the in-flight one. Skipping a tick loses nothing: the answer
    // that is still outstanding is the same answer the new tick would have asked for.
    let inFlight = false
    const controller = new AbortController()

    const load = () => {
      if (inFlight || !isDocumentVisible()) return
      inFlight = true
      void sessionsApi.getSessionUsage(sessionId, controller.signal)
        .then((inspection) => {
          if (cancelled || !inspection.usage) return
          usageSessionIdRef.current = sessionId
          setUsage(inspection.usage)
        })
        .catch(() => {
          // A failed poll (CLI busy, control timeout) leaves the last good numbers on screen.
          // The panel is a readout, not a task; a flickering error would be worse than a
          // value that is three seconds stale.
        })
        .finally(() => {
          inFlight = false
        })
    }

    load()
    const timer = setInterval(load, USAGE_POLL_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [detailsOpen, sessionId])

  // If the presentation mode flips (Workbench drag, H5 resize), drop any open
  // shell so we don't leave a desktop popover stranded on a sheet layout.
  useEffect(() => {
    setDetailsOpen(false)
  }, [preferSheet])

  const details = useMemo(() => {
    if (!context) return []
    return pickUsedContextCategory(context)
  }, [context])

  const displayContext = context
  const hasPlaceholderContext = !displayContext && (
    draft || (!loading && messageCount === 0 && (!error || isCliNotRunningError(error)))
  )
  const isPendingContext = hasPlaceholderContext && !displayContext
  const percentage = displayContext ? Math.max(0, Math.min(100, displayContext.percentage)) : 0
  const usedTokens = displayContext?.totalTokens ?? 0
  const maxTokens = displayContext?.rawMaxTokens ?? 0
  // Neutral ink until the window is genuinely tight; only then does the ring
  // borrow a status color (warning near the limit, error at it).
  const strokeColor = percentage >= 90
    ? 'var(--color-error)'
    : percentage >= 75
      ? 'var(--color-warning)'
      : 'var(--color-text-tertiary)'
  const displayPercent = displayContext ? formatPercent(percentage) : '--'
  const displayModel = firstNonEmpty(displayContext?.model, inspectionModel, fallbackModelLabel)
  const modelLabel = displayModel ?? t('contextIndicator.modelUnknown')
  const ariaLabel = displayContext
    ? t('contextIndicator.ariaLabel', { percent: formatPercent(percentage) })
    : isPendingContext
      ? t('contextIndicator.pendingAria')
    : loading
      ? t('contextIndicator.loadingAria')
      : t('contextIndicator.unavailableAria')

  const detailsStatus: ContextUsageDetailsStatus = displayContext
    ? 'ready'
    : isPendingContext
      ? 'pending'
      : loading
        ? 'loading'
        : 'unavailable'

  const detailLabels = useMemo(() => ({
    title: t('contextIndicator.title'),
    remaining: t('contextIndicator.remaining'),
    used: t('contextIndicator.used'),
    window: t('contextIndicator.window'),
    estimate: t('contextIndicator.estimate'),
    pendingDetail: t('contextIndicator.pendingDetail'),
    loading: t('contextIndicator.loading'),
    unavailableDetail: t('contextIndicator.unavailableDetail'),
    breakdown: t('contextIndicator.breakdown'),
    sessionCacheHit: t('contextIndicator.sessionCacheHit'),
    sessionSpeed: t('contextIndicator.sessionSpeed'),
    sessionCost: t('contextIndicator.sessionCost'),
    sessionSpeedUnit: t('contextIndicator.sessionSpeedUnit'),
  }), [t])

  // Derived per render rather than memoized on `usage` alone: the session it belongs to lives in
  // a ref, so the guard has to run against the current sessionId every time.
  const displayUsage = usageSessionIdRef.current === sessionId ? usage : null
  const sessionStats = useMemo<ContextUsageSessionStats | null>(() => {
    if (!displayUsage) return null
    const metrics = deriveSessionUsageMetrics(displayUsage)
    // A session with nothing produced yet has no honest answer for any of these rows; showing an
    // empty block (or a 0 tok/s) would read as a measurement rather than an absence.
    if (metrics.totalTokens === 0) return null
    return {
      cacheHitRate: metrics.cacheHitRate,
      tokensPerSecond: metrics.tokensPerSecond,
      costDisplay: displayUsage.costDisplay,
    }
  }, [displayUsage])

  const detailsBody = (
    <ContextUsageDetails
      variant={preferSheet ? 'sheet' : 'popover'}
      modelLabel={modelLabel}
      remainingLabel={displayContext ? formatPercent(100 - percentage) : '--'}
      usedTokens={usedTokens}
      maxTokens={maxTokens}
      categories={details}
      sessionStats={sessionStats}
      updatedAtLabel={displayContext ? formatUpdatedAt(updatedAt, t) : undefined}
      estimate={contextSource === 'estimate'}
      status={detailsStatus}
      labels={detailLabels}
    />
  )

  const updatePopoverPosition = useCallback(() => {
    const anchor = triggerRef.current
    if (!anchor) return

    const rect = anchor.getBoundingClientRect()
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    const width = Math.min(POPOVER_WIDTH, Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2))
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.right - width),
      Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
    )

    // Prefer above the composer (the historical hover direction). Fall below
    // only when the top side is too short to keep the breakdown readable.
    const spaceAbove = rect.top - POPOVER_GAP - VIEWPORT_MARGIN
    const spaceBelow = viewportHeight - rect.bottom - POPOVER_GAP - VIEWPORT_MARGIN
    const placeAbove = spaceAbove >= 180 || spaceAbove >= spaceBelow
    const availableHeight = Math.max(160, placeAbove ? spaceAbove : spaceBelow)
    const maxHeight = Math.min(POPOVER_MAX_HEIGHT, availableHeight)

    setPopoverPosition({
      top: placeAbove ? undefined : rect.bottom + POPOVER_GAP,
      bottom: placeAbove
        ? Math.max(VIEWPORT_MARGIN, viewportHeight - rect.top + POPOVER_GAP)
        : undefined,
      left,
      width,
      maxHeight,
    })
  }, [])

  useLayoutEffect(() => {
    if (!detailsOpen || preferSheet) {
      setPopoverPosition(null)
      return
    }
    updatePopoverPosition()
  }, [detailsOpen, preferSheet, updatePopoverPosition, detailsStatus, details.length, displayPercent, modelLabel])

  useEffect(() => {
    if (!detailsOpen || preferSheet) return
    window.addEventListener('resize', updatePopoverPosition)
    window.addEventListener('scroll', updatePopoverPosition, true)
    return () => {
      window.removeEventListener('resize', updatePopoverPosition)
      window.removeEventListener('scroll', updatePopoverPosition, true)
    }
  }, [detailsOpen, preferSheet, updatePopoverPosition])

  useDismissable({
    open: detailsOpen && !preferSheet,
    refs: [popoverRef],
    triggerRef,
    onDismiss: closeDetails,
    stopEscapePropagation: true,
  })

  const handleTriggerClick = () => {
    setDetailsOpen((open) => !open)
    void refresh('manual')
  }

  useImperativeHandle(handleRef, () => ({
    open: () => {
      setDetailsOpen(true)
      void refresh('manual')
    },
  }), [refresh])

  return (
    <div className="relative pointer-events-auto">
      <button
        ref={triggerRef}
        type="button"
        // No reading yet (a draft, or a session before its first turn): a "--"
        // says nothing and costs a toolbar slot, so the ring appears with data.
        hidden={hideTrigger || isPendingContext}
        aria-label={ariaLabel}
        aria-expanded={detailsOpen}
        aria-haspopup="dialog"
        onClick={handleTriggerClick}
        title={t('contextIndicator.title')}
        data-testid="context-usage-indicator"
        // Desktop: a 28px toolbar control showing the ring and the percentage
        // side by side. The phone shell keeps a 44px square touch target and
        // leaves the number to the accessible name — it sits between two
        // other 44px buttons and has no width to spare.
        className={`inline-flex shrink-0 items-center rounded-[var(--radius-sm)] bg-transparent transition-colors duration-150 ease-out hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
          isMobileBrowser ? 'h-11 w-11 justify-center' : 'h-7 gap-1.5 px-1.5'
        } ${detailsOpen ? 'bg-[var(--color-surface-hover)]' : ''}`}
      >
        <ContextRing
          size={isMobileBrowser ? 18 : 16}
          loading={loading && !displayContext}
          percentage={displayContext ? percentage : null}
          color={strokeColor}
        />
        <span
          className={isMobileBrowser
            ? 'sr-only'
            : 'font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]'}
        >
          {displayPercent}
        </span>
      </button>

      {!preferSheet && detailsOpen && popoverPosition && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t('contextIndicator.title')}
          data-testid="context-usage-popover"
          className="fixed z-[var(--z-popover)] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-4 text-left shadow-[var(--shadow-dropdown)]"
          style={{
            top: popoverPosition.top,
            bottom: popoverPosition.bottom,
            left: popoverPosition.left,
            width: popoverPosition.width,
            maxHeight: popoverPosition.maxHeight,
          }}
        >
          {detailsBody}
        </div>,
        document.body,
      )}

      {preferSheet && (
        <MobileBottomSheet
          open={detailsOpen}
          onClose={closeDetails}
          title={t('contextIndicator.title')}
          closeLabel={t('tabs.close')}
          ariaLabel={t('contextIndicator.title')}
          testId="context-usage-sheet"
          headerExtra={(
            <div className="truncate font-mono text-[13px] text-[var(--color-text-secondary)]">
              {modelLabel}
            </div>
          )}
          contentClassName="p-4"
        >
          {detailsBody}
        </MobileBottomSheet>
      )}
    </div>
  )
})
