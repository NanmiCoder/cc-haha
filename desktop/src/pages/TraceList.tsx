import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { ExternalLink, RefreshCw, Search, Workflow } from 'lucide-react'
import { tracesApi } from '../api/traces'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import { useTranslation } from '../i18n'
import { Button } from '../components/shared/Button'
import { Skeleton } from '../components/shared/Skeleton'
import { getDesktopHost } from '../lib/desktopHost'
import type { TraceSessionList, TraceSessionListItem } from '../types/trace'

type TraceListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: TraceSessionList }

const POLL_MS = 5_000
const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 250
const MAX_MODEL_CHIPS = 2

/** Skip off-screen row rendering without virtualization (WebKit-friendly). */
const ROW_CV_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 56px',
} as const

export function TraceList() {
  const t = useTranslation()
  const [state, setState] = useState<TraceListState>({ status: 'loading' })
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [isLoadingMore, setIsLoadingMore] = useState(false)
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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
      <header className="shrink-0 border-b border-[var(--color-border)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
              <Workflow className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              <span>{t('trace.list.eyebrow')}</span>
            </div>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="text-lg font-semibold tracking-tight text-[var(--color-text-primary)]">{t('trace.list.title')}</h1>
              {state.status === 'ready' && (
                <span className={`rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  state.data.settings.enabled
                    ? 'border-[var(--color-success)]/25 bg-[var(--color-success)]/10 text-[var(--color-success)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-[var(--color-text-tertiary)]'
                }`}>
                  {state.data.settings.enabled ? t('trace.list.collecting') : t('trace.list.paused')}
                </span>
              )}
              {state.status === 'ready' && (
                <span className="min-w-0 max-w-full truncate font-mono text-[11px] text-[var(--color-text-tertiary)]" title={state.data.storageDir}>
                  {state.data.storageDir}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => openTraceSettings(t)}>
              {t('trace.list.settings')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              {t('trace.refresh')}
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
          <MetaChip label={t('trace.list.sessions')} value={state.status === 'ready' ? String(state.data.total) : '-'} />
          <MetaChip label={t('trace.apiCalls')} value={String(summary.apiCalls)} />
          <MetaChip label={t('trace.failedCalls')} value={String(summary.failedCalls)} tone={summary.failedCalls > 0 ? 'danger' : 'default'} />
          <MetaChip label={t('trace.models')} value={String(summary.models)} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-[var(--color-border)] px-5 py-3">
          <div className="flex h-9 max-w-xl items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 focus-within:border-[var(--color-border-focus)]">
            <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" strokeWidth={2} aria-hidden="true" />
            <input
              value={queryInput}
              onChange={(event) => setQueryInput(event.currentTarget.value)}
              placeholder={t('trace.list.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent px-2 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
            />
          </div>
        </div>

        {state.status === 'loading' && <TraceListSkeleton label={t('common.loading')} />}
        {state.status === 'error' && (
          <div className="m-5 rounded-[var(--radius-md)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 p-4 text-sm text-[var(--color-error)]">
            {state.message}
          </div>
        )}
        {state.status === 'ready' && (
          <TraceRows
            traces={state.data.traces}
            total={state.data.total}
            loadingMore={isLoadingMore}
            onLoadMore={() => void load({
              append: true,
              offset: state.data.traces.length,
              silent: true,
            })}
            onOpenWindow={(sessionId) => {
              if (host.trace) void host.trace.openWindow(sessionId)
            }}
          />
        )}
      </div>
    </div>
  )
}

function TraceRows({
  loadingMore,
  onLoadMore,
  traces,
  total,
  onOpenWindow,
}: {
  loadingMore: boolean
  onLoadMore: () => void
  traces: TraceSessionListItem[]
  total: number
  onOpenWindow: (sessionId: string) => void
}) {
  const t = useTranslation()

  if (traces.length === 0) {
    return (
      <div className="flex flex-1 items-start justify-center px-6 py-10">
        <div className="w-full max-w-md rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-6 py-12 text-center">
          <Workflow className="mx-auto h-8 w-8 text-[var(--color-text-tertiary)]" strokeWidth={2} aria-hidden="true" />
          <h2 className="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">{t('trace.list.emptyTitle')}</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">{t('trace.list.emptyBody')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="divide-y divide-[var(--color-border)]">
        {traces.map((trace) => (
          <TraceRow key={trace.sessionId} trace={trace} onOpenWindow={onOpenWindow} />
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-text-tertiary)]">
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
}: {
  trace: TraceSessionListItem
  onOpenWindow: (sessionId: string) => void
}) {
  const t = useTranslation()
  const title = trace.session?.title || t('session.untitled')
  const updatedAt = trace.summary.updatedAt ?? trace.fileUpdatedAt
  const failedCalls = trace.summary.failedCalls
  const visibleModels = trace.summary.models.slice(0, MAX_MODEL_CHIPS)
  const hiddenModels = trace.summary.models.length - visibleModels.length
  const totalTokens = trace.summary.totalInputTokens + trace.summary.totalOutputTokens

  const open = () => openTrace(trace.sessionId, title, t)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    open()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKeyDown}
      className="group flex h-14 cursor-pointer items-center gap-4 px-5 transition-colors hover:bg-[var(--color-surface-hover)]"
      style={ROW_CV_STYLE}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-[var(--color-text-primary)]">{title}</span>
          {visibleModels.map((model) => (
            <span
              key={model.model}
              title={`${model.model} x${model.calls}`}
              className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-brand)]/10 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-[var(--color-brand)]"
            >
              {shortModelName(model.model)}
            </span>
          ))}
          {hiddenModels > 0 && (
            <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface-container-high)] px-1.5 py-0.5 font-mono text-[10px] leading-4 text-[var(--color-text-tertiary)]">
              +{hiddenModels}
            </span>
          )}
          {failedCalls > 0 && (
            <span title={t('trace.failedCalls')} className="flex shrink-0 items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-error)]" aria-hidden="true" />
              <span className="font-mono text-[10px] text-[var(--color-error)]">{failedCalls}</span>
            </span>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
          <span className="shrink-0 font-mono">{trace.sessionId.slice(0, 8)}</span>
          {trace.session?.projectPath && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate" title={trace.session.projectPath}>{trace.session.projectPath}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="shrink-0 font-mono">{formatUpdatedAt(updatedAt)}</span>
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-[3.5rem_4rem_4rem] items-center gap-3">
        <MetricCell label={t('trace.apiCalls')} value={String(trace.summary.apiCalls)} />
        <MetricCell label={t('trace.duration')} value={formatDuration(trace.summary.totalDurationMs)} />
        <MetricCell label={t('trace.tokens')} value={formatCompact(totalTokens)} />
      </div>
      <div className="flex w-[60px] shrink-0 items-center justify-end gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <RowAction
          label={t('trace.open')}
          onClick={(event) => {
            event.stopPropagation()
            open()
          }}
        >
          <Workflow className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </RowAction>
        <RowAction
          label={t('trace.openWindow')}
          onClick={(event) => {
            event.stopPropagation()
            onOpenWindow(trace.sessionId)
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </RowAction>
      </div>
    </div>
  )
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
    >
      {children}
    </button>
  )
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div className="font-mono text-[11px] leading-4 text-[var(--color-text-primary)]">{value}</div>
      <div className="truncate text-[10px] uppercase leading-4 tracking-wide text-[var(--color-text-tertiary)]" title={label}>{label}</div>
    </div>
  )
}

function MetaChip({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'danger' }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">{label}</span>
      <span className={`font-mono text-[13px] ${tone === 'danger' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>{value}</span>
    </div>
  )
}

function TraceListSkeleton({ label }: { label: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-label={label}>
      <div className="divide-y divide-[var(--color-border)]" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex h-14 items-center gap-4 px-5">
            <div className="min-w-0 flex-1">
              <Skeleton variant="text" width="48%" height={12} />
              <Skeleton variant="text" width="72%" height={10} className="mt-2" />
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <Skeleton variant="text" width={40} height={12} />
              <Skeleton variant="text" width={48} height={12} />
              <Skeleton variant="text" width={48} height={12} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function openTrace(sessionId: string, title: string, t: ReturnType<typeof useTranslation>) {
  useTabStore.getState().openTraceTab(sessionId, `${t('trace.title')}: ${title}`)
}

function openTraceSettings(t: ReturnType<typeof useTranslation>) {
  useUIStore.getState().setPendingSettingsTab('general')
  useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
}

/** `claude-sonnet-4-5-20250929` -> `sonnet-4-5`; non-Claude ids pass through. */
function shortModelName(model: string): string {
  const short = model.replace(/^claude-/i, '').replace(/-\d{8}$/, '')
  return short || model
}

/** Compact count: 847 -> "847", 1234 -> "1.2k", 2345678 -> "2.3m". */
function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(value)
  const scaled = value < 1_000_000 ? value / 1000 : value / 1_000_000
  const unit = value < 1_000_000 ? 'k' : 'm'
  const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '')
  return `${text}${unit}`
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}
