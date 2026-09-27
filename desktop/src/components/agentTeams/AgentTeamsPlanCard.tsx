import { useEffect, useState } from 'react'
import { ModelSelector } from '@/components/controls/ModelSelector'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Modal } from '@/components/ui/Modal'
import { Dropdown } from '@/components/ui/Dropdown'
import './AgentTeamsPlanCard.css'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation, type TranslationKey } from '@/i18n'
import { useChatStore } from '@/stores/chatStore'
import { useTeamPlanStore } from '@/stores/teamPlanStore'
import { useSessionRuntimeStore } from '@/stores/sessionRuntimeStore'
import { useProviderStore } from '@/stores/providerStore'
import type { RuntimeSelection } from '@/types/runtime'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '@/constants/openaiOfficialProvider'
import { isValidTeamMemberName, type TeamPlanRuntime, type TeamPlanMember } from '../../../../src/shared/teamPlan'

function selection(runtime: TeamPlanRuntime): RuntimeSelection {
  return {
    providerId: runtime.providerId === CLAUDE_OFFICIAL_PROVIDER_ID ? null : runtime.providerId,
    modelId: runtime.modelId,
    ...(['low', 'medium', 'high', 'xhigh', 'max'].includes(runtime.effortLevel ?? '')
      ? { effortLevel: runtime.effortLevel as RuntimeSelection['effortLevel'] } : {}),
  }
}

function runtimeFor(selection: RuntimeSelection): TeamPlanRuntime {
  return { ...selection, providerId: selection.providerId ?? CLAUDE_OFFICIAL_PROVIDER_ID }
}

/** Durable plan review is independent of a running chat turn or permission request. */
export function AgentTeamsPlanCard({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const entry = useTeamPlanStore(state => state.bySession[sessionId])
  const { refresh, beginEdit, edit, discard, reapply, save, act } = useTeamPlanStore()
  const providers = useProviderStore(state => state.providers)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [stoppingPlanId, setStoppingPlanId] = useState<string | null>(null)
  const currentLeaderSelection = useSessionRuntimeStore(state => state.selections[sessionId])
  const plan = entry?.plan

  useEffect(() => {
    void refresh(sessionId)
    const interval = window.setInterval(() => void refresh(sessionId), 2000)
    return () => window.clearInterval(interval)
  }, [refresh, sessionId])

  if (!plan) return null
  const leaderRuntime = currentLeaderSelection ? runtimeFor(currentLeaderSelection) : plan.leaderRuntime
  const agents = Object.entries(plan.agentCatalog ?? {}).map(([agentType, definition]) => ({ agentType, ...definition }))
  const draft = entry.draft
  const members = draft?.members ?? plan.members
  const tasks = draft?.tasks ?? plan.tasks
  const activeMember = members.find(member => member.id === activeMemberId) ?? members[0]
  const difficultyLabel = (member: TeamPlanMember) => member.difficulty === 'high' ? t('teamPlan.high') : member.difficulty === 'low' ? t('teamPlan.low') : member.difficulty === 'medium' ? t('teamPlan.medium') : t('teamPlan.unspecified')
  const hasUnassignedTasks = tasks.some(task => !members.some(member => member.id === task.ownerId))
  const invalidNames = members.filter(member => !isValidTeamMemberName(member.name)).map(member => member.name)
  const presetChanged = members.some(member => plan.members.find(previous => previous.id === member.id)?.agentType !== member.agentType)
  const canStop = plan.state === 'launching' || plan.state === 'running' || Boolean(plan.parentPlanId)
  const editable = plan.state === 'review_pending' && !entry.busy && !entry.conflict
  const runtimeName = (runtime: TeamPlanRuntime) => {
    const provider = runtime.providerId === CLAUDE_OFFICIAL_PROVIDER_ID
      ? t('teamPlan.official')
      : providers.find(item => item.id === runtime.providerId)?.name ?? runtime.providerId
    return `${provider} · ${runtime.modelId}`
  }
  const updateMember = (id: string, patch: Partial<TeamPlanMember>) => {
    edit(sessionId, { members: members.map(member => member.id === id ? { ...member, ...patch } : member) })
  }
  const batchRuntime = (runtime: RuntimeSelection) => {
    edit(sessionId, { members: members.map(member => selected.includes(member.id) ? { ...member, runtime: runtimeFor(runtime) } : member) })
  }
  const openEditor = () => {
    beginEdit(sessionId)
    setSelected([])
    setActiveMemberId(null)
    setOpen(true)
  }
  const stateLabel = {
    draft: t('teamPlan.state.draft'),
    review_pending: t('teamPlan.state.review_pending'),
    launching: t('teamPlan.state.launching'),
    running: t('teamPlan.state.running'),
    launch_failed: t('teamPlan.state.launch_failed'),
    cancelled: t('teamPlan.state.cancelled'),
    interrupted: t('teamPlan.state.interrupted'),
  }[plan.state]

  return (
    <section aria-label={t('teamPlan.title')} className="my-4 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="mb-1 text-xs text-[var(--color-text-secondary)]" role="status">{stateLabel} · {t('teamPlan.memberCount', { count: members.length })}</p>
          <h3 className="truncate text-base font-semibold tracking-tight text-[var(--color-text-primary)]">{plan.teamName}</h3>
        </div>
        <Button data-testid="team-plan-open" variant="secondary" onClick={openEditor}>{t('teamPlan.open')}</Button>
      </div>
      <Modal open={open} onClose={() => { if (!entry.busy) setOpen(false) }} title={t('teamPlan.title')} width={1080} className="team-plan-dialog" typography="interface" footer={(
        <div className="team-plan-footer flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--color-text-secondary)]" role="status">{draft?.dirty ? t('teamPlan.unsaved') : t('teamPlan.saved')}</span>
            {plan.state === 'review_pending' && <Button data-testid="team-plan-save" size="base" variant="ghost" disabled={!editable || !draft?.dirty || invalidNames.length > 0} onClick={() => void save(sessionId)}>{t('teamPlan.save')}</Button>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" disabled={entry.busy} onClick={() => setOpen(false)}>{t('teamPlan.close')}</Button>
            {plan.state === 'review_pending' && <>
              <Button variant="ghost" disabled={!editable} onClick={() => void act(sessionId, 'cancel')}>{t('teamPlan.cancel')}</Button>
              <Button data-testid="team-plan-approve" disabled={!editable || presetChanged || hasUnassignedTasks || invalidNames.length > 0} loading={entry.busy} onClick={() => void act(sessionId, 'approve')}>{t('teamPlan.approve')}</Button>
            </>}
            {canStop && <Button data-testid="team-plan-stop" variant="danger-outline" disabled={stoppingPlanId === plan.planId} onClick={() => {
              if (stoppingPlanId === plan.planId) return
              setStoppingPlanId(plan.planId)
              useChatStore.getState().stopGeneration(sessionId)
            }}>{stoppingPlanId === plan.planId ? t('teamPlan.stopping') : t('teamPlan.stop')}</Button>}
            {plan.state === 'launch_failed' && <Button disabled={entry.busy} onClick={() => void act(sessionId, 'retry')}>{t('teamPlan.retry')}</Button>}
          </div>
        </div>
      )}>
        <div className="team-plan-editor">
          <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
            <div className="min-w-0">
              <p className="text-sm text-[var(--color-text-secondary)]">{t('teamPlan.reviewHint')}</p>
              <p className="mt-2 max-w-[65ch] text-xs leading-relaxed text-[var(--color-text-tertiary)]">{t('teamPlan.description')}</p>
            </div>
            <span className="rounded-full bg-[var(--color-surface-container)] px-3 py-1 text-xs text-[var(--color-text-secondary)]">{stateLabel}</span>
          </div>
          {plan.launch?.error && <p role="alert" className="mb-4 text-sm text-[var(--color-error)]">{plan.launch.error}</p>}
          {entry.error && <p role="alert" className="mb-4 text-sm text-[var(--color-error)]">{entry.error}</p>}
          {plan.state === 'review_pending' && invalidNames.length > 0 && <p role="alert" className="mb-4 text-sm text-[var(--color-error)]">{t('teamPlan.invalidMemberNames', { names: invalidNames.join(', ') })}</p>}
          {entry.conflict && <div role="alert" className="mb-4 space-y-2 rounded-[var(--radius-md)] bg-[var(--color-warning-container)] p-3 text-[var(--color-on-warning-container)]">
            <p>{t('teamPlan.conflict')}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => discard(sessionId)}>{t('teamPlan.reload')}</Button>
              {draft?.planId === plan.planId && plan.state === 'review_pending' && <Button data-testid="team-plan-reapply" variant="secondary" onClick={() => reapply(sessionId)}>{t('teamPlan.reapply')}</Button>}
            </div>
          </div>}
          <div className="grid min-w-0 gap-6 md:grid-cols-[244px_minmax(0,1fr)] md:gap-8">
            <aside className="min-w-0 md:border-r md:border-[var(--color-border-separator)] md:pr-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="text-xs font-medium text-[var(--color-text-secondary)]">{t('teamPlan.roster')} <span className="ml-1 font-mono text-[var(--color-text-tertiary)]">{members.length}</span></h4>
                {plan.state === 'review_pending' && <Checkbox size="sm" label={t('teamPlan.selectAll')} labelHidden checked={members.length > 0 && members.every(member => selected.includes(member.id))} indeterminate={selected.length > 0 && !members.every(member => selected.includes(member.id))} disabled={!editable} onChange={event => setSelected(event.target.checked ? members.map(member => member.id) : [])} />}
              </div>
              <nav aria-label={t('teamPlan.roster')} className="grid min-w-0 gap-1.5">
                {members.map((member, index) => <div key={member.id} className={`team-plan-member flex min-w-0 items-center gap-2 rounded-[var(--radius-lg)] p-2 ${member.id === activeMember?.id ? 'bg-[var(--color-surface-container)]' : ''}`}>
                  {plan.state === 'review_pending' && <Checkbox label={member.name} labelHidden size="sm" disabled={!editable} checked={selected.includes(member.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, member.id] : ids.filter(id => id !== member.id))} />}
                  <button type="button" aria-label={t('teamPlan.configureMember', { name: member.name })} aria-current={member.id === activeMember?.id ? 'true' : undefined} onClick={() => setActiveMemberId(member.id)} className="flex min-w-0 flex-1 items-start gap-3 rounded-[var(--radius-sm)] py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">
                    <span aria-hidden="true" className={`mt-0.5 font-mono text-[11px] ${member.id === activeMember?.id ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)]'}`}>{String(index + 1).padStart(2, '0')}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{member.name}</span>
                      <span className="mt-1 block truncate text-[11px] text-[var(--color-text-secondary)]">{runtimeName(member.runtime)}</span>
                    </span>
                  </button>
                </div>)}
              </nav>
              <div className="mt-6 border-t border-[var(--color-border-separator)] pt-4">
                <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{t('teamPlan.leader')}: {runtimeName(leaderRuntime)}</p>
              </div>
              {plan.state === 'review_pending' && <div className="mt-4 space-y-3">
                {selected.length > 0 && <div className="team-plan-batch space-y-3 rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] p-3">
                  <p className="text-xs font-medium text-[var(--color-text-primary)]">{t('teamPlan.selectedCount', { count: selected.length })}</p>
                  <ModelSelector appearance="field" fluid ariaLabel={t('teamPlan.batch')} runtimeSelection={selection(members.find(member => selected.includes(member.id))?.runtime ?? leaderRuntime)} onRuntimeSelectionChange={batchRuntime} disabled={!editable} />
                  <Button block size="base" variant="ghost" disabled={!editable} onClick={() => batchRuntime(selection(leaderRuntime))}>{t('teamPlan.followLeader')}</Button>
                </div>}
                <Button block size="base" variant="ghost" disabled={!editable} onClick={() => edit(sessionId, { members: members.map(member => ({ ...member, runtime: member.suggestedRuntime ?? member.runtime })) })}>{t('teamPlan.restore')}</Button>
              </div>}
            </aside>
            <div className="min-w-0">
              {activeMember && <section key={activeMember.id} className="team-plan-detail" aria-label={t('teamPlan.configureMember', { name: activeMember.name })}>
                <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="mb-1 text-xs text-[var(--color-text-tertiary)]">{t('teamPlan.assignment')}</p>
                    <h3 className="text-xl font-semibold tracking-tight text-[var(--color-text-primary)]">{activeMember.name}</h3>
                  </div>
                  <span className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">{t('teamPlan.difficulty')}: {difficultyLabel(activeMember)}</span>
                </div>
                <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                  <div className="min-w-0 space-y-2">
                    <p className="text-xs font-medium text-[var(--color-text-secondary)]">{t('teamPlan.agent')}</p>
                    <Dropdown className="w-full" width="100%" maxHeight={280} label={`${activeMember.name} · ${t('teamPlan.agent')}`} value={activeMember.agentType} items={[
                      ...(!agents.some(agent => agent.agentType === activeMember.agentType) ? [{ value: activeMember.agentType, label: activeMember.agentType }] : []),
                      ...agents.map(agent => ({ value: agent.agentType, label: agent.agentType, description: agent.source ? t(`settings.agents.source.${agent.source}` as TranslationKey) : agent.description })),
                    ]} onChange={agentType => updateMember(activeMember.id, { agentType })} trigger={<Button block variant="secondary" size="lg" aria-label={`${activeMember.name} · ${t('teamPlan.agent')}`} disabled={!editable || agents.length === 0}><span className="flex min-w-0 flex-1 items-center justify-between gap-2"><span className="truncate">{activeMember.agentType}</span><span aria-hidden="true" className="team-plan-chevron" /></span></Button>} />
                  </div>
                  <div className="min-w-0 space-y-2">
                    <p className="text-xs font-medium text-[var(--color-text-secondary)]">{t('teamPlan.model')}</p>
                    <ModelSelector appearance="field" fluid ariaLabel={`${activeMember.name} · ${t('teamPlan.model')}`} runtimeSelection={selection(activeMember.runtime)} onRuntimeSelectionChange={runtime => updateMember(activeMember.id, { runtime: runtimeFor(runtime) })} disabled={!editable} />
                  </div>
                </div>
                {presetChanged && <p role="status" className="mt-3 text-xs text-[var(--color-text-secondary)]">{t('teamPlan.savePreset')}</p>}
                <div className="my-6 border-l-2 border-[var(--color-border)] pl-4">
                  {activeMember.reason && <p className="mb-2 text-sm leading-relaxed text-[var(--color-text-primary)]">{activeMember.reason}</p>}
                  <p className="text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">{t('teamPlan.costHint')}</p>
                </div>
                <details open className="group border-y border-[var(--color-border-separator)] py-3">
                  <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">{t('teamPlan.memberBrief')}</summary>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text-secondary)]">{activeMember.prompt}</p>
                </details>
              </section>}
              <section className="mt-6" aria-label={t('teamPlan.allTasks')}>
                <div className="mb-2 flex items-center justify-between"><h4 className="text-xs font-medium text-[var(--color-text-secondary)]">{t('teamPlan.allTasks')}</h4><span className="font-mono text-xs text-[var(--color-text-tertiary)]">{tasks.length}</span></div>
                {tasks.length === 0 && <p className="py-5 text-sm text-[var(--color-text-tertiary)]">{t('teamPlan.noTasks')}</p>}
                <div className="divide-y divide-[var(--color-border-separator)]">
                  {tasks.map((task, index) => {
                    const owner = members.find(member => member.id === task.ownerId)
                    return <div key={task.id} className="grid min-w-0 gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_160px]">
                      <div className="flex min-w-0 gap-3">
                        <span className="mt-0.5 shrink-0 font-mono text-[11px] text-[var(--color-text-tertiary)]">{String(index + 1).padStart(2, '0')}</span>
                        <div className="min-w-0"><p className="text-sm font-medium leading-relaxed text-[var(--color-text-primary)]">{task.subject}</p>
                          {task.description && <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">{task.description}</p>}
                          {task.dependencies.length > 0 && <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">{t('teamPlan.dependencies')}: {task.dependencies.map(id => tasks.find(row => row.id === id)?.subject ?? id).join(', ')}</p>}
                        </div>
                      </div>
                      <div className="min-w-0 space-y-2">
                        <p className="text-[11px] text-[var(--color-text-tertiary)]">{t('teamPlan.owner')}</p>
                        <Dropdown className="w-full" width="100%" maxHeight={200} placement="top" label={`${task.subject} · ${t('teamPlan.owner')}`} value={owner?.id ?? ''} items={[{ value: '', label: t('teamPlan.unassigned'), disabled: true }, ...members.map(member => ({ value: member.id, label: member.name, description: member.agentType }))]} onChange={ownerId => edit(sessionId, { tasks: tasks.map(row => row.id === task.id ? { ...row, ownerId: ownerId || undefined } : row) })} trigger={<Button block size="base" variant="secondary" aria-label={`${task.subject} · ${t('teamPlan.owner')}`} aria-invalid={!owner || undefined} aria-describedby={!owner ? `team-plan-unassigned-${task.id}` : undefined} disabled={!editable}><span className="flex min-w-0 flex-1 items-center justify-between gap-2"><span className="truncate">{owner?.name ?? t('teamPlan.unassigned')}</span><span aria-hidden="true" className="team-plan-chevron" /></span></Button>} />
                        {plan.state === 'review_pending' && !owner && <p id={`team-plan-unassigned-${task.id}`} role="alert" className="text-xs text-[var(--color-error)]">{t('teamPlan.assignRequired')}</p>}
                      </div>
                    </div>
                  })}
                </div>
              </section>
              {plan.state === 'review_pending' && <details className="mt-4 border-t border-[var(--color-border-separator)] pt-4">
                <summary className="cursor-pointer text-xs text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">{t('teamPlan.return')}</summary>
                <div className="mt-4 space-y-3">
                  <TextArea label={t('teamPlan.feedback')} value={feedback} disabled={!editable} onChange={event => setFeedback(event.target.value)} rows={2} />
                  <Button variant="secondary" disabled={!editable || !feedback.trim()} onClick={() => void act(sessionId, 'return', feedback.trim())}>{t('teamPlan.return')}</Button>
                </div>
              </details>}
            </div>
          </div>
        </div>
      </Modal>
    </section>
  )
}
