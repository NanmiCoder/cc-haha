import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Pause, Play, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { ModelSelector } from '@/components/controls/ModelSelector'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Modal } from '@/components/ui/Modal'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '@/constants/openaiOfficialProvider'
import { getBundledPresetReasoningProviderKind } from '@/config/providerPresets'
import { useTranslation, type TranslationKey } from '@/i18n'
import { getProviderModelCapabilityOverride } from '@/lib/runtimeSelection'
import { useChatStore } from '@/stores/chatStore'
import { useProviderStore } from '@/stores/providerStore'
import { useTeamStore, memberSessionId } from '@/stores/teamStore'
import { EMPTY_TEAM_RUNTIME_CONTROL, teamRuntimeControlKey, teamRuntimeScope, useTeamRuntimeControlStore } from '@/stores/teamRuntimeControlStore'
import type { RuntimeSelection } from '@/types/runtime'
import type { ReasoningEffortLevel } from '@/types/settings'
import type { TeamDetail, TeamMember } from '@/types/team'
import { normalizeModelReasoningEffort } from '../../../../src/shared/modelReasoning'
import type { TeamRuntimeControlView } from '../../../../src/shared/teamRuntimeControl'

const STATE_LABELS: Record<TeamRuntimeControlView['status'], TranslationKey> = {
  running: 'agentTeams.runtime.running', pausing: 'agentTeams.runtime.pausing', paused: 'agentTeams.runtime.paused',
  resuming: 'agentTeams.runtime.resuming', partial: 'agentTeams.runtime.partial',
}
const STATE_TONES: Record<TeamRuntimeControlView['status'], Tone> = {
  running: 'info', pausing: 'warning', paused: 'neutral', resuming: 'info', partial: 'danger',
}

function runtimeOf(member: TeamMember): RuntimeSelection | null {
  if (!member.model || !member.sessionId) return null
  const effort = member.effortLevel
  return {
    providerId: member.providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : member.providerId ?? null,
    modelId: member.model,
    ...(['low', 'medium', 'high', 'xhigh', 'max'].includes(effort ?? '') ? { effortLevel: effort as RuntimeSelection['effortLevel'] } : {}),
  }
}

function sameRuntime(left: RuntimeSelection | null, right: RuntimeSelection): boolean {
  return !!left && left.providerId === right.providerId && left.modelId === right.modelId && left.effortLevel === right.effortLevel
}

/** Live controls operate on the current team incarnation, independently of replay. */
export function AgentTeamsRuntimeControls({ team, readOnly = false }: { team: TeamDetail; readOnly?: boolean }) {
  const t = useTranslation()
  const { name: teamName, leadSessionId, incarnationId } = team
  const scope = useMemo(() => teamRuntimeScope({ name: teamName, leadSessionId, incarnationId }), [teamName, leadSessionId, incarnationId])
  const scopeKey = scope ? teamRuntimeControlKey(scope) : null
  const entry = useTeamRuntimeControlStore(state => scopeKey ? state.byTeam[scopeKey] : undefined) ?? EMPTY_TEAM_RUNTIME_CONTROL
  const providers = useProviderStore(state => state.providers)
  const [editorOpen, setEditorOpen] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, RuntimeSelection>>({})
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const editorGeneration = useRef(0)
  const errorId = useId()
  const editorErrorId = useId()

  useEffect(() => {
    if (readOnly || !scope) return
    void useTeamRuntimeControlStore.getState().refresh(scope)
    const timer = window.setInterval(() => void useTeamRuntimeControlStore.getState().refresh(scope), 1500)
    return () => window.clearInterval(timer)
  }, [scope, readOnly])

  useEffect(() => {
    editorGeneration.current += 1
    setEditorOpen(false)
    setDrafts({})
    setSelected([])
    setSaveError(null)
    setSaving(false)
  }, [scopeKey, readOnly])

  if (readOnly || !scope) return null
  const control = entry.control
  if (!control) {
    if (!entry.error) return entry.loading ? <p role="status" className="px-[18px] py-2 text-xs text-[var(--color-text-secondary)]">{t('agentTeams.runtime.loading')}</p> : null
    return <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-[18px] py-2">
      <p id={errorId} role="alert" className="min-w-0 flex-1 text-xs text-[var(--color-text-secondary)]">{entry.error}</p>
      <Button size="sm" variant="ghost" aria-describedby={errorId} onClick={() => void useTeamRuntimeControlStore.getState().refresh(scope)}>{t('agentTeams.runtime.refresh')}</Button>
    </div>
  }

  const status = entry.pauseRequested ? 'pausing' : entry.operation === 'resume' ? 'resuming' : control.status
  const editableMembers = control.members.flatMap(identity => {
    const member = team.members.find(candidate => candidate.agentId === identity.agentId && candidate.sessionId === identity.sessionId)
    return member && member.agentId !== team.leadAgentId && runtimeOf(member) ? [member] : []
  })
  const canEdit = control.status === 'paused' && !entry.busy && !entry.pauseRequested && !entry.error
  const canResume = (control.status === 'paused' || control.status === 'partial') && !entry.busy && !entry.pauseRequested && !entry.error
  const canPause = !entry.pauseRequested && status !== 'pausing' && status !== 'paused'
  const errors = [...new Set([
    entry.error, control.error,
    ...control.members.map(member => member.error ? `${member.name}: ${member.error}` : null),
  ].filter((message): message is string => Boolean(message)))]
  const changedMembers = editableMembers.filter(member => drafts[member.agentId] && !sameRuntime(runtimeOf(member), drafts[member.agentId]!))
  const batchMember = editableMembers.find(member => selected.includes(member.agentId))
  const batchRuntime = batchMember ? drafts[batchMember.agentId] : undefined

  const updateDraft = (agentId: string, runtime: RuntimeSelection) => {
    if (!canEdit || saving) return
    setDrafts(current => {
      const previous = current[agentId]
      const modelChanged = previous?.providerId !== runtime.providerId || previous.modelId !== runtime.modelId
      // A new model must not introduce the composer's global effort into a member.
      const value = modelChanged && previous?.effortLevel === undefined ? { ...runtime, effortLevel: undefined } : runtime
      return { ...current, [agentId]: value }
    })
    setSaveError(null)
  }
  const updateSelectedEffort = (level: ReasoningEffortLevel) => {
    if (!canEdit || saving) return
    setDrafts(current => Object.fromEntries(Object.entries(current).map(([id, runtime]) => {
      if (!selected.includes(id)) return [id, runtime]
      const provider = providers.find(candidate => candidate.id === runtime.providerId)
      const effortLevel = provider
        ? normalizeModelReasoningEffort(runtime.modelId, level, provider.apiFormat, getProviderModelCapabilityOverride(provider, runtime.modelId), getBundledPresetReasoningProviderKind(provider.presetId))
        : level
      return [id, effortLevel ? { ...runtime, effortLevel } : runtime]
    })))
    setSaveError(null)
  }
  const openEditor = () => {
    setDrafts(Object.fromEntries(editableMembers.map(member => [member.agentId, runtimeOf(member)!])))
    setSelected([])
    setSaveError(null)
    setEditorOpen(true)
  }
  const save = async () => {
    if (!canEdit || saving || changedMembers.length === 0) return
    const generation = editorGeneration.current
    setSaving(true)
    setSaveError(null)
    try {
      // Each response supplies the next CAS revision; never race two member saves.
      for (const member of changedMembers) {
        if (generation !== editorGeneration.current) return
        await useTeamStore.getState().updateMemberRuntime(memberSessionId(member.agentId, scope.incarnationId), drafts[member.agentId]!)
      }
      if (generation === editorGeneration.current) setEditorOpen(false)
    } catch (error) {
      if (generation === editorGeneration.current) setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === editorGeneration.current) setSaving(false)
    }
  }

  return <section aria-label={t('agentTeams.runtime.title')} data-testid="agent-teams-runtime-controls" className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-[18px] py-2.5">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Badge tone={STATE_TONES[status]} size="sm"><span role="status">{t(STATE_LABELS[status])}</span></Badge>
      <span className="min-w-0 flex-1 text-xs text-[var(--color-text-secondary)]">{t('agentTeams.runtime.eligible', { count: control.resumeEligibleCount })}</span>
      <Button size="sm" variant="secondary" disabled={!canEdit || editableMembers.length === 0} icon={<SlidersHorizontal size={13} strokeWidth={1.75} aria-hidden="true" />} onClick={openEditor}>{t('agentTeams.runtime.edit')}</Button>
      <Button size="sm" variant="secondary" disabled={!canPause} icon={<Pause size={13} strokeWidth={1.75} aria-hidden="true" />} onClick={() => {
        useTeamRuntimeControlStore.getState().markPauseRequested(scope)
        useChatStore.getState().stopGeneration(scope.leadSessionId)
      }}>{t('agentTeams.runtime.pause')}</Button>
      <Button size="sm" variant="primary" disabled={!canResume} loading={entry.operation === 'resume'} aria-describedby={errors.length > 0 ? errorId : undefined} icon={control.status === 'partial' ? <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" /> : <Play size={13} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void useTeamRuntimeControlStore.getState().resume(scope).catch(() => {})}>
        {t(control.status === 'partial' ? 'agentTeams.runtime.retry' : 'agentTeams.runtime.resume', { count: control.resumeEligibleCount })}
      </Button>
    </div>
    <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">{t('agentTeams.runtime.memberMessageHint')}</p>
    {errors.length > 0 && <p id={errorId} role="alert" className="mt-1.5 whitespace-pre-wrap text-xs text-[var(--color-error)]">{errors.join('\n')}</p>}
    <Modal open={editorOpen} onClose={() => { if (!saving) setEditorOpen(false) }} title={t('agentTeams.runtime.edit')} typography="interface" width={860} footer={<div className="flex w-full flex-wrap items-center justify-end gap-2">
      <Button variant="ghost" disabled={saving} onClick={() => setEditorOpen(false)}>{t('common.close')}</Button>
      <Button disabled={!canEdit || changedMembers.length === 0} loading={saving} aria-describedby={saveError ? editorErrorId : undefined} onClick={() => void save()}>{t('agentTeams.runtime.save')}</Button>
    </div>}>
      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{t(canEdit ? 'agentTeams.runtime.saveHint' : 'agentTeams.runtime.pauseToEdit')}</p>
      <p className="mt-1.5 text-xs text-[var(--color-text-tertiary)]">{t('agentTeams.runtime.leadSeparate')}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Checkbox label={t('agentTeams.runtime.selectAll')} checked={editableMembers.length > 0 && editableMembers.every(member => selected.includes(member.agentId))} indeterminate={selected.length > 0 && !editableMembers.every(member => selected.includes(member.agentId))} disabled={!canEdit || saving} onChange={event => setSelected(event.target.checked ? editableMembers.map(member => member.agentId) : [])} />
        {batchRuntime && <div className="min-w-[180px] flex-1">
          <ModelSelector appearance="field" fluid effortEditable ariaLabel={t('agentTeams.runtime.batch')} runtimeSelection={batchRuntime} disabled={!canEdit || saving} onRuntimeSelectionChange={runtime => { for (const id of selected) updateDraft(id, runtime) }} onEffortChange={updateSelectedEffort} />
        </div>}
      </div>
      <div className="mt-4 space-y-3">
        {editableMembers.map(member => <div key={member.sessionId} className="flex min-w-0 flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
          <Checkbox label={member.name || member.agentId} checked={selected.includes(member.agentId)} disabled={!canEdit || saving} containerClassName="min-w-0 flex-1" onChange={event => setSelected(ids => event.target.checked ? [...ids, member.agentId] : ids.filter(id => id !== member.agentId))} />
          {drafts[member.agentId] && <div className="min-w-[180px] flex-[1_1_280px]">
            <ModelSelector appearance="field" fluid effortEditable ariaLabel={`${member.name || member.agentId} · ${t('teamPlan.model')}`} runtimeSelection={drafts[member.agentId]} disabled={!canEdit || saving} onRuntimeSelectionChange={runtime => updateDraft(member.agentId, runtime)} />
          </div>}
          {drafts[member.agentId]?.effortLevel && <Button size="sm" variant="ghost" disabled={!canEdit || saving} onClick={() => setDrafts(current => ({ ...current, [member.agentId]: { ...current[member.agentId]!, effortLevel: undefined } }))}>{t('agentTeams.runtime.defaultEffort')}</Button>}
        </div>)}
      </div>
      {saveError && <p id={editorErrorId} role="alert" className="mt-3 whitespace-pre-wrap text-sm text-[var(--color-error)]">{saveError}</p>}
    </Modal>
  </section>
}
