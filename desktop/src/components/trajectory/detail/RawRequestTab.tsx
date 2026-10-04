import { useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { trajectoryApi } from '../../../api/trajectory'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { findTraceCallForRow, type TraceCallLookup } from '../../../lib/trajectory/findTraceCall'
import { useSettingsStore } from '../../../stores/settingsStore'
import type { TrajectoryRow } from '../../../types/trajectory'
import { TraceSectionStateProvider } from './Section'
import { RawRequestDetail } from './RawRequestDetail'

type LookupState = { status: 'loading' } | TraceCallLookup | { status: 'error'; error: string }

/**
 * The captured HTTP exchange behind an assistant row, found by time because
 * the capture and the transcript are written by different writers. The
 * capture switch lives here too, so turning it on never means a trip to
 * Settings.
 */
export function RawRequestTab({ sessionId, row }: { sessionId: string; row: TrajectoryRow }) {
  const t = useTranslation()
  const captureEnabled = useSettingsStore((state) => state.traceCapture?.enabled === true)
  const setCaptureEnabled = useSettingsStore((state) => state.setTraceCaptureEnabled)
  const [state, setState] = useState<LookupState>({ status: 'loading' })
  // Live appends re-create the row object; only a change to its timing can change the match.
  const matchKey = `${row.id}:${row.startTs ?? ''}:${row.ts}:${row.endTs ?? ''}`

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    findTraceCallForRow(row, (from, to) => trajectoryApi.getTraceCallsNear(sessionId, from, to, { signal: controller.signal })).then(
      (lookup) => { if (!controller.signal.aborted) setState(lookup) },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => controller.abort()
  }, [matchKey, sessionId])

  const captureSwitch = (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5">
      <Switch
        checked={captureEnabled}
        onChange={(enabled) => void setCaptureEnabled(enabled)}
        label={t('trajectory.request.captureToggle')}
        description={t('trajectory.request.captureHint')}
        size="sm"
      />
    </div>
  )

  if (state.status === 'loading') return <div className="flex justify-center py-8"><Spinner size={16} /></div>
  if (state.status === 'error') {
    return <EmptyState description={t('trajectory.detail.loadFailed', { error: state.error })} variant="dashed" size="sm" />
  }
  if (state.status === 'uncaptured' || state.status === 'unmatched') {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          description={t(state.status === 'uncaptured' ? 'trajectory.request.uncaptured' : 'trajectory.request.unmatched')}
          variant="dashed"
          size="sm"
        />
        {!captureEnabled && captureSwitch}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--color-text-tertiary)]">{t('trajectory.request.closest')}</p>
      <TraceSectionStateProvider scopeId={`trajectory:${sessionId}:${state.call.id}`}>
        <RawRequestDetail sessionId={sessionId} call={state.call} revisionKey={state.revisionKey} at={state.at} />
      </TraceSectionStateProvider>
    </div>
  )
}
