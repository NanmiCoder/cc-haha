import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  RadioTower,
  RefreshCw,
} from 'lucide-react'
import { sessionsApi } from '../api/sessions'
import { useSessionStore } from '../stores/sessionStore'
import { useTranslation } from '../i18n'
import type { MessageEntry } from '../types/session'
import type { TraceSession as TraceSessionData } from '../types/trace'
import { getDesktopHost } from '../lib/desktopHost'
import { buildTraceWindowUrl } from '../lib/traceLaunch'
import { formatClockTime, formatDurationMs, formatTokenCount } from '../lib/trace/formatters'
import { CopyButton } from '../components/shared/CopyButton'
import { TraceSplitLayout } from '../components/trace/TraceSplitLayout'
import { TraceTree } from '../components/trace/TraceTree'
import { TraceDetail } from '../components/trace/TraceDetail'
import { TraceSectionStateProvider } from '../components/trace/detail/Section'
import { LiveBadge, MetaChip, StatusPill, TypeIcon, spanDisplayTitle } from '../components/trace/TraceBadges'
import {
  buildTraceViewModel,
  type TraceSpan,
  type TraceViewModel,
} from '../lib/traceViewModel'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; trace: TraceSessionData; messages: MessageEntry[] }

type TraceTranslator = ReturnType<typeof useTranslation>

const TRACE_POLL_INTERVAL_MS = 1500

export function TraceSession({
  sessionId,
  standalone = false,
  pollIntervalMs = TRACE_POLL_INTERVAL_MS,
}: {
  sessionId: string
  standalone?: boolean
  pollIntervalMs?: number
}) {
  const t = useTranslation()
  const sessionTitle = useSessionStore((s) => s.sessions.find((session) => session.id === sessionId)?.title)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [clockNowMs, setClockNowMs] = useState(() => Date.now())
  const snapshotSignatureRef = useRef<string | null>(null)
  const lastSpanIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    snapshotSignatureRef.current = null

    const load = async (silent: boolean) => {
      if (!silent) setState({ status: 'loading' })
      if (silent) setRefreshing(true)
      try {
        const [trace, messageResponse] = await Promise.all([
          sessionsApi.getTrace(sessionId),
          sessionsApi.getMessages(sessionId).catch(() => ({ messages: [] })),
        ])
        if (!isTraceSessionData(trace)) {
          throw new Error(t('trace.snapshotEmpty'))
        }
        if (cancelled) return
        const signature = traceSnapshotSignature(trace, messageResponse.messages)
        if (silent && snapshotSignatureRef.current === signature) return
        snapshotSignatureRef.current = signature
        setState({ status: 'ready', trace, messages: messageResponse.messages })
        setClockNowMs(Date.now())
        setLastLoadedAt(new Date().toISOString())
      } catch (error) {
        if (cancelled) return
        if (!silent) {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      } finally {
        if (!cancelled) setRefreshing(false)
      }
    }

    setSelectedId(null)
    lastSpanIdRef.current = null
    void load(false)
    const interval = window.setInterval(() => {
      void load(true)
    }, pollIntervalMs)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [sessionId, refreshNonce, pollIntervalMs, t])

  const refresh = () => setRefreshNonce((value) => value + 1)

  const openWindow = () => {
    const host = getDesktopHost()
    if (host.trace) {
      void host.trace.openWindow(sessionId)
      return
    }
    window.open(buildTraceWindowUrl(sessionId), '_blank', 'noopener,noreferrer')
  }

  const readyState = state.status === 'ready' ? state : null
  const viewModel = useMemo(
    () => readyState
      ? buildTraceViewModel(readyState.trace, readyState.messages, { now: new Date(clockNowMs).toISOString() })
      : null,
    [readyState, clockNowMs],
  )

  useEffect(() => {
    if (!viewModel) return
    if (viewModel.diagnosis.pendingModelCalls === 0 && viewModel.diagnosis.pendingToolCalls === 0) return
    const timer = window.setInterval(() => setClockNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [viewModel?.diagnosis.pendingModelCalls, viewModel?.diagnosis.pendingToolCalls])

  useEffect(() => {
    if (!viewModel) return
    const lastSpanId = viewModel.orderedSpanIds.at(-1) ?? null
    setSelectedId((current) => {
      // Follow the live tail only when the user was already reading the tail.
      if (current && current === lastSpanIdRef.current && lastSpanId && current !== lastSpanId) {
        lastSpanIdRef.current = lastSpanId
        return lastSpanId
      }
      lastSpanIdRef.current = lastSpanId
      if (current && viewModel.spansById.has(current)) return current
      return viewModel.rootId
    })
  }, [viewModel])

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
        <TraceHeader
          sessionId={sessionId}
          title={sessionTitle ?? t('session.untitled')}
          standalone={standalone}
          onOpenWindow={openWindow}
          onRefresh={refresh}
          refreshing={refreshing}
          updatedAt={lastLoadedAt}
        />
        <TraceSkeleton />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
        <TraceHeader
          sessionId={sessionId}
          title={sessionTitle ?? t('session.untitled')}
          standalone={standalone}
          onOpenWindow={openWindow}
          onRefresh={refresh}
          refreshing={refreshing}
          updatedAt={lastLoadedAt}
        />
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md border-t border-[var(--color-error)]/30 pt-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-error)]">
              <AlertTriangle size={14} strokeWidth={2} />
              {t('trace.loadFailed')}
            </div>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{state.message}</p>
            <button
              type="button"
              onClick={refresh}
              className="mt-4 inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-primary)] transition-transform active:scale-[0.98]"
            >
              <RefreshCw size={14} strokeWidth={2} />
              {t('common.retry')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const { trace, messages } = state
  const resolvedTitle = sessionTitle ?? trace.session?.title ?? t('session.untitled')
  if (!viewModel) {
    return <TraceEmpty />
  }

  const hasTraceContent = trace.calls.length > 0 || (trace.events?.length ?? 0) > 0 || messages.length > 0
  const selectedSpan = selectedId ? viewModel.spansById.get(selectedId) : undefined
  const activeSpan = selectedSpan ?? viewModel.spansById.get(viewModel.rootId) ?? viewModel.spans[0] ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]">
      <TraceHeader
        sessionId={sessionId}
        title={resolvedTitle}
        trace={trace}
        viewModel={viewModel}
        standalone={standalone}
        onOpenWindow={openWindow}
        onRefresh={refresh}
        refreshing={refreshing}
        updatedAt={lastLoadedAt}
      />
      <DiagnosisBanner viewModel={viewModel} onSelect={setSelectedId} />
      {hasTraceContent && activeSpan ? (
        <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--color-border)]">
          <TraceSectionStateProvider scopeId={sessionId}>
            <TraceSplitLayout
              tree={
                <TraceTree
                  viewModel={viewModel}
                  selectedId={activeSpan.id}
                  onSelect={setSelectedId}
                />
              }
              detail={
                <TraceDetail
                  span={activeSpan}
                  viewModel={viewModel}
                  sessionId={sessionId}
                  onSelect={setSelectedId}
                />
              }
            />
          </TraceSectionStateProvider>
        </div>
      ) : (
        <TraceEmpty />
      )}
    </div>
  )
}

function TraceHeader({
  sessionId,
  title,
  trace,
  viewModel,
  standalone,
  onOpenWindow,
  onRefresh,
  refreshing = false,
  updatedAt,
}: {
  sessionId: string
  title: string
  trace?: TraceSessionData
  viewModel?: TraceViewModel | null
  standalone?: boolean
  onOpenWindow?: () => void
  onRefresh?: () => void
  refreshing?: boolean
  updatedAt?: string | null
}) {
  const t = useTranslation()
  const summary = trace?.summary
  const diagnosisStatus = viewModel?.diagnosis.status

  return (
    <header className="flex shrink-0 items-center justify-between gap-3 px-4 py-2.5" data-testid="trace-header">
      <div className="flex min-w-0 items-center gap-2.5">
        <RadioTower size={14} strokeWidth={2} className="shrink-0 text-[var(--color-text-tertiary)]" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight text-[var(--color-text-primary)]">
              {title}
            </h1>
            <LiveBadge />
            {diagnosisStatus ? <DiagnosisDot status={diagnosisStatus} /> : null}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[10px] text-[var(--color-text-tertiary)]">
            <span className="max-w-[280px] truncate">{sessionId}</span>
            {updatedAt ? <span className="shrink-0">{t('trace.updatedAt')} {formatClockTime(updatedAt)}</span> : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {summary ? (
          <div className="hidden items-center gap-3 md:flex">
            <MetaChip label={t('trace.apiCalls')} value={String(summary.apiCalls)} />
            {summary.failedCalls > 0 ? (
              <MetaChip label={t('trace.failedCalls')} value={String(summary.failedCalls)} tone="danger" />
            ) : null}
            <MetaChip label={t('trace.modelTime')} value={formatDurationMs(summary.totalDurationMs)} />
            <MetaChip
              label={t('trace.tokens')}
              value={formatTokenCount(summary.totalInputTokens + summary.totalOutputTokens)}
            />
            {summary.models.length > 0 ? (
              <MetaChip
                label={t('trace.models')}
                value={summary.models.map((model) => `${model.model} x${model.calls}`).join(', ')}
              />
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <CopyButton
            text={sessionId}
            label={t('trace.copySessionId')}
            copiedLabel={t('common.copied')}
            displayLabel={<Copy size={14} strokeWidth={2} />}
            displayCopiedLabel={<CheckCircle2 size={14} strokeWidth={2} />}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-focus)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
          />
          <IconAction label={t('trace.refresh')} onClick={onRefresh}>
            <RefreshCw size={14} strokeWidth={2} className={refreshing ? 'animate-spin' : ''} />
          </IconAction>
          {!standalone ? (
            <IconAction label={t('trace.openWindow')} onClick={onOpenWindow}>
              <ExternalLink size={14} strokeWidth={2} />
            </IconAction>
          ) : null}
        </div>
      </div>
    </header>
  )
}

function DiagnosisDot({ status }: { status: TraceViewModel['diagnosis']['status'] }) {
  const color = status === 'blocked'
    ? 'bg-[var(--color-error)]'
    : status === 'attention'
      ? 'bg-[var(--color-warning)]'
      : 'bg-[var(--color-success)]'
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} aria-hidden="true" />
}

function DiagnosisBanner({
  viewModel,
  onSelect,
}: {
  viewModel: TraceViewModel
  onSelect: (spanId: string) => void
}) {
  const t = useTranslation()
  const diagnosis = viewModel.diagnosis
  if (diagnosis.status !== 'attention' && diagnosis.status !== 'blocked') return null

  const focusSpan = diagnosis.focusSpanId ? viewModel.spansById.get(diagnosis.focusSpanId) : undefined
  const evidenceSpans = diagnosis.evidenceSpanIds
    .map((spanId) => viewModel.spansById.get(spanId))
    .filter((span): span is TraceSpan => !!span)
    .slice(0, 3)
  const toneClass = diagnosis.status === 'blocked'
    ? 'border-[var(--color-error)]/30 bg-[var(--color-error-container)]/30'
    : 'border-[var(--color-warning)]/30 bg-[var(--color-warning-container)]/25'

  return (
    <section className={`flex shrink-0 items-center gap-2 border-t px-4 py-1.5 ${toneClass}`} data-testid="trace-diagnosis">
      <StatusPill status={diagnosis.status === 'blocked' ? 'error' : 'pending'} />
      <span className="min-w-0 truncate text-xs font-semibold text-[var(--color-text-primary)]">
        {diagnosisReasonLabel(diagnosis.reason, t)}
      </span>
      {focusSpan ? (
        <button
          type="button"
          onClick={() => onSelect(focusSpan.id)}
          className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-focus)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
        >
          {t('trace.focus')}
        </button>
      ) : null}
      <div className="ml-auto flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">
        {evidenceSpans.map((span) => (
          <button
            key={span.id}
            type="button"
            onClick={() => onSelect(span.id)}
            className="inline-flex max-w-[200px] items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-focus)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
          >
            <TypeIcon span={span} size={13} />
            <span className="truncate">{spanDisplayTitle(span, t)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function diagnosisReasonLabel(reason: TraceViewModel['diagnosis']['reason'], t: TraceTranslator): string {
  switch (reason) {
    case 'model_error': return t('trace.diagnosis.modelError')
    case 'tool_error': return t('trace.diagnosis.toolError')
    case 'event_error': return t('trace.diagnosis.eventError')
    case 'pending_model': return t('trace.diagnosis.pendingModel')
    case 'pending_tool': return t('trace.diagnosis.pendingTool')
    case 'waiting_for_agent': return t('trace.diagnosis.waitingForAgent')
    case 'empty': return t('trace.diagnosis.empty')
    default: return t('trace.diagnosis.healthy')
  }
}

function IconAction({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-focus)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
    >
      {children}
    </button>
  )
}

function TraceSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--color-border)] lg:flex-row" data-testid="trace-skeleton">
      <div className="shrink-0 border-b border-[var(--color-border)] p-3 lg:w-[380px] lg:border-b-0 lg:border-r">
        <div className="h-7 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-container)]" />
        <div className="mt-3 space-y-1.5">
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="h-[34px] animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-surface-container)]" />
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 p-4">
        <div className="h-5 w-64 animate-pulse rounded bg-[var(--color-surface-container)]" />
        <div className="mt-2 h-3 w-96 animate-pulse rounded bg-[var(--color-surface-container)]" />
        <div className="mt-5 space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-container)]" />
          ))}
        </div>
      </div>
    </div>
  )
}

function TraceEmpty() {
  const t = useTranslation()
  return (
    <div className="flex flex-1 items-center justify-center border-t border-[var(--color-border)] p-8">
      <div className="max-w-sm rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-6 py-8 text-center">
        <RadioTower size={22} strokeWidth={2} className="mx-auto text-[var(--color-text-tertiary)]" />
        <h2 className="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">{t('trace.emptyTitle')}</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">{t('trace.emptyBody')}</p>
      </div>
    </div>
  )
}

function traceSnapshotSignature(trace: TraceSessionData, messages: MessageEntry[]): string {
  return JSON.stringify({
    summary: trace.summary,
    calls: trace.calls.map((call) => ({
      id: call.id,
      status: call.status,
      completedAt: call.completedAt,
      durationMs: call.durationMs,
      usage: call.usage,
      responseStatus: call.response?.status,
      requestSha256: call.request.body.sha256,
      responseSha256: call.response?.body.sha256,
      error: call.error ? { name: call.error.name, message: call.error.message, code: call.error.code } : null,
    })),
    events: (trace.events ?? []).map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      phase: event.phase,
      severity: event.severity,
      callId: event.callId,
      message: event.message,
    })),
    messages: messages.map((message) => ({
      id: message.id,
      type: message.type,
      timestamp: message.timestamp,
      content: message.content,
    })),
  })
}

function isTraceSessionData(value: unknown): value is TraceSessionData {
  return !!value &&
    typeof value === 'object' &&
    'sessionId' in value &&
    'summary' in value &&
    Array.isArray((value as { calls?: unknown }).calls)
}
