import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ExternalLink, RefreshCw, Trash2, Workflow } from 'lucide-react'
import { tracesApi } from '../api/traces'
import { useTranslation } from '../i18n'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { SearchField } from '@/components/ui/SearchField'
import { formatDurationMs, formatTokenCount } from '../lib/trace/formatters'
import { getDesktopHost } from '../lib/desktopHost'
import { buildTraceWindowUrl } from '../lib/traceLaunch'
import { openTraceCaptureSettings, openTraceDetail } from '../lib/traceNavigation'
import type { TraceSessionList, TraceSessionListItem } from '../types/trace'

type TraceListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: TraceSessionList }

const POLL_MS = 5_000
const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 250
const MAX_MODEL_CHIPS = 2


export function TraceList() {
  const t = useTranslation()
  const [state, setState] = useState<TraceListState>({ status: 'loading' })
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TraceSessionListItem | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const host = getDesktopHost()

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [queryInput])

  const load = useCallback(async (options?: {
    append?: boolean
    limit?: number
    offset?: number
    silent?: boolean
  }) => {
    const append = options?.append === true
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? PAGE_SIZE
    try {
      if (append) {
        setIsLoadingMore(true)
      } else if (!options?.silent) {
        setState({ status: 'loading' })
      }
      const data = await tracesApi.list({ limit, offset, query })
      setState((previous) => {
        if (!append || previous.status !== 'ready') {
          return { status: 'ready', data }
        }
        return {
          status: 'ready',
          data: {
            ...data,
            traces: [...previous.data.traces, ...data.traces],
          },
        }
      })
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : t('trace.list.loadFailed'),
      })
    } finally {
      if (append) setIsLoadingMore(false)
    }
  }, [query, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state.status !== 'ready' || !state.data.settings.enabled) return
    const timer = window.setInterval(() => {
      void load({
        limit: Math.max(PAGE_SIZE, state.data.traces.length),
        silent: true,
      })
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [load, state])

  const summary = useMemo(() => {
    if (state.status !== 'ready') return { apiCalls: 0, failedCalls: 0, models: 0 }
    const modelNames = new Set<string>()
    let apiCalls = 0
    let failedCalls = 0
    for (const item of state.data.traces) {
      apiCalls += item.summary.apiCalls
      failedCalls += item.summary.failedCalls
      for (const model of item.summary.models) modelNames.add(model.model)
    }
    return { apiCalls, failedCalls, models: modelNames.size }
  }, [state])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    const currentLimit = state.status === 'ready'
      ? Math.max(PAGE_SIZE, state.data.traces.length)
      : PAGE_SIZE
    setDeletingSessionId(deleteTarget.sessionId)
    try {
      await tracesApi.deleteSession(deleteTarget.sessionId)
      setDeleteTarget(null)
      await load({ limit: currentLimit, silent: true })
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : t('trace.list.deleteFailed'),
      })
    } finally {
      setDeletingSessionId(null)
    }
  }, [deleteTarget, load, state, t])

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
        <header className="shrink-0 border-b border-[var(--color-border)] px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                <Workflow className="h-3.5 w-3.5" strokeWidth={1.6} aria-hidden="true" />
                <span>{t('trace.list.eyebrow')}</span>
              </div>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                <h1
                  className="text-[24px] font-bold leading-tight tracking-tight text-[var(--color-text-primary)]"
                  style={{ fontFamily: 'var(--font-headline)' }}
                >
                  {t('trace.list.title')}
                </h1>
                {state.status === 'ready' && (
                  <Badge tone={state.data.settings.enabled ? 'success' : 'neutral'} size="sm" pill={false}>
                    {state.data.settings.enabled ? t('trace.list.collecting') : t('trace.list.paused')}
                  </Badge>
                )}
                {state.status === 'ready' && (
                  <span className="min-w-0 max-w-full truncate font-mono text-[12.5px] text-[var(--color-text-tertiary)]" title={state.data.storageDir}>
                    {state.data.storageDir}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="base" variant="secondary" onClick={openTraceCaptureSettings}>
                {t('trace.list.settings')}
              </Button>
              <Button size="base" variant="secondary" onClick={() => void load()}>
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                {t('trace.refresh')}
              </Button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
            <MetaChip label={t('trace.list.sessions')} value={state.status === 'ready' ? String(state.data.total) : '-'} />
            <MetaChip label={t('trace.apiCalls')} value={String(summary.apiCalls)} />
            <MetaChip label={t('trace.failedCalls')} value={String(summary.failedCalls)} tone={summary.failedCalls > 0 ? 'danger' : 'default'} />
            <MetaChip label={t('trace.models')} value={String(summary.models)} />
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[var(--color-border)] px-6 py-3.5">
            <SearchField
              value={queryInput}
              onChange={setQueryInput}
              label={t('trace.list.searchPlaceholder')}
              clearLabel={t('common.clearSearch')}
              placeholder={t('trace.list.searchPlaceholder')}
              containerClassName="max-w-xl"
            />
          </div>

          {state.status === 'loading' && <TraceListSkeleton label={t('common.loading')} />}
          {state.status === 'error' && (
            <ErrorState
              className="m-6"
              tone="strong"
              title={t('common.error')}
              detail={state.message}
              onRetry={() => void load()}
              retryLabel={t('common.retry')}
            />
          )}
          {state.status === 'ready' && (
            <TraceRows
              traces={state.data.traces}
              total={state.data.total}
              loadingMore={isLoadingMore}
              deletingSessionId={deletingSessionId}
              onLoadMore={() => void load({
                append: true,
                offset: state.data.traces.length,
                silent: true,
              })}
              onOpenWindow={(sessionId) => {
                // Matches TraceSession's own header button: outside the desktop
                // shell there is no native window to ask for, so fall back to a
                // browser tab rather than leaving the control dead.
                if (host.trace) {
                  void host.trace.openWindow(sessionId)
                  return
                }
                window.open(buildTraceWindowUrl(sessionId), '_blank', 'noopener,noreferrer')
              }}
              onDelete={setDeleteTarget}
            />
          )}
        </div>
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deletingSessionId) setDeleteTarget(null)
        }}
        onConfirm={() => void confirmDelete()}
        title={t('trace.list.deleteConfirmTitle')}
        body={deleteTarget
          ? t('trace.list.deleteConfirmBody', { title: getTraceTitle(deleteTarget, t) })
          : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        loading={deletingSessionId !== null}
      />
    </>
  )
}

function TraceRows({
  loadingMore,
  onLoadMore,
  traces,
  total,
  onOpenWindow,
  onDelete,
  deletingSessionId,
}: {
  loadingMore: boolean
  onLoadMore: () => void
  traces: TraceSessionListItem[]
  total: number
  onOpenWindow: (sessionId: string) => void
  onDelete: (trace: TraceSessionListItem) => void
  deletingSessionId: string | null
}) {
  const t = useTranslation()

  if (traces.length === 0) {
    return (
      <div className="flex flex-1 items-start justify-center px-6 py-10">
        <EmptyState
          className="w-full max-w-md"
          headingLevel={2}
          icon={<Workflow className="h-5 w-5" strokeWidth={2} />}
          title={t('trace.list.emptyTitle')}
          description={t('trace.list.emptyBody')}
        />
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="divide-y divide-[var(--color-border)]" role="list">
        {traces.map((trace) => (
          <TraceRow
            key={trace.sessionId}
            trace={trace}
            onOpenWindow={onOpenWindow}
            onDelete={onDelete}
            isDeleting={deletingSessionId === trace.sessionId}
          />
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-6 py-3 text-xs text-[var(--color-text-tertiary)]">
        <span>{t('trace.list.loadedCount', { shown: traces.length, total })}</span>
        {traces.length < total && (
          <Button size="sm" variant="secondary" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? t('common.loading') : t('trace.list.loadMore')}
          </Button>
        )}
      </div>
    </div>
  )
}

function TraceRow({
  trace,
  onOpenWindow,
  onDelete,
  isDeleting,
}: {
  trace: TraceSessionListItem
  onOpenWindow: (sessionId: string) => void
  onDelete: (trace: TraceSessionListItem) => void
  isDeleting: boolean
}) {
  const t = useTranslation()
  const title = getTraceTitle(trace, t)
  const updatedAt = trace.summary.updatedAt ?? trace.fileUpdatedAt
  // The tab is titled with the session alone; the tab bar's trace glyph says
  // what kind of tab it is, so a prefix here would only eat the visible width.
  const open = () => openTraceDetail(trace.sessionId, title)
  const failedCalls = trace.summary.failedCalls
  const visibleModels = trace.summary.models.slice(0, MAX_MODEL_CHIPS)
  const hiddenModels = trace.summary.models.length - visibleModels.length
  const totalTokens = trace.summary.totalInputTokens + trace.summary.totalOutputTokens

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    open()
  }

  return (
    <div
      role="listitem"
      aria-label={title}
      className="trace-list-row-cv group flex h-14 cursor-pointer items-center gap-5 px-6 transition-colors hover:bg-[var(--color-surface-hover)]"
    >
      <button
        type="button"
        onClick={open}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 items-center gap-5 self-stretch bg-transparent p-0 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="min-w-0 truncate text-[15px] font-semibold text-[var(--color-text-primary)]">{title}</span>
            {visibleModels.map((model) => (
              <span
                key={model.model}
                title={`${model.model} x${model.calls}`}
                className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-brand-soft)] px-2 py-0.5 font-mono text-[11px] font-medium leading-4 text-[var(--color-on-brand-soft)]"
              >
                {shortModelName(model.model)}
              </span>
            ))}
            {hiddenModels > 0 && (
              <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface-container-high)] px-2 py-0.5 font-mono text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
                +{hiddenModels}
              </span>
            )}
            {failedCalls > 0 && (
              <span title={t('trace.failedCalls')} className="flex shrink-0 items-center gap-1.5 text-[12px] font-semibold text-[var(--color-error)]">
                <span className="h-[7px] w-[7px] rounded-full bg-[var(--color-error)]" aria-hidden="true" />
                <span>{failedCalls}</span>
              </span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-[var(--color-text-tertiary)]">
            <span className="shrink-0">{trace.sessionId.slice(0, 8)}</span>
            {trace.session?.projectPath && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate" title={trace.session.projectPath}>{trace.session.projectPath}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{formatUpdatedAt(updatedAt)}</span>
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-[4.5rem_5rem_4.5rem] items-center gap-4">
          <MetricCell label={t('trace.apiCalls')} value={String(trace.summary.apiCalls)} />
          <MetricCell label={t('trace.modelTime')} value={formatDurationMs(trace.summary.totalDurationMs)} />
          <MetricCell label={t('trace.tokens')} value={formatTokenCount(totalTokens)} />
        </div>
      </button>
      {/* Opening the trace is what the row itself does — the row actions are
          only for the two things a click cannot express. */}
      <div className="flex w-[62px] shrink-0 items-center justify-end gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <IconButton
          size="sm"
          tone="secondary"
          label={t('trace.openWindow')}
          icon={<ExternalLink className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
          onClick={(event) => {
            event.stopPropagation()
            onOpenWindow(trace.sessionId)
          }}
        />
        <IconButton
          size="sm"
          tone="secondary"
          hoverTone="danger"
          label={t('trace.delete')}
          icon={<Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />}
          disabled={isDeleting}
          onClick={(event) => {
            event.stopPropagation()
            onDelete(trace)
          }}
        />
      </div>
    </div>
  )
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div className="font-mono text-[13px] font-semibold leading-5 text-[var(--color-text-primary)]">{value}</div>
      <div className="truncate text-[11px] leading-4 text-[var(--color-text-tertiary)]" title={label}>{label}</div>
    </div>
  )
}

function MetaChip({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'danger' }) {
  return (
    <div className="flex items-baseline gap-1.5 text-[13px]">
      <span className="text-[var(--color-text-secondary)]">{label}</span>
      <span className={`font-semibold tabular-nums ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>{value}</span>
    </div>
  )
}

function TraceListSkeleton({ label }: { label: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-label={label}>
      <div className="divide-y divide-[var(--color-border)]" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex h-14 items-center gap-4 px-6">
            <div className="min-w-0 flex-1">
              <div className="h-3 w-48 max-w-full animate-pulse rounded bg-[var(--color-surface-container-high)]" />
              <div className="mt-2 h-2.5 w-72 max-w-full animate-pulse rounded bg-[var(--color-surface-container-low)]" />
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <div className="h-3 w-10 animate-pulse rounded bg-[var(--color-surface-container-high)]" />
              <div className="h-3 w-12 animate-pulse rounded bg-[var(--color-surface-container-high)]" />
              <div className="h-3 w-12 animate-pulse rounded bg-[var(--color-surface-container-high)]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function getTraceTitle(trace: TraceSessionListItem, t: ReturnType<typeof useTranslation>): string {
  return trace.session?.title || t('session.untitled')
}

/** `claude-sonnet-4-5-20250929` -> `sonnet-4-5`; non-Claude ids pass through. */
function shortModelName(model: string): string {
  const short = model.replace(/^claude-/i, '').replace(/-\d{8}$/, '')
  return short || model
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}
