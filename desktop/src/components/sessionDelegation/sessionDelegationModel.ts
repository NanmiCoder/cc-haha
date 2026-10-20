import type { SessionDelegationSnapshot } from '@/api/sessionCollaboration'
import type { SessionDelegationBatch, SessionDelegationEntry, SessionModelChange, SessionRuntimeSelection } from '../../../../src/shared/sessionDelegation'

export type DelegationSessionState = NonNullable<SessionDelegationSnapshot['sessions']>[number]

export type DelegationEntryView = {
  key: string
  batch: SessionDelegationBatch
  /** The batch entry with the child's actual runtime and error merged in. */
  entry: SessionDelegationEntry
  actual?: DelegationSessionState
  started: boolean
}

export type DelegatedSessionStatus = 'review' | 'launching' | 'queued' | 'running' | 'blocked' | 'idle' | 'completed' | 'failed' | 'paused'

/** One delegated session as the Activity rail lists it. Plain data, compared by value. */
export type DelegatedSessionRow = {
  key: string
  sessionId?: string
  title: string
  status: DelegatedSessionStatus
  /** The model the session will run: a pending switch's target, else what it runs now. */
  modelLabel?: string
  pendingSwitch?: {
    phase: 'afterTurn' | 'waiting' | 'applying'
    /** Set only when the session still runs something other than the target. */
    currentModelLabel?: string
  }
}

export type DelegationChangeSummary = {
  id: string
  revision: number
  state: 'pending' | 'applying' | 'failed'
  sessionCount: number
  error?: string
}

/** Cancelled batches keep only the sessions that already started; they stay manageable. */
export function delegationEntries(snapshot: SessionDelegationSnapshot | null | undefined): DelegationEntryView[] {
  if (!snapshot) return []
  return snapshot.batches
    .map(batch => batch.state === 'cancelled' ? { ...batch, sessions: batch.sessions.filter(entry => entry.launched) } : batch)
    .filter(batch => batch.sessions.length > 0)
    .flatMap(batch => batch.sessions.map(original => {
      const actual = original.sessionId ? snapshot.sessions?.find(item => item.sessionId === original.sessionId) : undefined
      const entry = actual ? { ...original, runtime: actual.runtime, error: actual.error ?? original.error } : original
      return { key: `${batch.id}:${original.id}`, batch, entry, actual, started: !!original.launched || batch.state === 'launched' }
    }))
}

/** A session in an unfinished change cannot take another one until it settles. */
export function activeModelChange(snapshot: SessionDelegationSnapshot | null | undefined, sessionId: string | undefined): SessionModelChange | undefined {
  if (!snapshot || !sessionId) return undefined
  return snapshot.changes.find(change => (change.state === 'pending' || change.state === 'applying') && change.selections.some(item => item.sessionId === sessionId))
}

export function pendingRuntime(snapshot: SessionDelegationSnapshot | null | undefined, sessionId: string | undefined): SessionRuntimeSelection | undefined {
  return activeModelChange(snapshot, sessionId)?.selections.find(item => item.sessionId === sessionId)?.runtime
}

export function sameRuntimeModel(a: SessionRuntimeSelection | undefined, b: SessionRuntimeSelection | undefined): boolean {
  return !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId
}

export function isRuntimeAvailable(snapshot: SessionDelegationSnapshot, runtime: SessionRuntimeSelection | undefined): boolean {
  return !!runtime && snapshot.models.some(model => model.providerId === runtime.providerId && model.modelId === runtime.modelId)
}

function runtimeModelName(snapshot: SessionDelegationSnapshot, runtime: SessionRuntimeSelection | undefined): string | undefined {
  if (!runtime?.modelId) return undefined
  return snapshot.models.find(item => item.providerId === runtime.providerId && item.modelId === runtime.modelId)?.modelName || runtime.modelId
}

export function runtimeLabel(snapshot: SessionDelegationSnapshot, runtime: SessionRuntimeSelection | undefined): string | undefined {
  if (!runtime?.modelId) return undefined
  const model = snapshot.models.find(item => item.providerId === runtime.providerId && item.modelId === runtime.modelId)
  const providerName = model?.providerName ?? snapshot.models.find(item => item.providerId === runtime.providerId)?.providerName
  const modelName = model?.modelName || runtime.modelId
  return providerName ? `${modelName} · ${providerName}` : modelName
}

function entryStatus(view: DelegationEntryView): DelegatedSessionStatus {
  if (!view.started) return view.batch.state === 'launching' ? 'launching' : 'review'
  const actual = view.actual
  if (!actual) return 'idle'
  if (actual.paused || actual.state === 'stopped') return 'paused'
  switch (actual.state) {
    case 'queued':
    case 'running':
    case 'blocked':
    case 'idle':
    case 'completed':
    case 'failed':
      return actual.state
    default:
      return 'idle'
  }
}

export function buildDelegatedSessionRows(snapshot: SessionDelegationSnapshot | null | undefined): DelegatedSessionRow[] {
  if (!snapshot) return []
  return delegationEntries(snapshot).map(view => {
    const { entry } = view
    const status = entryStatus(view)
    const change = activeModelChange(snapshot, entry.sessionId)
    const target = change?.selections.find(item => item.sessionId === entry.sessionId)?.runtime
    const row: DelegatedSessionRow = {
      key: view.key,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      title: entry.title ?? entry.prompt.slice(0, 80),
      status,
    }
    const modelLabel = runtimeLabel(snapshot, target ?? entry.runtime)
    if (modelLabel) row.modelLabel = modelLabel
    if (change && target) {
      const phase = change.state === 'applying' || change.mode === 'immediate'
        ? 'applying'
        : status === 'running' || status === 'blocked' ? 'afterTurn' : 'waiting'
      // The rail is narrow and the target already names the provider; the old model's name is enough.
      const currentModelLabel = sameRuntimeModel(entry.runtime, target) ? undefined : runtimeModelName(snapshot, entry.runtime)
      row.pendingSwitch = currentModelLabel ? { phase, currentModelLabel } : { phase }
    }
    return row
  })
}

export function delegationChangeSummaries(snapshot: SessionDelegationSnapshot | null | undefined): DelegationChangeSummary[] {
  if (!snapshot) return []
  return snapshot.changes.flatMap(change => change.state === 'pending' || change.state === 'applying' || change.state === 'failed'
    ? [{ id: change.id, revision: change.revision, state: change.state, sessionCount: change.selections.length, ...(change.error ? { error: change.error } : {}) }]
    : [])
}

/** Batches that wait on the user before any session starts: the only delegation state the composer dock shows. */
export function delegationDecisionBatches(snapshot: SessionDelegationSnapshot | null | undefined): SessionDelegationBatch[] {
  return snapshot?.batches.filter(batch => batch.state === 'review' || batch.state === 'failed' || batch.state === 'launching') ?? []
}
