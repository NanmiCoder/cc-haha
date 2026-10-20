import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { sessionCollaborationApi, type SessionDelegationSnapshot } from '@/api/sessionCollaboration'
import { ModelSelector, type ModelProviderChoice } from '@/components/controls/ModelSelector'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Modal } from '@/components/ui/Modal'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import { useSessionDelegationStore } from '@/stores/sessionDelegationStore'
import type { RuntimeSelection } from '@/types/runtime'
import type { SessionDelegationBatch, SessionRuntimeSelection } from '../../../../src/shared/sessionDelegation'
import { DelegationChangeStatusList, DelegationSyncNotice } from './DelegationActivityExtras'
import { delegatedSessionStatusLabel, delegatedSessionStatusTone, delegationApplyCountLabel, pendingSwitchLabel } from './delegationLabels'
import { activeModelChange, delegationEntries, isRuntimeAvailable, pendingRuntime, type DelegatedSessionRow, type DelegationEntryView } from './sessionDelegationModel'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const EMPTY_ROWS: DelegatedSessionRow[] = []

function selection(runtime: SessionRuntimeSelection): RuntimeSelection {
  return { ...runtime, effortLevel: EFFORTS.includes(runtime.effortLevel as typeof EFFORTS[number]) ? runtime.effortLevel as RuntimeSelection['effortLevel'] : undefined }
}

function runtimeChoices(snapshot: SessionDelegationSnapshot | null): ModelProviderChoice[] {
  const groups = new Map<string | null, ModelProviderChoice>()
  for (const model of snapshot?.models ?? []) {
    const group = groups.get(model.providerId) ?? { providerId: model.providerId, providerName: model.providerName, isDefault: false, models: [] }
    group.isDefault ||= model.isDefault
    group.models.push({ id: model.modelId, name: model.modelName, description: '', context: '', supportedReasoningEfforts: model.supportedEfforts.filter((effort): effort is NonNullable<RuntimeSelection['effortLevel']> => EFFORTS.includes(effort as typeof EFFORTS[number])) })
    groups.set(model.providerId, group)
  }
  return [...groups.values()]
}

/** Opened from the Activity rail or the composer's decision bar; mounted fresh each time so drafts never outlive it. */
export function SessionDelegationDialog({ sessionId }: { sessionId: string }) {
  const open = useSessionDelegationStore(state => state.bySession[sessionId]?.manageOpen ?? false)
  const hasSnapshot = useSessionDelegationStore(state => !!state.bySession[sessionId]?.snapshot)
  if (!open || !hasSnapshot) return null
  return <SessionDelegationDialogContent sessionId={sessionId} />
}

/** Local edits never alter a running session until they are applied. */
function SessionDelegationDialogContent({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const selectionLimitHintId = useId()
  const startedOnlyHintId = useId()
  const snapshot = useSessionDelegationStore(state => state.bySession[sessionId]?.snapshot ?? null)
  const rows = useSessionDelegationStore(state => state.bySession[sessionId]?.rows ?? EMPTY_ROWS)
  const refresh = useSessionDelegationStore(state => state.refresh)
  const setSnapshot = useSessionDelegationStore(state => state.setSnapshot)
  const setManageOpen = useSessionDelegationStore(state => state.setManageOpen)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, SessionRuntimeSelection>>({})
  const [mode, setMode] = useState<'after_turn' | 'immediate'>('after_turn')
  const [resume, setResume] = useState(true)
  const draftRevisions = useRef(new Map<string, number>())
  const alive = useRef(true)
  const request = useRef<{ signature: string; id: string } | null>(null)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const choices = useMemo(() => runtimeChoices(snapshot), [snapshot])
  const entries = useMemo(() => delegationEntries(snapshot), [snapshot])
  if (!snapshot) return null

  const batches = [...new Map(entries.map(row => [row.batch.id, row.batch])).values()]
  const locked = (row: DelegationEntryView) => !!activeModelChange(snapshot, row.entry.sessionId)
  const selectable = entries.filter(row => !locked(row) && row.batch.state !== 'launching')
  const chosen = entries.filter(row => selected.includes(row.key))
  const startedChosen = chosen.filter(row => row.started)
  const selectionLimitExceeded = startedChosen.length > 8
  // A pending switch is what the session is about to run, so it is what the row shows.
  const shown = (row: DelegationEntryView) => drafts[row.key] ?? pendingRuntime(snapshot, row.entry.sessionId) ?? row.entry.runtime
  const effective = (row: DelegationEntryView) => drafts[row.key] ?? row.entry.runtime
  const conflicted = (batch: SessionDelegationBatch) => draftRevisions.current.has(batch.id) && draftRevisions.current.get(batch.id) !== batch.revision

  // Closing never cancels a request; its outcome shows in the review bar and the Activity rail.
  const close = () => setManageOpen(sessionId, false)
  /**
   * Forget what a successful action submitted, and close only when nothing else
   * is left. A selection can mix started sessions, which Apply changes, with
   * sessions that take their model when Start runs; closing on either button
   * used to drop the other half without a word.
   */
  const settle = (submitted: string[]) => {
    const done = new Set(submitted)
    if (![...selected, ...Object.keys(drafts)].some(key => !done.has(key))) {
      setManageOpen(sessionId, false)
      return
    }
    setSelected(previous => previous.filter(key => !done.has(key)))
    setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !done.has(key))))
  }
  const run = async (action: () => Promise<unknown>, submitted: string[]) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      await refresh(sessionId, { fresh: true })
      if (alive.current) settle(submitted)
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason))
      await refresh(sessionId, { fresh: true })
    } finally { if (alive.current) setBusy(false) }
  }
  const edit = (targets: DelegationEntryView[], value: RuntimeSelection) => {
    setSelected(previous => [...new Set([...previous, ...targets.filter(row => row.started).map(row => row.key)])])
    for (const row of targets) if (!draftRevisions.current.has(row.batch.id)) draftRevisions.current.set(row.batch.id, row.batch.revision)
    setDrafts(previous => ({ ...previous, ...Object.fromEntries(targets.map(row => [row.key, value])) }))
  }
  const discard = (batch: SessionDelegationBatch) => {
    draftRevisions.current.delete(batch.id)
    setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${batch.id}:`))))
  }
  // Start and Cancel act on a batch's sessions that have not started; started ones are Apply's.
  const waitingKeys = (batch: SessionDelegationBatch) => batch.sessions.filter(entry => !entry.launched).map(entry => `${batch.id}:${entry.id}`)
  const confirm = (batch: SessionDelegationBatch) => {
    const waiting = waitingKeys(batch)
    return run(async () => {
      const updates = batch.sessions.flatMap(entry => !entry.launched && drafts[`${batch.id}:${entry.id}`] ? [{ id: entry.id, runtime: drafts[`${batch.id}:${entry.id}`]! }] : [])
      const current = updates.length ? await sessionCollaborationApi.update(sessionId, batch, updates) : batch
      if (updates.length) {
        // The server holds these choices now, under a new revision.
        draftRevisions.current.delete(batch.id)
        setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !waiting.includes(key))))
        setSnapshot(sessionId, { ...snapshot, batches: snapshot.batches.map(item => item.id === current.id ? current : item) })
      }
      await sessionCollaborationApi.act(sessionId, current, 'confirm')
    }, waiting)
  }
  const cancelBatch = (batch: SessionDelegationBatch) => run(async () => {
    await sessionCollaborationApi.act(sessionId, batch, 'cancel')
    draftRevisions.current.delete(batch.id)
  }, waitingKeys(batch))
  const apply = () => selectionLimitExceeded ? undefined : run(async () => {
    const selections = startedChosen.flatMap(row => row.entry.sessionId && effective(row) ? [{ sessionId: row.entry.sessionId, runtime: effective(row)! }] : [])
    const signature = JSON.stringify({ mode, resume, selections })
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() }
    await sessionCollaborationApi.change(sessionId, { requestId: request.current.id, mode, resume, selections })
    request.current = null
  }, startedChosen.map(row => row.key))

  const startedOnly = startedChosen.length > 0 && chosen.length > startedChosen.length
  const footer = startedChosen.length > 0 ? (
    <div className="flex w-full flex-wrap items-end gap-3">
      <div className="min-w-[200px] flex-1">
        <SelectField label={t('delegation.when')} size="sm" value={mode} onChange={setMode} disabled={busy} options={[{ value: 'after_turn', label: t('delegation.afterTurn') }, { value: 'immediate', label: t('delegation.immediate') }]} />
      </div>
      <Checkbox size="sm" label={t('delegation.resume')} checked={resume} disabled={busy} onChange={event => setResume(event.target.checked)} />
      {selectionLimitExceeded && <p id={selectionLimitHintId} role="alert" className="w-full text-xs text-[var(--color-error)]">{t('delegation.selectionLimit')}</p>}
      {/* Apply counts only started sessions; say where the rest of the selection goes. */}
      {startedOnly && <p id={startedOnlyHintId} className="w-full text-xs text-[var(--color-text-secondary)]">{t('delegation.applyStartedOnly')}</p>}
      <Button size="base" aria-describedby={[selectionLimitExceeded ? selectionLimitHintId : '', startedOnly ? startedOnlyHintId : ''].filter(Boolean).join(' ') || undefined} disabled={busy || selectionLimitExceeded || startedChosen.some(row => !isRuntimeAvailable(snapshot, effective(row)))} onClick={() => void apply()}>
        {delegationApplyCountLabel(startedChosen.length, t)}
      </Button>
    </div>
  ) : undefined

  return (
    <Modal open onClose={close} title={t('delegation.title')} width={760} typography="interface" footer={footer}>
      <div className="@container min-w-0 space-y-3">
        <p className="text-[13px] text-[var(--color-text-secondary)]">{t('delegation.manageHint')}</p>
        {error && <p role="alert" className="break-words text-xs text-[var(--color-error)]">{error}</p>}
        <DelegationSyncNotice sessionId={sessionId} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container-low)] px-3 py-2">
          <Checkbox size="sm" label={t('delegation.selectAll')} indeterminate={selected.length > 0 && !selectable.every(row => selected.includes(row.key))} checked={selectable.length > 0 && selectable.every(row => selected.includes(row.key))} disabled={busy || selectable.length === 0} onChange={event => setSelected(event.target.checked ? selectable.map(row => row.key) : [])} />
          {chosen.length > 0 && <>
            <span className="text-xs text-[var(--color-text-tertiary)]">{t('delegation.selectedCount', { count: chosen.length })}</span>
            <div className="ml-auto w-full min-w-0 @min-[560px]:w-[260px]">
              <ModelSelector appearance="field" fluid ariaLabel={t('delegation.batchModel')} runtimeChoices={choices} runtimeSelection={selection(shown(chosen[0]!) ?? { providerId: null, modelId: '' })} onRuntimeSelectionChange={value => edit(chosen, value)} disabled={busy || !choices.length} />
            </div>
          </>}
        </div>
        {batches.map(batch => (
          <div key={batch.id} className="min-w-0">
            {batch.state !== 'launched' && <div className="mb-1"><Badge tone={batch.state === 'review' ? 'warning' : batch.state === 'failed' ? 'danger' : 'neutral'}>{t(`delegation.state.${batch.state}`)}</Badge></div>}
            {conflicted(batch) && <div role="alert" className="text-xs text-[var(--color-error)]">{t('delegation.conflict')} <Button size="sm" variant="ghost" onClick={() => discard(batch)}>{t('delegation.reload')}</Button></div>}
            {batch.error && <p role="alert" className="text-xs text-[var(--color-error)]">{batch.error}</p>}
            {entries.filter(row => row.batch.id === batch.id).map(row => {
              const { entry, key } = row
              const title = entry.title ?? entry.prompt.slice(0, 80)
              const runtime = shown(row)
              const status = rows.find(item => item.key === key)
              const isLocked = locked(row)
              return (
                <div key={key} data-testid="delegation-task-row" className="grid min-w-0 gap-3 border-b border-[var(--color-border)] py-3 last:border-b-0 @min-[560px]:grid-cols-[minmax(0,1fr)_260px] @min-[560px]:items-start">
                  <div className="min-w-0">
                    <Checkbox size="sm" label={<span className="block break-words font-medium">{title}</span>} checked={selected.includes(key)} disabled={busy || batch.state === 'launching' || isLocked} onChange={event => setSelected(previous => event.target.checked ? [...previous, key] : previous.filter(id => id !== key))} />
                    <div className="ml-[22px] mt-1 space-y-1.5">
                      <p className="line-clamp-2 break-words text-xs leading-relaxed text-[var(--color-text-secondary)]" title={entry.prompt}>{entry.prompt}</p>
                      {status && row.started && <Badge tone={delegatedSessionStatusTone(status.status)}>{delegatedSessionStatusLabel(status.status, t)}</Badge>}
                      {status?.pendingSwitch && <p className="text-xs text-[var(--color-text-secondary)]">{pendingSwitchLabel(status.pendingSwitch, t)}</p>}
                      {row.actual?.error && <p role="alert" className="break-words text-xs text-[var(--color-error)]">{row.actual.error}</p>}
                      {!isRuntimeAvailable(snapshot, runtime) && <p className="text-xs text-[var(--color-error)]">{t('delegation.unavailable')}</p>}
                      {entry.error && entry.error !== row.actual?.error && <p role="alert" className="break-words text-xs text-[var(--color-error)]">{entry.error}</p>}
                    </div>
                  </div>
                  <div className="min-w-0 pl-[22px] @min-[560px]:pl-0">
                    <ModelSelector appearance="field" fluid ariaLabel={`${title} · ${t('delegation.model')}`} runtimeChoices={choices} runtimeSelection={runtime ? selection(runtime) : { providerId: null, modelId: '' }} onRuntimeSelectionChange={value => edit([row], value)} disabled={busy || !choices.length || batch.state === 'launching' || isLocked} />
                  </div>
                </div>
              )
            })}
            {(batch.state === 'review' || batch.state === 'failed') && <div className="flex flex-wrap justify-end gap-2 pt-3">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancelBatch(batch)}>{t('delegation.cancel')}</Button>
              <Button size="sm" disabled={busy || conflicted(batch) || batch.sessions.some(entry => !entry.launched && !isRuntimeAvailable(snapshot, drafts[`${batch.id}:${entry.id}`] ?? entry.runtime))} onClick={() => void confirm(batch)}>{t('delegation.start')}</Button>
            </div>}
          </div>
        ))}
        <DelegationChangeStatusList sessionId={sessionId} />
      </div>
    </Modal>
  )
}
