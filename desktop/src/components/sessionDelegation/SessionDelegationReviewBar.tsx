import { useState } from 'react'
import { Split } from 'lucide-react'
import { sessionCollaborationApi, type SessionDelegationSnapshot } from '@/api/sessionCollaboration'
import { StatusDot } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { useSessionDelegationStore } from '@/stores/sessionDelegationStore'
import type { SessionDelegationBatch } from '../../../../src/shared/sessionDelegation'
import { delegationReviewSummaryLabel } from './delegationLabels'
import { delegationDecisionBatches, isRuntimeAvailable } from './sessionDelegationModel'

/**
 * The composer dock holds only what waits on the user. Sessions that already
 * run belong to the Activity rail; before they start, this one line is the
 * decision, and the dialog holds the per-session detail.
 */
export function SessionDelegationReviewBar({ sessionId }: { sessionId: string }) {
  const snapshot = useSessionDelegationStore(state => state.bySession[sessionId]?.snapshot ?? null)
  const batches = delegationDecisionBatches(snapshot)
  if (!snapshot || batches.length === 0) return null
  return <>{batches.map(batch => <ReviewBatchBar key={batch.id} sessionId={sessionId} snapshot={snapshot} batch={batch} />)}</>
}

function ReviewBatchBar({ sessionId, snapshot, batch }: { sessionId: string; snapshot: SessionDelegationSnapshot; batch: SessionDelegationBatch }) {
  const t = useTranslation()
  const refresh = useSessionDelegationStore(state => state.refresh)
  const setManageOpen = useSessionDelegationStore(state => state.setManageOpen)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const waiting = batch.sessions.filter(entry => !entry.launched)
  const ready = waiting.every(entry => isRuntimeAvailable(snapshot, entry.runtime))
  const act = async (action: 'confirm' | 'cancel') => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await sessionCollaborationApi.act(sessionId, batch, action)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      await refresh(sessionId, { fresh: true })
      setBusy(false)
    }
  }
  const summary = batch.state === 'launching'
    ? t('delegation.state.launching')
    : batch.state === 'failed'
      ? t('delegation.state.failed')
      : delegationReviewSummaryLabel(waiting.length, t)
  return (
    <section
      aria-label={t('delegation.title')}
      data-testid="delegation-review-bar"
      className="@container flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-4 py-3"
    >
      <Split size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-[11px] text-[var(--color-text-tertiary)]">{t('delegation.title')}</p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-[var(--color-text-primary)]" role="status">
          <StatusDot tone={batch.state === 'failed' ? 'danger' : batch.state === 'launching' ? 'info' : 'warning'} pulse={batch.state === 'launching'} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{summary}</span>
        </p>
        {!ready && batch.state !== 'launching' && <p className="mt-1 text-xs text-[var(--color-error)]">{t('delegation.unavailable')}</p>}
        {batch.error && <p role="alert" className="mt-1 break-words text-xs text-[var(--color-error)]">{batch.error}</p>}
        {error && <p role="alert" className="mt-1 break-words text-xs text-[var(--color-error)]">{error}</p>}
      </div>
      {batch.state !== 'launching' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="base" variant="ghost" disabled={busy} onClick={() => void act('cancel')}>{t('delegation.cancel')}</Button>
          <Button size="base" variant="secondary" disabled={busy} onClick={() => setManageOpen(sessionId, true)}>{t('delegation.manage')}</Button>
          <Button size="base" disabled={busy || !ready} onClick={() => void act('confirm')}>{t('delegation.start')}</Button>
        </div>
      )}
    </section>
  )
}
