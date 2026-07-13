import { useCallback, useEffect, useMemo, useState } from 'react'
import { diagnosticsApi, type DiagnosticEvent, type DiagnosticsStatus } from '../api/diagnostics'
import { Button } from '../components/shared/Button'
import { copyTextToClipboard } from '../components/chat/clipboard'
import { useTranslation } from '../i18n'
import { formatBytes } from '../lib/formatBytes'
import { useUIStore } from '../stores/uiStore'
import { DoctorPanel } from '../components/doctor/DoctorPanel'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'

export function DiagnosticsSettings() {
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null)
  const [events, setEvents] = useState<DiagnosticEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isExporting, setIsExporting] = useState(false)
  const [isCopyingIssueReport, setIsCopyingIssueReport] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [lastExportPath, setLastExportPath] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const [nextStatus, eventResult] = await Promise.all([
        diagnosticsApi.getStatus(),
        diagnosticsApi.getEvents(100),
      ])
      setStatus(nextStatus)
      setEvents(eventResult.events)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.loadFailed'),
      })
    } finally {
      setIsLoading(false)
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

  return (
    <div className="max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">{t('settings.diagnostics.title')}</h2>
          <p className="text-sm text-[var(--color-text-tertiary)] mt-0.5">{t('settings.diagnostics.description')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={load} loading={isLoading}>
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">refresh</span>
          {t('settings.diagnostics.refresh')}
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <Metric label={t('settings.diagnostics.totalSize')} value={status ? formatBytes(status.totalBytes) : '-'} />
        <Metric label={t('settings.diagnostics.completeEvents')} value={status ? t('settings.diagnostics.completeEventsValue', { count: status.eventCount }) : '-'} />
        <Metric label={t('settings.diagnostics.visibleEvents')} value={t('settings.diagnostics.visibleEventsValue', { count: events.length })} />
        <Metric label={t('settings.diagnostics.recentErrors')} value={status ? String(status.recentErrorCount) : '-'} />
        <Metric label={t('settings.diagnostics.retention')} value={status ? t('settings.diagnostics.retentionValue', { days: String(status.retentionDays), size: formatBytes(status.maxBytes) }) : '-'} />
      </div>

      {status && status.corruptLineCount > 0 ? (
        <div role="alert" className="mb-5 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-warning)]">
          {t('settings.diagnostics.corruptLinesWarning', {
            count: status.corruptLineCount,
            physical: status.physicalLineCount,
          })}
        </div>
      ) : null}

      {status?.storageLimitExceeded ? (
        <div role="alert" className="mb-5 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-warning)]">
          {t('settings.diagnostics.storageLimitExceededWarning')}
        </div>
      ) : null}

      <div className="mb-5">
        <DoctorPanel />
      </div>

      <div className="border border-[var(--color-border)] rounded-lg mb-5">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.diagnostics.logDirectory')}</div>
            <div className="text-xs text-[var(--color-text-tertiary)] font-mono break-all mt-0.5">{status?.logDir ?? '-'}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={handleOpenDir}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">folder_open</span>
            {t('settings.diagnostics.openDirectory')}
          </Button>
        </div>
        <div className="px-4 py-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleExport} loading={isExporting}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">archive</span>
            {t('settings.diagnostics.exportBundle')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleCopySummary}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">content_copy</span>
            {t('settings.diagnostics.copySummary')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleCopyIssueReport} loading={isCopyingIssueReport}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">assignment</span>
            {t('settings.diagnostics.copyIssueReport')}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setClearConfirmOpen(true)} loading={isClearing}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">delete</span>
            {t('settings.diagnostics.clearLogs')}
          </Button>
          {lastExportPath && (
            <span className="w-full text-xs text-[var(--color-text-tertiary)] font-mono break-all">
              {lastExportPath}
            </span>
          )}
        </div>
      </div>

      <div className="mb-3">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.diagnostics.recentEvents')}</h3>
        <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">{t('settings.diagnostics.privacyNote')}</p>
      </div>

      <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
        {events.length === 0 ? (
          <div className="px-4 py-8 text-sm text-[var(--color-text-tertiary)] text-center">
            {isLoading ? t('common.loading') : t('settings.diagnostics.noEvents')}
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {events.map((event) => (
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
            ))}
          </div>
        )}
      </div>

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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg px-3 py-2">
      <div className="text-xs text-[var(--color-text-tertiary)]">{label}</div>
      <div className="text-sm font-semibold text-[var(--color-text-primary)] mt-1">{value}</div>
    </div>
  )
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
  const severityClass =
    event.severity === 'error'
      ? 'text-[var(--color-error)]'
      : event.severity === 'warn'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-text-tertiary)]'
  const detailsText = formatDetails(event.details)

  return (
    <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-[120px_92px_1fr] gap-3 items-start">
      <div className="text-xs text-[var(--color-text-tertiary)] font-mono">
        {new Date(event.timestamp).toLocaleString()}
      </div>
      <div className={`text-xs font-semibold uppercase ${severityClass}`}>{event.severity}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-[var(--color-text-primary)] truncate">{event.type}</span>
          {event.sessionId && (
            <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono truncate">{event.sessionId}</span>
          )}
        </div>
        <div className="text-xs text-[var(--color-text-secondary)] mt-1 break-words">{event.summary}</div>
        <button
          type="button"
          className="mt-1 inline-flex max-w-full items-center gap-1 text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          aria-label={`${copyEventIdLabel}: ${event.id}`}
          onClick={async () => {
            const copied = await copyTextToClipboard(event.id)
            addToast({ type: copied ? 'success' : 'error', message: copied ? eventIdCopiedLabel : eventIdCopyFailedLabel })
          }}
        >
          <span>{eventIdLabel}:</span>
          <span className="font-mono truncate">{event.id}</span>
          <span className="material-symbols-outlined text-[13px]" aria-hidden="true">content_copy</span>
        </button>
        {detailsText && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-[var(--color-text-tertiary)] select-none">
              {detailsLabel}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
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
