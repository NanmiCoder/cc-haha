import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  ExternalLink,
  RadioTower,
  RefreshCw,
} from 'lucide-react'
import { sessionsApi } from '../api/sessions'
import { tracesApi } from '../api/traces'
import { useSessionStore } from '../stores/sessionStore'
import { useTranslation } from '../i18n'
import type { MessageEntry } from '../types/session'
import type { TraceSession as TraceSessionData } from '../types/trace'
import { getDesktopHost } from '../lib/desktopHost'
import { buildTraceWindowUrl } from '../lib/traceLaunch'
import { formatClockTime, formatDurationMs, formatTokenCount } from '../lib/trace/formatters'
import { Button } from '@/components/ui/Button'
import { StatusDot } from '@/components/ui/Badge'
import { CopyButton } from '@/components/ui/CopyButton'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
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
  onBack,
  pollIntervalMs = TRACE_POLL_INTERVAL_MS,
}: {
  sessionId: string
  standalone?: boolean
  /**
   * Return to the trace list. Omitted in the standalone window, which has no
   * list to go back to.
   */
  onBack?: () => void
  pollIntervalMs?: number
}) {
  const t = useTranslation()
  const sessionTitle = useSessionStore((s) => s.sessions.find((session) => session.id === sessionId)?.title)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [tracePage, setTracePage] = useState<{ offset?: number; revisionToken?: string; scanCursor?: string }>({})
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [clockNowMs, setClockNowMs] = useState(() => Date.now())
  const snapshotSignatureRef = useRef<string | null>(null)
  const lastSpanIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    let loadedMessages: MessageEntry[] | undefined
    let loadedMessageSignature: string | null | undefined
    let loadInFlight = false
    let revisionPollingAvailable = true
    let currentRevision: number | undefined
    let currentRevisionToken: string | undefined
    let revisionRequestGeneration = 0
    snapshotSignatureRef.current = null

    const load = async (silent: boolean) => {
      if (silent && loadInFlight) return
      loadInFlight = true
      if (!silent) setState({ status: 'loading' })
      try {
        let pendingRevision: number | undefined
        let pendingRevisionKey: string | undefined
        if (silent && revisionPollingAvailable) {
          try {
            const requestGeneration = ++revisionRequestGeneration
            const revision = await tracesApi.getRevision(
              sessionId,
              currentRevision,
              currentRevisionToken,
              { signal: controller.signal },
            )
            if (cancelled || requestGeneration !== revisionRequestGeneration) return
            if (!revision.changed) {
              currentRevision = revision.revision
              currentRevisionToken = revision.revisionToken
              return
            }
            pendingRevision = revision.revision
            pendingRevisionKey = traceRevisionKey(revision)
          } catch {
            // Older sidecars keep the previous full-snapshot polling behavior.
            revisionPollingAvailable = false
          }
        }

        if (silent) setRefreshing(true)
        const trace = await sessionsApi.getTrace(sessionId, { signal: controller.signal }, tracePage)
        if (!isTraceSessionData(trace)) {
          throw new Error(t('trace.snapshotEmpty'))
        }
        if (cancelled) return
        if (!silent && revisionPollingAvailable) {
          const requestGeneration = ++revisionRequestGeneration
          void tracesApi.getRevision(sessionId, undefined, undefined, { signal: controller.signal }).then((revision) => {
            if (cancelled || requestGeneration !== revisionRequestGeneration) return
            currentRevision = revision.revision
            currentRevisionToken = revision.revisionToken
          }).catch(() => {
            if (cancelled || requestGeneration !== revisionRequestGeneration) return
            revisionPollingAvailable = false
          })
        } else if (pendingRevision !== undefined) {
          currentRevision = pendingRevision
          currentRevisionToken = pendingRevisionKey?.startsWith('token:')
            ? pendingRevisionKey.slice('token:'.length)
            : undefined
        }
        const signature = traceSnapshotSignature(trace)
        if (silent && snapshotSignatureRef.current === signature) return
        // Trace calls/events often advance without any transcript mutation.
        // Reuse the transcript until its independent revision changes.
        if (!loadedMessages || trace.messageSignature == null || trace.messageSignature !== loadedMessageSignature) {
          const messageResponse = await sessionsApi.getHistoryPage(sessionId, {}, { signal: controller.signal })
            .catch(() => null)
          if (cancelled) return
          if (messageResponse) {
            // A tail page cannot assign historical calls to their original turns.
            // Keep those calls under session activity instead of inventing an association.
            loadedMessages = messageResponse.page?.historyComplete === false ? [] : messageResponse.messages
            loadedMessageSignature = trace.messageSignature
          }
        }
        if (cancelled) return
        snapshotSignatureRef.current = loadedMessages ? signature : null
        setState({ status: 'ready', trace, messages: loadedMessages ?? [] })
        setClockNowMs(Date.now())
        setLastLoadedAt(new Date().toISOString())
      } catch (error) {
        if (cancelled) return
        if (!silent) {
          setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      } finally {
        loadInFlight = false
        if (!cancelled) setRefreshing(false)
      }
    }

    setSelectedId(null)
    lastSpanIdRef.current = null
    void load(false)
    const interval = window.setInterval(() => {
      // Keep a historical page stable. Returning to the first page resumes live polling.
      if (!tracePage.offset && !tracePage.scanCursor) void load(true)
    }, pollIntervalMs)

    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(interval)
    }
  }, [sessionId, refreshNonce, pollIntervalMs, t, tracePage])

  const refresh = () => {
    setTracePage({})
    setRefreshNonce((value) => value + 1)
  }

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
          onBack={onBack}
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
          onBack={onBack}
          onOpenWindow={openWindow}
          onRefresh={refresh}
          refreshing={refreshing}
          updatedAt={lastLoadedAt}
        />
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-[var(--radius-xl)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-6 py-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-on-error-container)]">
              <AlertTriangle size={14} strokeWidth={2} />
              {t('trace.loadFailed')}
            </div>
            <p className="mt-2 text-sm text-[var(--color-on-error-container)]">{state.message}</p>
            <Button
              variant="secondary"
              size="base"
              className="mt-4"
              onClick={refresh}
              icon={<RefreshCw size={14} strokeWidth={2} />}
            >
              {t('common.retry')}
            </Button>
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
  // An open record follows its own content, not the session revision. A sibling
  // span arriving must not clear and refetch the record the reader is looking at.
  const detailRevisionKey = spanContentKey(activeSpan)
  // The overview reads the opening call, so it must use that call's content key.
  // A different key misses the detail cache and refetches the same body.
  const overviewRevisionKey = spanContentKey(
    viewModel.spans.find((span) => span.kind === 'llm') ?? null,
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]">
      <TraceHeader
        sessionId={sessionId}
        title={resolvedTitle}
        trace={trace}
        viewModel={viewModel}
        standalone={standalone}
        onBack={onBack}
        onOpenWindow={openWindow}
        onRefresh={refresh}
        refreshing={refreshing}
        updatedAt={lastLoadedAt}
      />
      {trace.window && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 text-xs" role="status">
          <span>{t('trace.windowNotice')}</span>
          <span>{trace.window.offset + 1}–{trace.window.offset + Math.max(trace.calls.length, trace.events?.length ?? 0)} / {Math.max(trace.window.totalCalls, trace.window.totalEvents)}</span>
          {(trace.window.state === 'limited' || trace.window.oversizedRecords > 0) && <span>{t('trace.windowLimited')}</span>}
          <Button size="sm" variant="ghost" disabled={!tracePage.offset && !tracePage.scanCursor} onClick={() => setTracePage({})}>{t('trace.windowFirst')}</Button>
          <Button size="sm" variant="ghost" disabled={!tracePage.offset} onClick={() => setTracePage({ ...tracePage, offset: Math.max(0, (tracePage.offset ?? 0) - trace.window!.limit) })}>{t('trace.windowPrevious')}</Button>
          <Button size="sm" variant="ghost" disabled={!trace.window.hasMore} onClick={() => setTracePage({ ...tracePage, offset: trace.window!.offset + trace.window!.limit, revisionToken: trace.window!.revisionToken })}>{t('trace.windowNext')}</Button>
          {trace.window.nextScanCursor && <Button size="sm" variant="ghost" onClick={() => setTracePage({ scanCursor: trace.window!.nextScanCursor })}>{t('trace.windowScanNext')}</Button>}
        </div>
      )}
      <DiagnosisBanner viewModel={viewModel} onSelect={setSelectedId} />
      {hasTraceContent && activeSpan ? (
        <div className="flex min-h-0 flex-1 flex-col">
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
                  revisionKey={detailRevisionKey}
                  overviewRevisionKey={overviewRevisionKey}
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

function spanContentKey(span: TraceSpan | null): string | undefined {
  if (!span) return undefined
  const call = span.call
  if (call) {
    return [
      call.id,
      call.status ?? span.status,
      call.completedAt ?? '',
      call.durationMs ?? '',
      call.request.body.sha256,
      call.response?.body.sha256 ?? '',
      call.error?.name ?? '',
      call.error?.message ?? '',
    ].join(':')
  }
  return [
    span.id,
    span.status,
    span.completedAt ?? '',
    span.durationMs ?? '',
  ].join(':')
}

function traceRevisionKey(revision: {
  revision: number
  revisionToken?: string
}): string {
  return revision.revisionToken
    ? `token:${revision.revisionToken}`
    : `legacy:${revision.revision}`
}

function TraceHeader({
  sessionId,
  title,
  trace,
  viewModel,
  standalone,
  onBack,
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
  onBack?: () => void
  onOpenWindow?: () => void
  onRefresh?: () => void
  refreshing?: boolean
  updatedAt?: string | null
}) {
  const t = useTranslation()
  const summary = trace?.summary
  const diagnosisStatus = viewModel?.diagnosis.status

  return (
    <header
      className="flex shrink-0 items-center justify-between gap-3.5 border-b border-[var(--color-border)] px-6 py-4"
      data-testid="trace-header"
    >
      <div className="flex min-w-0 items-center gap-3.5">
        {/*
          A trace tab is a drill-down, so it owes the reader a way back up. The
          hairline separates this navigation affordance from the identity block
          beside it, the way a breadcrumb separates from a page title.
        */}
        {onBack ? (
          <div className="flex shrink-0 items-center gap-3.5">
            <Button
              variant="ghost"
              size="base"
              onClick={onBack}
              icon={<ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />}
              data-testid="trace-back"
            >
              {t('trace.backToList')}
            </Button>
            <span className="h-6 w-px bg-[var(--color-border)]" aria-hidden="true" />
          </div>
        ) : null}
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)]">
          <RadioTower size={17} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1
              className="min-w-0 truncate text-[17px] font-bold tracking-tight text-[var(--color-text-primary)]"
              style={{ fontFamily: 'var(--font-headline)' }}
              title={title}
            >
              {title}
            </h1>
            <LiveBadge />
            {diagnosisStatus ? <DiagnosisDot status={diagnosisStatus} /> : null}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[12.5px] text-[var(--color-text-tertiary)]">
            <span className="max-w-[280px] truncate">{sessionId}</span>
            {updatedAt ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">{t('trace.updatedAt')} {formatClockTime(updatedAt)}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3.5">
        {summary ? (
          <div className="hidden items-center gap-3.5 md:flex">
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
            displayLabel={<Copy size={16} strokeWidth={2} />}
            displayCopiedLabel={<CheckCircle2 size={16} strokeWidth={2} />}
            // Mirrors IconButton size="md" tone="secondary" bordered, so this
            // sits flush with the two IconButtons beside it. CopyButton owns its
            // own copied/reset state, so it cannot be swapped for IconButton.
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors duration-150 hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          />
          <IconButton
            size="md"
            tone="secondary"
            bordered
            label={t('trace.refresh')}
            onClick={onRefresh}
            icon={<RefreshCw size={16} strokeWidth={2} className={refreshing ? 'animate-spin' : ''} />}
          />
          {!standalone ? (
            <IconButton
              size="md"
              tone="secondary"
              bordered
              label={t('trace.openWindow')}
              onClick={onOpenWindow}
              icon={<ExternalLink size={16} strokeWidth={2} />}
            />
          ) : null}
        </div>
      </div>
    </header>
  )
}

function DiagnosisDot({ status }: { status: TraceViewModel['diagnosis']['status'] }) {
  const tone = status === 'blocked' ? 'danger' : status === 'attention' ? 'warning' : 'success'
  return <StatusDot tone={tone} size="md" pulse />
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
  // Warning-bar recipe from the redesign spec: `-container` fill, matching
  // `on-*-container` ink, same-tone hairline. No alpha modifiers — Safari 15
  // drops the color function they compile to.
  const toneClass = diagnosis.status === 'blocked'
    ? 'border-[var(--color-error)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
    : 'border-[var(--color-warning)] bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'

  return (
    <section className={`flex shrink-0 items-center gap-2.5 border-b px-6 py-2 ${toneClass}`} data-testid="trace-diagnosis">
      <StatusPill status={diagnosis.status === 'blocked' ? 'error' : 'pending'} />
      <span className="min-w-0 truncate text-[12.5px] font-semibold">
        {diagnosisReasonLabel(diagnosis.reason, t)}
      </span>
      {focusSpan ? (
        <Button
          variant="secondary"
          size="xs"
          className="shrink-0"
          onClick={() => onSelect(focusSpan.id)}
        >
          {t('trace.focus')}
        </Button>
      ) : null}
      <div className="ml-auto flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">
        {evidenceSpans.map((span) => (
          <Button
            key={span.id}
            variant="secondary"
            size="xs"
            className="max-w-[200px]"
            onClick={() => onSelect(span.id)}
            icon={<TypeIcon span={span} size={13} />}
          >
            <span className="truncate">{spanDisplayTitle(span, t)}</span>
          </Button>
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

function TraceSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row" data-testid="trace-skeleton">
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4 lg:w-[400px] lg:border-b-0 lg:border-r">
        <div className="h-8 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-container)]" />
        <div className="mt-3 space-y-1.5">
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="h-[34px] animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-surface-container)]" />
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 p-6">
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
    <div className="flex flex-1 items-center justify-center p-8">
      <EmptyState
        className="max-w-sm"
        headingLevel={2}
        icon={<RadioTower size={20} strokeWidth={2} />}
        title={t('trace.emptyTitle')}
        description={t('trace.emptyBody')}
      />
    </div>
  )
}

function traceSnapshotSignature(trace: TraceSessionData): string {
  return JSON.stringify({
    summary: trace.summary,
    messageSignature: trace.messageSignature ?? null,
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
  })
}

function isTraceSessionData(value: unknown): value is TraceSessionData {
  return !!value &&
    typeof value === 'object' &&
    'sessionId' in value &&
    'summary' in value &&
    Array.isArray((value as { calls?: unknown }).calls)
}
