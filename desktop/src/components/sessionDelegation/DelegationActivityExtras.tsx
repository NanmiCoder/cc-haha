import { useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { sessionCollaborationApi } from '@/api/sessionCollaboration'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { useSessionDelegationStore } from '@/stores/sessionDelegationStore'
import { delegationSessionCountLabel } from './delegationLabels'
import type { DelegationChangeSummary } from './sessionDelegationModel'

const EMPTY_CHANGES: DelegationChangeSummary[] = []

/**
 * The delegated-sessions section's header action: models are changed in the dialog, not in the rail.
 * `onOpen` lets the host clear the way first: the phone's activity sheet sits above dialogs.
 */
export function DelegatedSessionsManageButton({ sessionId, onOpen }: { sessionId: string; onOpen?: () => void }) {
  const t = useTranslation()
  const setManageOpen = useSessionDelegationStore(state => state.setManageOpen)
  return (
    <Button
      variant="ghost"
      size="xs"
      icon={<SlidersHorizontal size={12} strokeWidth={1.75} aria-hidden="true" />}
      onClick={() => {
        onOpen?.()
        setManageOpen(sessionId, true)
      }}
    >
      {t('delegation.manage')}
    </Button>
  )
}

/** A failed poll keeps the last snapshot on screen; say that it may be out of date. */
export function DelegationSyncNotice({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const error = useSessionDelegationStore(state => state.bySession[sessionId]?.snapshot ? state.bySession[sessionId]?.error ?? null : null)
  if (!error) return null
  return (
    <p role="alert" data-testid="delegation-sync-error" className="mt-2 break-words text-xs text-[var(--color-error)]">
      {t('delegation.syncFailed')} · {error}
    </p>
  )
}

/** One line per unfinished model change. Each row already names its target model, so this only counts. */
export function DelegationChangeStatusList({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const changes = useSessionDelegationStore(state => state.bySession[sessionId]?.changes ?? EMPTY_CHANGES)
  const refresh = useSessionDelegationStore(state => state.refresh)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (changes.length === 0) return null
  const cancel = async (change: DelegationChangeSummary) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await sessionCollaborationApi.cancelChange(sessionId, change.id, change.revision)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      await refresh(sessionId, { fresh: true })
      setBusy(false)
    }
  }
  return (
    <div data-testid="delegation-change-status" className="mt-2 space-y-1.5">
      {changes.map(change => (
        <div
          key={change.id}
          role="status"
          className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-md)] px-2.5 py-1.5 text-xs ${change.state === 'failed'
            ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
            : 'bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]'}`}
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {t(`delegation.change.${change.state}`)} · {delegationSessionCountLabel(change.sessionCount, t)}
          </span>
          {change.state === 'pending' ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel(change)}>
              {t('delegation.cancelChange')}
            </Button>
          ) : null}
          {change.error ? <p className="w-full break-words">{change.error}</p> : null}
        </div>
      ))}
      {error ? <p role="alert" className="break-words text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  )
}
