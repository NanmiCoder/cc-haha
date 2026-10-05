import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ChevronRight,
  CircleCheck,
  ClipboardList,
  Copy,
  Database,
  FolderOpen,
  HeartPulse,
  Info,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import {
  diagnosticsApi,
  type DiagnosticEvent,
  type DiagnosticSeverity,
  type DiagnosticsStatus,
  type LocalIndexState,
  type LocalIndexStatus,
} from '../api/diagnostics'
import { Badge, StatusDot, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useTranslation } from '../i18n'
import { formatBytes } from '../lib/formatBytes'
import { useUIStore } from '../stores/uiStore'
import { DoctorPanel } from '../components/doctor/DoctorPanel'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export function DiagnosticsSettings() {
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null)
  const [localIndexStatus, setLocalIndexStatus] = useState<LocalIndexStatus | null>(null)
  const [localIndexUnavailable, setLocalIndexUnavailable] = useState(false)
  const [events, setEvents] = useState<DiagnosticEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isExporting, setIsExporting] = useState(false)
  const [isCopyingIssueReport, setIsCopyingIssueReport] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [isRebuildingIndex, setIsRebuildingIndex] = useState(false)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false)
  const [rebuildSucceeded, setRebuildSucceeded] = useState(false)
  const [lastExportPath, setLastExportPath] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const loadRequestIdRef = useRef(0)
  const localIndexReadIdRef = useRef(0)
  const localIndexMutationIdRef = useRef(0)
  const localIndexMutationGenerationRef = useRef(0)
  const activeLoadCountRef = useRef(0)
  const rebuildInFlightRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadRequestIdRef.current += 1
      localIndexReadIdRef.current += 1
      localIndexMutationIdRef.current += 1
      localIndexMutationGenerationRef.current += 1
    }
  }, [])

  const load = useCallback(async () => {
    const loadRequestId = ++loadRequestIdRef.current
    const localIndexReadId = ++localIndexReadIdRef.current
    const mutationGeneration = localIndexMutationGenerationRef.current
    activeLoadCountRef.current += 1
    if (mountedRef.current) {
      setIsLoading(true)
      setRebuildSucceeded(false)
    }

    try {
      const [diagnosticsResult, localIndexResult] = await Promise.allSettled([
        Promise.all([diagnosticsApi.getStatus(), diagnosticsApi.getEvents(100)]),
        diagnosticsApi.getLocalIndexStatus(),
      ])

      if (!mountedRef.current) return

      if (loadRequestId === loadRequestIdRef.current) {
        if (diagnosticsResult.status === 'fulfilled') {
          const [nextStatus, eventResult] = diagnosticsResult.value
          setStatus(nextStatus)
          setEvents(eventResult.events)
        } else {
          const error = diagnosticsResult.reason
          addToast({
            type: 'error',
            message: error instanceof Error ? error.message : t('settings.diagnostics.loadFailed'),
          })
        }
      }

      // A mutation owns local-index state until it settles. Reads that began
      // before or during that mutation cannot overwrite the mutation result.
      const canCommitLocalIndexRead = localIndexReadId === localIndexReadIdRef.current
        && mutationGeneration === localIndexMutationGenerationRef.current
        && !rebuildInFlightRef.current
      if (canCommitLocalIndexRead) {
        if (localIndexResult.status === 'fulfilled') {
          setLocalIndexStatus(localIndexResult.value)
          setLocalIndexUnavailable(false)
        } else {
          // Older servers may not expose the additive local-index endpoint yet.
          // Keep all legacy diagnostics usable and show one quiet inline state.
          setLocalIndexStatus(null)
          setLocalIndexUnavailable(true)
        }
      }
    } finally {
      activeLoadCountRef.current = Math.max(0, activeLoadCountRef.current - 1)
      if (mountedRef.current) setIsLoading(activeLoadCountRef.current > 0)
    }
  }, [addToast, t])

  useEffect(() => {
    void load()
  }, [load])

  const recentErrorSummary = useMemo(() => {
    return events
      .filter((event) => event.severity === 'error' || event.severity === 'warn')
      .slice(0, 20)
      .map(formatEventForCopy)
      .join('\n')
  }, [events])

  const handleOpenDir = async () => {
    try {
      await diagnosticsApi.openLogDir()
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.openFailed'),
      })
    }
  }

  const handleExport = async () => {
    setIsExporting(true)
    try {
      const { bundle } = await diagnosticsApi.exportBundle()
      setLastExportPath(bundle.path)
      addToast({
        type: 'success',
        message: t('settings.diagnostics.exported', { file: bundle.fileName }),
      })
      await load()
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.exportFailed'),
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleCopySummary = async () => {
    const text = recentErrorSummary || t('settings.diagnostics.noRecentErrors')
    const copied = await copyTextToClipboard(text)
    if (copied) {
      addToast({ type: 'success', message: t('settings.diagnostics.summaryCopied') })
      return
    }
    addToast({ type: 'error', message: t('settings.diagnostics.copyFailed') })
  }

  const handleCopyIssueReport = async () => {
    setIsCopyingIssueReport(true)
    try {
      const { report } = await diagnosticsApi.getIssueReport()
      const copied = await copyTextToClipboard(report)
      addToast({
        type: copied ? 'success' : 'error',
        message: copied
          ? t('settings.diagnostics.issueReportCopied')
          : t('settings.diagnostics.issueReportCopyFailed'),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.issueReportCopyFailed'),
      })
    } finally {
      setIsCopyingIssueReport(false)
    }
  }

  const handleClear = async () => {
    setIsClearing(true)
    try {
      await diagnosticsApi.clear()
      setEvents([])
      setStatus(await diagnosticsApi.getStatus())
      setLastExportPath(null)
      setClearConfirmOpen(false)
      addToast({ type: 'success', message: t('settings.diagnostics.cleared') })
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.clearFailed'),
      })
    } finally {
      setIsClearing(false)
    }
  }

  const handleRebuildIndex = async () => {
    if (rebuildInFlightRef.current) return
    rebuildInFlightRef.current = true
    const mutationId = ++localIndexMutationIdRef.current
    localIndexMutationGenerationRef.current += 1
    setIsRebuildingIndex(true)
    setRebuildSucceeded(false)
    try {
      const nextStatus = await diagnosticsApi.rebuildLocalIndex()
      if (!mountedRef.current || mutationId !== localIndexMutationIdRef.current) return
      setLocalIndexStatus(nextStatus)
      setLocalIndexUnavailable(false)
      setRebuildSucceeded(true)
      setRebuildConfirmOpen(false)
      addToast({ type: 'success', message: t('settings.diagnostics.localIndex.rebuildSucceeded') })
    } catch (error) {
      if (!mountedRef.current || mutationId !== localIndexMutationIdRef.current) return
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.localIndex.rebuildFailed'),
      })
    } finally {
      rebuildInFlightRef.current = false
      if (mutationId === localIndexMutationIdRef.current) {
        localIndexMutationGenerationRef.current += 1
      }
      if (mountedRef.current) setIsRebuildingIndex(false)
    }
  }

  return (
    <div className="min-w-0">
      <SettingsPageHeader
        title={t('settings.diagnostics.title')}
        description={t('settings.diagnostics.description')}
        action={(
          <Button
            variant="secondary"
            size="base"
            onClick={load}
            loading={isLoading}
            disabled={isRebuildingIndex}
            icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('settings.diagnostics.refresh')}
          </Button>
        )}
      />

      {/* One stat card rather than five `SettingsStat` tiles: three of these
          values are phrases ("600 complete events", "7 days / 50 MB") that do
          not fit a 22px KPI number in a fifth of the pane. */}
      <SettingsGroup className="mt-6">
        <SettingsBlock>
          <dl className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-x-4 gap-y-3 py-0.5">
            <Metric label={t('settings.diagnostics.totalSize')} value={status ? formatBytes(status.totalBytes) : '-'} />
            <Metric label={t('settings.diagnostics.completeEvents')} value={status ? t('settings.diagnostics.completeEventsValue', { count: status.eventCount }) : '-'} />
            <Metric label={t('settings.diagnostics.visibleEvents')} value={t('settings.diagnostics.visibleEventsValue', { count: events.length })} />
            <Metric label={t('settings.diagnostics.recentErrors')} value={status ? String(status.recentErrorCount) : '-'} />
            <Metric label={t('settings.diagnostics.retention')} value={status ? t('settings.diagnostics.retentionValue', { days: String(status.retentionDays), size: formatBytes(status.maxBytes) }) : '-'} />
          </dl>
        </SettingsBlock>
      </SettingsGroup>

      {status && status.corruptLineCount > 0 ? (
        <WarningBanner>
          {t('settings.diagnostics.corruptLinesWarning', {
            count: status.corruptLineCount,
            physical: status.physicalLineCount,
          })}
        </WarningBanner>
      ) : null}

      {status?.storageLimitExceeded ? (
        <WarningBanner>{t('settings.diagnostics.storageLimitExceededWarning')}</WarningBanner>
      ) : null}

      <LocalIndexPanel
        status={localIndexStatus}
        unavailable={localIndexUnavailable}
        rebuilding={isRebuildingIndex}
        rebuildSucceeded={rebuildSucceeded}
        onRebuild={() => setRebuildConfirmOpen(true)}
      />

      <div className="mt-7">
        <DoctorPanel />
      </div>

      <SettingsGroup className="mt-7">
        <SettingsRow
          title={t('settings.diagnostics.logDirectory')}
          description={<span className="break-all font-mono text-[11px]">{status?.logDir ?? '-'}</span>}
          layout="inline"
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={handleOpenDir}
            icon={<FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />}
          >
            {t('settings.diagnostics.openDirectory')}
          </Button>
        </SettingsRow>
        <SettingsBlock>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={handleExport}
              loading={isExporting}
              icon={<Archive size={14} strokeWidth={1.75} aria-hidden="true" />}
            >
              {t('settings.diagnostics.exportBundle')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCopySummary}
              icon={<Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
            >
              {t('settings.diagnostics.copySummary')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCopyIssueReport}
              loading={isCopyingIssueReport}
              icon={<ClipboardList size={14} strokeWidth={1.75} aria-hidden="true" />}
            >
              {t('settings.diagnostics.copyIssueReport')}
            </Button>
            <Button
              variant="danger-ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setClearConfirmOpen(true)}
              loading={isClearing}
              icon={<Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />}
            >
              {t('settings.diagnostics.clearLogs')}
            </Button>
          </div>
          {lastExportPath && (
            <div className="mt-2 break-all font-mono text-[11px] text-[var(--color-text-tertiary)]">
              {lastExportPath}
            </div>
          )}
        </SettingsBlock>
      </SettingsGroup>

      <SettingsSection
        title={t('settings.diagnostics.recentEvents')}
        description={t('settings.diagnostics.privacyNote')}
      >
        <SettingsGroup>
          {events.length === 0 ? (
            <EmptyState
              variant="plain"
              size="sm"
              icon={<HeartPulse size={18} strokeWidth={1.75} />}
              description={isLoading ? t('common.loading') : t('settings.diagnostics.noEvents')}
            />
          ) : (
            events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                detailsLabel={t('settings.diagnostics.eventDetails')}
                eventIdLabel={t('settings.diagnostics.eventId')}
                copyEventIdLabel={t('settings.diagnostics.copyEventId')}
                eventIdCopiedLabel={t('settings.diagnostics.eventIdCopied')}
                eventIdCopyFailedLabel={t('settings.diagnostics.eventIdCopyFailed')}
                addToast={addToast}
              />
            ))
          )}
        </SettingsGroup>
      </SettingsSection>

      <ConfirmDialog
        open={rebuildConfirmOpen}
        onClose={() => {
          if (!isRebuildingIndex) setRebuildConfirmOpen(false)
        }}
        onConfirm={handleRebuildIndex}
        title={t('settings.diagnostics.localIndex.rebuild')}
        body={t('settings.diagnostics.localIndex.confirmRebuild')}
        confirmLabel={t('settings.diagnostics.localIndex.rebuild')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={isRebuildingIndex}
      />

      <ConfirmDialog
        open={clearConfirmOpen}
        onClose={() => {
          if (!isClearing) setClearConfirmOpen(false)
        }}
        onConfirm={handleClear}
        title={t('settings.diagnostics.clearLogs')}
        body={t('settings.diagnostics.confirmClear')}
        confirmLabel={t('settings.diagnostics.clearLogs')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isClearing}
      />
    </div>
  )
}

function WarningBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-[1.5] text-[var(--color-on-warning-container)]"
    >
      <TriangleAlert size={14} strokeWidth={1.75} className="mt-px shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

const LOCAL_INDEX_STATE_TONE: Record<LocalIndexState, Tone> = {
  off: 'neutral',
  building: 'info',
  ready: 'success',
  degraded: 'warning',
}

function LocalIndexPanel({
  status,
  unavailable,
  rebuilding,
  rebuildSucceeded,
  onRebuild,
}: {
  status: LocalIndexStatus | null
  unavailable: boolean
  rebuilding: boolean
  rebuildSucceeded: boolean
  onRebuild: () => void
}) {
  const t = useTranslation()
  const titleId = 'local-index-diagnostics-title'
  const stateMessage = status?.state === 'building'
    ? t('settings.diagnostics.localIndex.buildingMessage')
    : status?.state === 'degraded'
      ? t('settings.diagnostics.localIndex.degradedMessage')
      : null

  return (
    <section role="region" aria-labelledby={titleId} className="mt-7">
      <div className="mb-2 flex items-end justify-between gap-3 px-0.5">
        <div className="min-w-0">
          <h3 id={titleId} className="text-[13px] font-semibold leading-5 text-[var(--color-text-secondary)]">
            {t('settings.diagnostics.localIndex.title')}
          </h3>
          <p className="mt-0.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
            {t('settings.diagnostics.localIndex.description')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRebuild}
          loading={rebuilding}
          disabled={unavailable}
          icon={<Database size={14} strokeWidth={1.75} aria-hidden="true" />}
        >
          {t('settings.diagnostics.localIndex.rebuild')}
        </Button>
      </div>

      <SettingsGroup>
        {status ? (
          <SettingsBlock>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-x-4 gap-y-3 py-0.5">
              <IndexMetric
                label={t('settings.diagnostics.localIndex.state')}
                value={(
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={LOCAL_INDEX_STATE_TONE[status.state]} size="md" />
                    <span>{localIndexStateLabel(status.state, t)}</span>
                  </span>
                )}
              />
              <IndexMetric
                label={t('settings.diagnostics.localIndex.indexed')}
                value={`${status.indexed} / ${status.discovered}`}
              />
              <IndexMetric label={t('settings.diagnostics.localIndex.degradedSources')} value={String(status.degradedSources)} />
              <IndexMetric label={t('settings.diagnostics.localIndex.databaseSize')} value={formatBytes(status.databaseBytes)} />
              <IndexMetric label={t('settings.diagnostics.localIndex.walSize')} value={formatBytes(status.walBytes)} />
              <IndexMetric
                label={t('settings.diagnostics.localIndex.lastUpdated')}
                value={status.lastUpdatedAt ? new Date(status.lastUpdatedAt).toLocaleString() : t('settings.diagnostics.localIndex.never')}
              />
              <IndexMetric
                label={t('settings.diagnostics.localIndex.errorCode')}
                value={status.lastErrorCode ?? t('settings.diagnostics.localIndex.none')}
                mono={Boolean(status.lastErrorCode)}
              />
            </div>
          </SettingsBlock>
        ) : (
          <SettingsBlock className="text-xs text-[var(--color-text-tertiary)]">
            {unavailable ? t('settings.diagnostics.localIndex.unavailable') : t('common.loading')}
          </SettingsBlock>
        )}

        {stateMessage ? (
          <div role="status" className="flex items-start gap-2 px-4 py-2.5 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
            <Info size={14} strokeWidth={1.75} className="mt-px shrink-0" aria-hidden="true" />
            <span className="min-w-0">{stateMessage}</span>
          </div>
        ) : null}
        {rebuildSucceeded ? (
          <div role="status" className="flex items-start gap-2 px-4 py-2.5 text-xs leading-[1.5] text-[var(--color-success)]">
            <CircleCheck size={14} strokeWidth={1.75} className="mt-px shrink-0" aria-hidden="true" />
            <span className="min-w-0">{t('settings.diagnostics.localIndex.rebuildSucceeded')}</span>
          </div>
        ) : null}
      </SettingsGroup>
    </section>
  )
}

function IndexMetric({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-[var(--color-text-tertiary)]">{label}</div>
      <div
        className={`mt-0.5 break-words font-medium tabular-nums text-[var(--color-text-primary)] ${
          mono ? 'font-mono text-xs' : 'text-[13px]'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

type Translation = ReturnType<typeof useTranslation>

function localIndexStateLabel(state: LocalIndexState, t: Translation): string {
  return t(`settings.diagnostics.localIndex.state.${state}`)
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-semibold leading-snug tabular-nums text-[var(--color-text-primary)]">{value}</dd>
    </div>
  )
}

const SEVERITY_TONE: Record<DiagnosticSeverity, Tone> = {
  error: 'danger',
  warn: 'warning',
  info: 'neutral',
  debug: 'neutral',
}

function EventRow({
  event,
  detailsLabel,
  eventIdLabel,
  copyEventIdLabel,
  eventIdCopiedLabel,
  eventIdCopyFailedLabel,
  addToast,
}: {
  event: DiagnosticEvent
  detailsLabel: string
  eventIdLabel: string
  copyEventIdLabel: string
  eventIdCopiedLabel: string
  eventIdCopyFailedLabel: string
  addToast: ReturnType<typeof useUIStore.getState>['addToast']
}) {
  const tone = SEVERITY_TONE[event.severity] ?? 'neutral'
  const detailsText = formatDetails(event.details)

  return (
    <div data-testid="diagnostic-event" className="flex items-start gap-3 px-4 py-3">
      <StatusDot tone={tone} size="md" className="mt-[7px]" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">{event.type}</span>
          <Badge tone={tone} size="xs">{event.severity}</Badge>
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
            {new Date(event.timestamp).toLocaleString()}
          </span>
        </div>
        {event.sessionId && (
          <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-text-tertiary)]">{event.sessionId}</div>
        )}
        <div className="mt-1 break-words text-xs leading-[1.5] text-[var(--color-text-secondary)]">{event.summary}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            variant="ghost"
            size="xs"
            className="-ml-1.5 max-w-full"
            aria-label={`${copyEventIdLabel}: ${event.id}`}
            onClick={async () => {
              const copied = await copyTextToClipboard(event.id)
              addToast({ type: copied ? 'success' : 'error', message: copied ? eventIdCopiedLabel : eventIdCopyFailedLabel })
            }}
            icon={<Copy size={12} strokeWidth={2} aria-hidden="true" />}
            iconPosition="end"
          >
            <span>{eventIdLabel}:</span>
            <span className="truncate font-mono">{event.id}</span>
          </Button>
        </div>
        {detailsText && (
          <details className="group mt-1">
            <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] [&::-webkit-details-marker]:hidden">
              <ChevronRight size={12} strokeWidth={2} className="transition-transform group-open:rotate-90" aria-hidden="true" />
              {detailsLabel}
            </summary>
            <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--color-surface-container)] p-3 font-mono text-[11px] leading-[1.6] text-[var(--color-text-secondary)]">
              {detailsText}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}

function formatDetails(details: unknown): string {
  if (details === null || details === undefined) return ''
  if (typeof details === 'string') return details
  try {
    return JSON.stringify(details, null, 2)
  } catch {
    return String(details)
  }
}

function formatEventForCopy(event: DiagnosticEvent): string {
  const header = `[${event.timestamp}] ${event.severity.toUpperCase()} ${event.type}${event.sessionId ? ` session=${event.sessionId}` : ''}`
  const details = formatDetails(event.details)
  if (!details) return `${header}: ${event.summary}`
  return `${header}: ${event.summary}\nDetails:\n${details}`
}
