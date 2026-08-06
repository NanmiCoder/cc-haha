import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { sessionsApi, type SessionContextSnapshot } from '../../api/sessions'
import { useTranslation } from '../../i18n'
import type { ChatState } from '../../types/chat'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { useDismissable } from '../../hooks/useDismissable'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { ContextUsageDetails, type ContextUsageDetailsStatus } from './ContextUsageDetails'

type Props = {
  sessionId?: string
  chatState: ChatState
  messageCount: number
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
}

const ACTIVE_REFRESH_MS = 30_000
// The server bounds the CLI control request at 20s. Keep the HTTP deadline
// comfortably later so the server can return a transcript estimate instead of
// racing a client abort that can strand loopback sockets on Windows.
const CONTEXT_REQUEST_TIMEOUT_MS = 30_000
const AUTO_REFRESH_MIN_INTERVAL_MS = 10_000
// Right after a completed turn, compaction, or runtime restart the CLI can
// still be settling, so retry the event-driven refresh once.
const FORCED_REFRESH_RETRY_MS = 5_000

const POPOVER_WIDTH = 340
const POPOVER_GAP = 8
const VIEWPORT_MARGIN = 16
const POPOVER_MAX_HEIGHT = 420

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
  return context.categories
    .filter((category) => category.tokens > 0 && !category.isDeferred && !ignored.has(category.name.toLowerCase()))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4)
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

function shouldFetchContext(
  sessionId: string | undefined,
  draft: boolean,
  messageCount: number,
  chatState: ChatState,
) {
  return Boolean(sessionId) && !draft && (messageCount > 0 || chatState !== 'idle')
}

export function ContextUsageIndicator({
  sessionId,
  chatState,
  messageCount,
  runtimeSelectionKey = '',
  fallbackModelLabel,
  draft = false,
  compact = false,
  refreshNonce = 0,
}: Props) {
  const t = useTranslation()
  // `compact` also fires for the desktop composer, which narrows for the right
  // panel rather than for touch, so the phone touch target keys off the
  // viewport instead — see the trigger's height below.
  const isMobileBrowser = useMobileViewport() && !isDesktopRuntime()
  // Narrow composer (Workbench / small window) and real H5 share the sheet
  // presentation so the breakdown is never clipped by chat-column overflow.
  const preferSheet = compact || isMobileBrowser
  const contextEnabled = shouldFetchContext(sessionId, draft, messageCount, chatState)
  const [context, setContext] = useState<SessionContextSnapshot | null>(null)
  const [contextSource, setContextSource] = useState<'live' | 'estimate' | null>(null)
  const [loading, setLoading] = useState(contextEnabled)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [inspectionModel, setInspectionModel] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const requestSeq = useRef(0)
  const contextIdentityRef = useRef('')
  const contextDataSessionIdRef = useRef<string | undefined>(undefined)
  const inFlightRequestRef = useRef<Promise<boolean> | null>(null)
  const inFlightIdentityRef = useRef<string | null>(null)
  const lastAutoRefreshAtRef = useRef(0)
  const contextEnabledRef = useRef(contextEnabled)
  contextEnabledRef.current = contextEnabled

  const closeDetails = useCallback(() => {
    setDetailsOpen(false)
  }, [])

  const refresh = useCallback(async (mode: 'auto' | 'manual' | 'force' = 'manual'): Promise<boolean> => {
    if (!contextEnabledRef.current || !sessionId) {
      setLoading(false)
      return false
    }
    if (mode === 'auto' && !isDocumentVisible()) {
      setLoading(false)
      return false
    }
    if (mode === 'auto' && Date.now() - lastAutoRefreshAtRef.current < AUTO_REFRESH_MIN_INTERVAL_MS) {
      return inFlightRequestRef.current ?? false
    }
    if (typeof sessionsApi.getInspection !== 'function') {
      setLoading(false)
      return false
    }
    const activeSessionId = sessionId
    const activeContextIdentity = `${activeSessionId}:${runtimeSelectionKey}`
    // 'force' must not reuse an in-flight request: one started just before a
    // compact boundary would resolve with the pre-compact context.
    if (mode !== 'force' && inFlightRequestRef.current && inFlightIdentityRef.current === activeContextIdentity) {
      return inFlightRequestRef.current
    }
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    if (mode === 'auto') lastAutoRefreshAtRef.current = Date.now()
    setLoading(true)
    setError(null)
    const request = sessionsApi.getInspection(activeSessionId, {
      includeContext: true,
      contextOnly: true,
      timeout: CONTEXT_REQUEST_TIMEOUT_MS,
    })
      .then((inspection) => {
        if (seq !== requestSeq.current || activeContextIdentity !== contextIdentityRef.current) return false
        const nextContext = inspection.context ?? inspection.contextEstimate ?? null
        const nextSource = inspection.context ? 'live' : inspection.contextEstimate ? 'estimate' : null
        const usageModel = inspection.usage?.models.find((model) => firstNonEmpty(model.displayName, model.model)) ?? null
        setInspectionModel(firstNonEmpty(
          inspection.context?.model,
          inspection.contextEstimate?.model,
          inspection.status?.model,
          usageModel?.displayName,
          usageModel?.model,
        ) ?? null)
        if (nextContext) {
          contextDataSessionIdRef.current = activeSessionId
          setContext(nextContext)
          setContextSource(nextSource)
          setError(null)
          setUpdatedAt(Date.now())
        } else {
          setError(inspection.errors?.context ?? null)
        }
        return nextContext !== null
      })
      .catch((err) => {
        if (seq !== requestSeq.current || activeContextIdentity !== contextIdentityRef.current) return false
        setError(err instanceof Error ? err.message : String(err))
        return false
      })
      .finally(() => {
        if (inFlightRequestRef.current === request) {
          inFlightRequestRef.current = null
          inFlightIdentityRef.current = null
        }
        if (seq === requestSeq.current) setLoading(false)
      })
    inFlightRequestRef.current = request
    inFlightIdentityRef.current = activeContextIdentity
    return request
  }, [runtimeSelectionKey, sessionId])

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

  // Compaction and runtime replacement both change context outside the normal
  // message flow. Their completion signals bump this nonce so the meter reads
  // the authoritative process.
  const lastRefreshNonceRef = useRef(refreshNonce)
  useEffect(() => {
    if (refreshNonce === lastRefreshNonceRef.current) return
    lastRefreshNonceRef.current = refreshNonce
    return forceRefreshWithRetry()
  }, [forceRefreshWithRetry, refreshNonce])

  // A new session usually mounts while its first turn is already running.
  // The eager inspection then races the CLI, and message-count refreshes can
  // be swallowed by the auto-refresh throttle. The terminal idle transition
  // is the first reliable point to request that session's real context.
  const lastChatStateRef = useRef(chatState)
  useEffect(() => {
    const previousChatState = lastChatStateRef.current
    lastChatStateRef.current = chatState
    if (chatState !== 'idle' || previousChatState === 'idle') return
    return forceRefreshWithRetry()
  }, [chatState, forceRefreshWithRetry])

  useEffect(() => {
    const contextIdentity = `${sessionId}:${runtimeSelectionKey}`
    const identityChanged = contextIdentityRef.current !== contextIdentity
    contextIdentityRef.current = contextIdentity
    if (identityChanged) {
      requestSeq.current += 1
      lastAutoRefreshAtRef.current = 0
      setError(null)
      setInspectionModel(null)
      if (contextDataSessionIdRef.current !== sessionId) {
        contextDataSessionIdRef.current = undefined
        setContext(null)
        setContextSource(null)
        setUpdatedAt(null)
      }
    }
    void refresh('auto')
  }, [refresh, runtimeSelectionKey, sessionId])

  const lastContextEnabledRef = useRef(contextEnabled)
  useEffect(() => {
    const wasEnabled = lastContextEnabledRef.current
    lastContextEnabledRef.current = contextEnabled
    if (contextEnabled) {
      if (!wasEnabled) void refresh('auto')
      return
    }
    requestSeq.current += 1
    inFlightRequestRef.current = null
    inFlightIdentityRef.current = null
    lastAutoRefreshAtRef.current = 0
    contextDataSessionIdRef.current = undefined
    setContext(null)
    setContextSource(null)
    setInspectionModel(null)
    setUpdatedAt(null)
    setError(null)
    setLoading(false)
  }, [contextEnabled, refresh])

  const lastMessageCountRef = useRef(messageCount)
  useEffect(() => {
    if (lastMessageCountRef.current === messageCount) return
    lastMessageCountRef.current = messageCount
    void refresh('auto')
  }, [messageCount, refresh])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const refreshIfVisible = () => {
      if (!isDocumentVisible()) return
      void refresh('auto')
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

  // If the presentation mode flips (Workbench drag, H5 resize), drop any open
  // shell so we don't leave a desktop popover stranded on a sheet layout.
  useEffect(() => {
    setDetailsOpen(false)
  }, [preferSheet])

  const details = useMemo(() => {
    if (!context) return []
    return pickUsedContextCategory(context)
  }, [context])

  const displayContext = contextEnabled && contextDataSessionIdRef.current === sessionId ? context : null
  const hasPlaceholderContext = !displayContext && (
    draft || (!loading && messageCount === 0 && (!error || isCliNotRunningError(error)))
  )
  const isPendingContext = hasPlaceholderContext && !displayContext
  const percentage = displayContext ? Math.max(0, Math.min(100, displayContext.percentage)) : 0
  const usedTokens = displayContext?.totalTokens ?? 0
  const maxTokens = displayContext?.rawMaxTokens ?? 0
  const freeTokens = Math.max(0, maxTokens - usedTokens)
  const strokeColor = percentage >= 90
    ? 'var(--color-error)'
    : percentage >= 75
      ? 'var(--color-warning)'
      : 'var(--color-secondary)'
  const ringStyle = {
    background: displayContext
      ? `conic-gradient(${strokeColor} ${percentage * 3.6}deg, var(--color-surface-container-high) 0deg)`
      : 'var(--color-surface-container-high)',
  }
  const displayPercent = displayContext ? formatPercent(percentage) : '--'
  const displayInspectionModel = !context || contextDataSessionIdRef.current === sessionId
    ? inspectionModel
    : null
  const displayModel = firstNonEmpty(displayContext?.model, displayInspectionModel, fallbackModelLabel)
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
    used: t('contextIndicator.used'),
    free: t('contextIndicator.free'),
    window: t('contextIndicator.window'),
    estimate: t('contextIndicator.estimate'),
    pendingDetail: t('contextIndicator.pendingDetail'),
    loading: t('contextIndicator.loading'),
    unavailableDetail: t('contextIndicator.unavailableDetail'),
  }), [t])

  const detailsBody = (
    <ContextUsageDetails
      variant={preferSheet ? 'sheet' : 'popover'}
      modelLabel={modelLabel}
      percentageLabel={displayContext ? formatPercent(percentage) : '--'}
      usedTokens={usedTokens}
      freeTokens={freeTokens}
      maxTokens={maxTokens}
      categories={details}
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

  return (
    <div className="relative pointer-events-auto">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={detailsOpen}
        aria-haspopup="dialog"
        onClick={handleTriggerClick}
        title={t('contextIndicator.title')}
        data-testid="context-usage-indicator"
        className={`flex shrink-0 items-center gap-[7px] rounded-full border border-[var(--color-border)] bg-transparent text-[var(--color-text-secondary)] transition-[background-color,color,border-color] duration-150 ease-out hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-container-lowest)] ${
          isMobileBrowser ? 'h-11' : 'h-8'
        } ${compact ? 'px-2' : 'px-3'} ${detailsOpen ? 'border-[var(--color-outline)] bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : ''}`}
      >
        <span className="relative grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full">
          {loading && !displayContext ? (
            <span className="absolute inset-[2px] rounded-full border-2 border-[var(--color-text-tertiary)] border-t-transparent motion-safe:animate-spin" />
          ) : (
            <span
              className="relative grid h-[18px] w-[18px] place-items-center rounded-full"
              style={ringStyle}
            >
              <span className="absolute inset-[3px] rounded-full bg-[var(--color-surface-container-lowest)]" />
              <span
                className="relative h-[5px] w-[5px] rounded-full"
                style={{ backgroundColor: displayContext ? strokeColor : 'var(--color-text-tertiary)' }}
              />
            </span>
          )}
        </span>
        <span className="font-mono text-[11px] font-semibold tabular-nums">
          {displayPercent}
        </span>
      </button>

      {!preferSheet && detailsOpen && popoverPosition && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t('contextIndicator.title')}
          data-testid="context-usage-popover"
          className="fixed z-[var(--z-popover)] overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-[22px] py-5 text-left shadow-[var(--shadow-overlay)]"
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
            <div className="truncate text-base font-semibold text-[var(--color-text-primary)]">
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
}
