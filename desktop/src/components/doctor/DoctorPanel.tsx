import { RotateCcw, Stethoscope } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DoctorReport, DoctorReportItem } from '../../api/doctor'
import { useTranslation } from '../../i18n'
import {
  runDoctorCheck,
  runLocalDoctorRepair,
  type LocalDoctorRepairResult,
} from '../../lib/doctorRepair'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { Button } from '../shared/Button'
import { ConfirmDialog } from '../shared/ConfirmDialog'

type DoctorPanelProps = {
  compact?: boolean
}

export function DoctorPanel({ compact = false }: DoctorPanelProps) {
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  )
  const cwd = activeSession?.workDirExists === false
    ? undefined
    : activeSession?.workDir ?? activeSession?.projectRoot ?? undefined
  const requestSequence = useRef(0)
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const [runningRequestId, setRunningRequestId] = useState<number | null>(null)
  const [resettingRequestId, setResettingRequestId] = useState<number | null>(null)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [reportResult, setReportResult] = useState<{ cwd?: string; report: DoctorReport } | null>(null)
  const [resetResult, setResetResult] = useState<LocalDoctorRepairResult | null>(null)
  const report = reportResult && reportResult.cwd === cwd ? reportResult.report : null

  useEffect(() => {
    requestSequence.current += 1
    setRunningRequestId(null)
    setResettingRequestId(null)
    setReportResult(null)
  }, [cwd])

  const beginReportRequest = () => {
    const requestId = ++requestSequence.current
    const requestCwd = cwd
    return {
      requestId,
      requestCwd,
      response: runDoctorCheck({ cwd: requestCwd }),
    }
  }

  const isCurrentRequest = (requestId: number, requestCwd?: string) => {
    return requestSequence.current === requestId && cwdRef.current === requestCwd
  }

  const handleRunDoctor = async () => {
    const request = beginReportRequest()
    setResettingRequestId(null)
    setRunningRequestId(request.requestId)
    try {
      const nextReport = await request.response
      if (!isCurrentRequest(request.requestId, request.requestCwd)) return
      setReportResult({ cwd: request.requestCwd, report: nextReport })
      addToast({ type: 'success', message: t('settings.diagnostics.doctorCheckCompleted') })
    } catch (error) {
      if (!isCurrentRequest(request.requestId, request.requestCwd)) return
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.doctorFailed'),
      })
    } finally {
      setRunningRequestId((current) => current === request.requestId ? null : current)
    }
  }

  const handleResetSafeState = async () => {
    let requestId: number | null = null
    const requestCwd = cwd
    try {
      const result = runLocalDoctorRepair()
      setResetResult(result)
      setResetConfirmOpen(false)
      addToast({
        type: result.failedKeys.length === 0 ? 'success' : 'warning',
        message: result.failedKeys.length === 0
          ? t('settings.diagnostics.doctorResetCompleted')
          : t('settings.diagnostics.doctorPartial', { count: String(result.failedKeys.length) }),
      })
      const request = beginReportRequest()
      requestId = request.requestId
      setRunningRequestId(null)
      setResettingRequestId(request.requestId)
      const nextReport = await request.response
      if (!isCurrentRequest(request.requestId, request.requestCwd)) return
      setReportResult({ cwd: request.requestCwd, report: nextReport })
    } catch (error) {
      if (requestId !== null && !isCurrentRequest(requestId, requestCwd)) return
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.doctorFailed'),
      })
    } finally {
      setResettingRequestId((current) => current === requestId ? null : current)
    }
  }

  const unhealthyItems = report?.items.filter(
    (item) => item.status !== 'ok' && item.status !== 'not_configured',
  ) ?? []
  const healthyCount = report?.items.filter((item) => item.status === 'ok').length ?? 0

  return (
    <section className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] ${compact ? 'p-3' : 'p-4'}`}>
      <div className={`flex ${compact ? 'flex-col gap-3' : 'items-start justify-between gap-4'}`}>
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.diagnostics.doctorTitle')}</div>
          <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
            {t('settings.diagnostics.doctorDescription')}
          </p>
          <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
            {t('settings.diagnostics.doctorProtectedData')}
          </p>
        </div>
        <div className={`flex flex-wrap gap-2 ${compact ? 'justify-start' : 'justify-end'} shrink-0`}>
          <Button
            size="sm"
            onClick={handleRunDoctor}
            loading={runningRequestId !== null}
            icon={<Stethoscope className="h-4 w-4" aria-hidden="true" />}
          >
            {t('settings.diagnostics.runDoctor')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setResetConfirmOpen(true)}
            loading={resettingRequestId !== null}
            icon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}
          >
            {t('settings.diagnostics.resetSafeUiState')}
          </Button>
        </div>
      </div>

      <div className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
        {t('settings.diagnostics.doctorSafeKeys')}
      </div>
      <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
        {t('settings.diagnostics.doctorScope')}: {cwd
          ? t('settings.diagnostics.doctorScopeProject')
          : t('settings.diagnostics.doctorScopeUser')}
      </div>

      {report ? (
        <div className="mt-3 space-y-2">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text-secondary)]">
            {t('settings.diagnostics.doctorSummary', {
              healthy: String(healthyCount),
              neutral: String(report.summary.neutralCount),
              missing: String(report.summary.missingCount),
              invalid: String(report.summary.invalidCount),
            })}
          </div>
          {unhealthyItems.length === 0 ? (
            <div className="text-xs text-[var(--color-text-tertiary)]">
              {t('settings.diagnostics.doctorNoFindings')}
            </div>
          ) : (
            <div className="space-y-1.5" aria-label={t('settings.diagnostics.doctorFindings')}>
              {unhealthyItems.map((item) => <DoctorFinding key={item.id} item={item} />)}
            </div>
          )}
        </div>
      ) : null}

      {resetResult ? (
        <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text-secondary)]">
          <div>{t('settings.diagnostics.doctorRemovedKeys')}: {formatKeys(resetResult.removedKeys, t('settings.diagnostics.doctorNoKeys'))}</div>
          <div className="mt-1">{t('settings.diagnostics.doctorFailedKeys')}: {formatKeys(resetResult.failedKeys, t('settings.diagnostics.doctorNoKeys'))}</div>
        </div>
      ) : null}

      <ConfirmDialog
        open={resetConfirmOpen}
        onClose={() => {
          if (resettingRequestId === null) setResetConfirmOpen(false)
        }}
        onConfirm={handleResetSafeState}
        title={t('settings.diagnostics.resetSafeUiState')}
        body={t('settings.diagnostics.confirmResetSafeUiState')}
        confirmLabel={t('settings.diagnostics.resetSafeUiState')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={resettingRequestId !== null}
      />
    </section>
  )
}

function DoctorFinding({ item }: { item: DoctorReportItem }) {
  const t = useTranslation()
  return (
    <div className="rounded-md border border-[var(--color-border)] px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[var(--color-text-secondary)] break-all">{item.path}</span>
        <span className="font-medium text-[var(--color-warning)]">
          {getStatusLabel(t, item.status)}
        </span>
      </div>
      {item.error ? <div className="mt-1 text-[var(--color-text-tertiary)] break-words">{item.error}</div> : null}
    </div>
  )
}

function getStatusLabel(t: ReturnType<typeof useTranslation>, status: DoctorReportItem['status']): string {
  switch (status) {
    case 'not_configured': return t('settings.diagnostics.doctorStatusNotConfigured')
    case 'missing': return t('settings.diagnostics.doctorStatusMissing')
    case 'invalid_json': return t('settings.diagnostics.doctorStatusInvalidJson')
    case 'invalid_jsonl': return t('settings.diagnostics.doctorStatusInvalidJsonl')
    case 'invalid_schema': return t('settings.diagnostics.doctorStatusInvalidSchema')
    case 'unreadable': return t('settings.diagnostics.doctorStatusUnreadable')
    default: return t('settings.diagnostics.doctorStatusHealthy')
  }
}

function formatKeys(keys: string[], emptyLabel: string): string {
  return keys.length > 0 ? keys.join(', ') : emptyLabel
}
