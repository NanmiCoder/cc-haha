import { Stethoscope } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../shared/Button'
import { useTranslation } from '../../i18n'
import { runDoctorRepair, type DoctorRepairResult } from '../../lib/doctorRepair'
import { useUIStore } from '../../stores/uiStore'

type DoctorPanelProps = {
  compact?: boolean
}

export function DoctorPanel({ compact = false }: DoctorPanelProps) {
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<DoctorRepairResult | null>(null)

  const handleRunDoctor = async () => {
    setIsRunning(true)
    try {
      const nextResult = await runDoctorRepair()
      setResult(nextResult)
      addToast({
        type: nextResult.local.failedKeys.length === 0 ? 'success' : 'warning',
        message: getDoctorToastMessage(t, nextResult),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.doctorFailed'),
      })
    } finally {
      setIsRunning(false)
    }
  }

  const statusText = result ? getDoctorStatusMessage(t, result) : null

  return (
    <section className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] ${compact ? 'p-3' : 'p-4'} `}>
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
        <div className={`flex ${compact ? 'justify-start' : 'justify-end'} shrink-0`}>
          <Button
            size="sm"
            onClick={handleRunDoctor}
            loading={isRunning}
            icon={<Stethoscope className="h-4 w-4" aria-hidden="true" />}
          >
            {t('settings.diagnostics.runDoctor')}
          </Button>
        </div>
      </div>

      <div className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
        {t('settings.diagnostics.doctorSafeKeys')}
      </div>

      {statusText ? (
        <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text-secondary)]">
          {statusText}
        </div>
      ) : null}
    </section>
  )
}

function getDoctorToastMessage(
  t: ReturnType<typeof useTranslation>,
  result: DoctorRepairResult,
): string {
  if (result.local.failedKeys.length > 0) {
    return t('settings.diagnostics.doctorPartial', { count: String(result.local.failedKeys.length) })
  }
  return t('settings.diagnostics.doctorCompleted')
}

function getDoctorStatusMessage(
  t: ReturnType<typeof useTranslation>,
  result: DoctorRepairResult,
): string {
  const clearedCount = result.local.removedKeys.length
  const base = t('settings.diagnostics.doctorResultLocal', { count: String(clearedCount) })

  if (result.local.failedKeys.length > 0) {
    return `${base} ${t('settings.diagnostics.doctorResultFailedKeys', { count: String(result.local.failedKeys.length) })}`
  }

  if (result.server) {
    return `${base} ${t('settings.diagnostics.doctorServerRan')}`
  }

  if (result.serverError) {
    return `${base} ${t('settings.diagnostics.doctorServerUnavailable')}`
  }

  return base
}
