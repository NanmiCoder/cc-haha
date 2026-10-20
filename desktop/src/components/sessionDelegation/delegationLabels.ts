import type { Tone } from '@/components/ui/Badge'
import type { useTranslation } from '@/i18n'
import type { DelegatedSessionRow } from './sessionDelegationModel'

type TranslationFn = ReturnType<typeof useTranslation>

export function delegatedSessionStatusLabel(status: DelegatedSessionRow['status'], t: TranslationFn): string {
  switch (status) {
    case 'review':
      return t('delegation.notStarted')
    case 'launching':
      return t('delegation.launching')
    case 'queued':
      return t('delegation.queued')
    case 'running':
      return t('delegation.active')
    case 'blocked':
      return t('delegation.blocked')
    case 'idle':
      return t('delegation.idle')
    case 'completed':
      return t('delegation.completed')
    case 'failed':
      return t('delegation.failed')
    case 'paused':
      return t('delegation.paused')
  }
}

export function delegatedSessionStatusTone(status: DelegatedSessionRow['status']): Tone {
  switch (status) {
    case 'running':
      return 'info'
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'blocked':
    case 'paused':
      return 'warning'
    default:
      return 'neutral'
  }
}

// Counted labels pick a literal key per form: English needs the singular.
export function delegationSessionCountLabel(count: number, t: TranslationFn): string {
  return t(count === 1 ? 'delegation.sessionCountOne' : 'delegation.sessionCountOther', { count })
}

export function delegationApplyCountLabel(count: number, t: TranslationFn): string {
  return t(count === 1 ? 'delegation.applyCountOne' : 'delegation.applyCountOther', { count })
}

export function delegationReviewSummaryLabel(count: number, t: TranslationFn): string {
  return t(count === 1 ? 'delegation.reviewSummaryOne' : 'delegation.reviewSummaryOther', { count })
}

/** Shown on a session whose model switch is accepted but not applied yet. */
export function pendingSwitchLabel(pending: NonNullable<DelegatedSessionRow['pendingSwitch']>, t: TranslationFn): string {
  if (pending.phase === 'applying') return t('delegation.pendingSwitch.applying')
  if (pending.phase === 'afterTurn') {
    return pending.currentModelLabel
      ? t('delegation.pendingSwitch.afterTurnFrom', { model: pending.currentModelLabel })
      : t('delegation.pendingSwitch.afterTurn')
  }
  return pending.currentModelLabel
    ? t('delegation.pendingSwitch.waitingFrom', { model: pending.currentModelLabel })
    : t('delegation.pendingSwitch.waiting')
}
