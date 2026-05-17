import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sessionsApi, type SessionContextSnapshot } from '../../api/sessions'
import { useTranslation } from '../../i18n'
import type { ChatState } from '../../types/chat'
import { MobileBottomSheet } from '../shared/MobileBottomSheet'

type Props = {
  sessionId?: string
  chatState: ChatState
  messageCount: number
  runtimeSelectionKey?: string
  fallbackModelLabel?: string
  draft?: boolean
  compact?: boolean
}

const ACTIVE_REFRESH_MS = 30_000
const CONTEXT_REQUEST_TIMEOUT_MS = 20_000
const AUTO_REFRESH_MIN_INTERVAL_MS = 10_000

function formatNumber(value: number | undefined) {
  return new Intl.NumberFormat().format(value ?? 0)
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

function shouldFetchContext(sessionId: string | undefined, draft: boolean) {
  return Boolean(sessionId) && !draft
}

export function ContextUsageIndicator({
  sessionId,
  chatState,
  messageCount,
  runtimeSelectionKey = '',
  fallbackModelLabel,
  draft = false,
  compact = false,
}: Props) {
  const t = useTranslation()
  const [context, setContext] = useState<SessionContextSnapshot | null>(null)
  const [contextSource, setContextSource] = useState<'live' | 'estimate' | null>(null)
  const [loading, setLoading] = useState(() => shouldFetchContext(sessionId, draft))
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [inspectionModel, setInspectionModel] = useState<string | null>(null)
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false)
  const requestSeq = useRef(0)
  const contextIdentityRef = useRef('')
  const inFlightRequestRef = useRef<Promise<void> | null>(null)
  const inFlightIdentityRef = useRef<string | null>(null)
  const lastAutoRefreshAtRef = useRef(0)

  const refresh = useCallback(async (mode: 'auto' | 'manual' = 'manual') => {
    if (!sessionId || draft) {
      setLoading(false)
      return
    }
    if (mode === 'auto' && !isDocumentVisible()) {
      setLoading(false)
      return
    }
    if (mode === 'auto' && Date.now() - lastAutoRefreshAtRef.current < AUTO_REFRESH_MIN_INTERVAL_MS) {
      return inFlightRequestRef.current ?? undefined
    }
    if (typeof sessionsApi.getInspection !== 'function') {
      setLoading(false)
      return
    }
    const activeSessionId = sessionId
    const activeContextIdentity = `${activeSessionId}:${runtimeSelectionKey}`
    if (inFlightRequestRef.current && inFlightIdentityRef.current === activeContextIdentity) {
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
        if (seq !== requestSeq.current || activeContextIdentity !== contextIdentityRef.current) return
        const nextContext = inspection.context ?? inspection.contextEstimate ?? null
        const nextSource = inspection.context ? 'live' : inspection.contextEstimate ? 'estimate' : null
        const usageModel = inspection.usage?.models.find((model) => firstNonEmpty(model.displayName, model.model)) ?? null
        setContext(nextContext)
        setContextSource(nextSource)
        setInspectionModel(firstNonEmpty(
          inspection.context?.model,
          inspection.contextEstimate?.model,
          inspection.status?.model,
          usageModel?.displayName,
          usageModel?.model,
        ) ?? null)
        setError(nextContext ? null : inspection.errors?.context ?? null)
        setUpdatedAt(Date.now())
      })
      .catch((err) => {
        if (seq !== requestSeq.current || activeContextIdentity !== contextIdentityRef.current) return
        setError(err instanceof Error ? err.message : String(err))
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
  }, [draft, runtimeSelectionKey, sessionId])

  useEffect(() => {
    const contextIdentity = `${sessionId}:${runtimeSelectionKey}`
    const identityChanged = contextIdentityRef.current !== contextIdentity
    contextIdentityRef.current = contextIdentity
    if (identityChanged) {
      requestSeq.current += 1
      lastAutoRefreshAtRef.current = 0
      setContext(null)
      setContextSource(null)
      setError(null)
      setUpdatedAt(null)
      setInspectionModel(null)
    }
    void refresh('auto')
  }, [messageCount, refresh, runtimeSelectionKey, sessionId])

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
  const displayModel = firstNonEmpty(context?.model, inspectionModel, fallbackModelLabel)
  const ariaLabel = displayContext
    ? t('contextIndicator.ariaLabel', { percent: formatPercent(percentage) })
    : isPendingContext
      ? t('contextIndicator.pendingAria')
    : loading
      ? t('contextIndicator.loadingAria')
      : t('contextIndicator.unavailableAria')

  return (
    <div className="group/context relative pointer-events-auto">
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => {
          if (compact) {
            setMobileDetailsOpen(true)
          }
          void refresh('manual')
        }}
        title={t('contextIndicator.title')}
        data-testid="context-usage-indicator"
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-container-lowest)] ${
          compact ? 'px-2' : 'px-2.5'
        }`}
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

      <div className={`pointer-events-none absolute bottom-full right-0 z-40 mb-2 w-[320px] max-w-[calc(100vw-2rem)] translate-y-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-4 text-left opacity-0 shadow-[var(--shadow-dropdown)] transition-all duration-150 group-hover/context:translate-y-0 group-hover/context:opacity-100 group-focus-within/context:translate-y-0 group-focus-within/context:opacity-100 ${
        compact ? 'hidden' : ''
      }`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
              {t('contextIndicator.title')}
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-[var(--color-text-primary)]">
              {displayModel ?? t('contextIndicator.modelUnknown')}
            </div>
          </div>
          <div className="shrink-0 font-mono text-xl font-semibold text-[var(--color-text-primary)]">
            {displayContext ? formatPercent(percentage) : '--'}
          </div>
        </div>

        {displayContext ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3 font-mono text-xs">
              <div>
                <div className="text-[var(--color-text-tertiary)]">{t('contextIndicator.used')}</div>
                <div className="mt-1 text-[var(--color-text-primary)]">{formatNumber(usedTokens)}</div>
              </div>
              <div>
                <div className="text-[var(--color-text-tertiary)]">{t('contextIndicator.free')}</div>
                <div className="mt-1 text-[var(--color-text-primary)]">{formatNumber(freeTokens)}</div>
              </div>
              <div className="col-span-2">
                <div className="text-[var(--color-text-tertiary)]">{t('contextIndicator.window')}</div>
                <div className="mt-1 text-[var(--color-text-primary)]">{maxTokens > 0 ? formatNumber(maxTokens) : '--'}</div>
              </div>
            </div>
            {details.length > 0 && (
              <div className="mt-4 space-y-2">
                {details.map((category) => {
                  const percent = maxTokens > 0 ? Math.max(0.5, Math.min(100, (category.tokens / maxTokens) * 100)) : 0
                  return (
                    <div key={category.name}>
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate text-[var(--color-text-secondary)]">{category.name}</span>
                        <span className="shrink-0 font-mono text-[var(--color-text-tertiary)]">{formatNumber(category.tokens)}</span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-surface-container)]">
                        <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: category.color }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="mt-4 text-[11px] text-[var(--color-text-tertiary)]">
              {formatUpdatedAt(updatedAt, t)}
              {contextSource === 'estimate' && (
                <span className="ml-2 inline-flex rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]">
                  {t('contextIndicator.estimate')}
                </span>
              )}
            </div>
          </>
        ) : isPendingContext ? (
          <div className="mt-4 text-sm leading-6 text-[var(--color-text-secondary)]">
            {t('contextIndicator.pendingDetail')}
          </div>
        ) : (
          <div className="mt-4 text-sm leading-6 text-[var(--color-text-secondary)]">
            {loading ? t('contextIndicator.loading') : t('contextIndicator.unavailableDetail')}
          </div>
        )}
      </div>

      {compact && (
        <MobileBottomSheet
          open={mobileDetailsOpen}
          onClose={() => setMobileDetailsOpen(false)}
          title={t('contextIndicator.title')}
          closeLabel={t('tabs.close')}
          ariaLabel={t('contextIndicator.title')}
          headerExtra={(
            <div className="truncate text-base font-semibold text-[var(--color-text-primary)]">
              {displayModel ?? t('contextIndicator.modelUnknown')}
            </div>
          )}
          contentClassName="p-4"
        >
          <div className="flex items-end justify-between gap-4">
            <div className="font-mono text-4xl font-semibold text-[var(--color-text-primary)]">
              {displayContext ? formatPercent(percentage) : '--'}
            </div>
            {contextSource === 'estimate' && (
              <span className="mb-1 rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                {t('contextIndicator.estimate')}
              </span>
            )}
          </div>

          {displayContext ? (
            <div className="mt-5">
              <div className="grid grid-cols-3 gap-2 font-mono text-xs">
                <div className="rounded-xl bg-[var(--color-surface-container)] p-3">
                  <div className="text-[var(--color-text-tertiary)]">{t('contextIndicator.used')}</div>
                  <div className="mt-1 text-[var(--color-text-primary)]">{formatNumber(usedTokens)}</div>
                </div>
                <div className="rounded-xl bg-[var(--color-surface-container)] p-3">
                  <div className="text-[var(--color-text-tertiary)]">{t('contextIndicator.free')}</div>
                  <div className="mt-1 text-[var(--color-text-primary)]">{formatNumber(freeTokens)}</div>
                </div>
                <div className="rounded-xl bg-[var(--color-surface-container)] p-3">
                  <div className="text-[var(--color-text-tertiary)]">{t('contextIndicator.window')}</div>
                  <div className="mt-1 text-[var(--color-text-primary)]">{maxTokens > 0 ? formatNumber(maxTokens) : '--'}</div>
                </div>
              </div>
              {details.length > 0 && (
                <div className="mt-5 space-y-3">
                  {details.map((category) => {
                    const percent = maxTokens > 0 ? Math.max(0.5, Math.min(100, (category.tokens / maxTokens) * 100)) : 0
                    return (
                      <div key={category.name}>
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <span className="min-w-0 truncate text-[var(--color-text-secondary)]">{category.name}</span>
                          <span className="shrink-0 font-mono text-[var(--color-text-tertiary)]">{formatNumber(category.tokens)}</span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-container)]">
                          <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: category.color }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="mt-4 text-[11px] text-[var(--color-text-tertiary)]">
                {formatUpdatedAt(updatedAt, t)}
              </div>
            </div>
          ) : (
            <div className="mt-5 rounded-xl bg-[var(--color-surface-container)] p-4 text-sm leading-6 text-[var(--color-text-secondary)]">
              {isPendingContext
                ? t('contextIndicator.pendingDetail')
                : loading
                  ? t('contextIndicator.loading')
                  : t('contextIndicator.unavailableDetail')}
            </div>
          )}
        </MobileBottomSheet>
      )}
    </div>
  )
}
