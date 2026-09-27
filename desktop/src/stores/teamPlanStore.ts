import { create } from 'zustand'
import { ApiError } from '@/api/client'
import { teamPlansApi, type TeamPlanAction, type TeamPlanEdits } from '@/api/teamPlans'
import type { TeamPlanRecord } from '../../../src/shared/teamPlan'

export type TeamPlanDraft = TeamPlanEdits & { planId: string; revision: number; dirty: boolean; baseline: TeamPlanEdits }
export type TeamPlanEntry = {
  plan: TeamPlanRecord | null
  draft?: TeamPlanDraft
  loading: boolean
  busy: boolean
  error: string | null
  conflict: boolean
}
const EMPTY: TeamPlanEntry = { plan: null, loading: false, busy: false, error: null, conflict: false }
const reads = new Map<string, Promise<void>>()
const epochs = new Map<string, number>()
const actionRequests = new Map<string, string>()
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function draftFor(plan: TeamPlanRecord): TeamPlanDraft {
  return { planId: plan.planId, revision: plan.revision, members: clone(plan.members), tasks: clone(plan.tasks), baseline: { members: clone(plan.members), tasks: clone(plan.tasks) }, dirty: false }
}

function reconcile(entry: TeamPlanEntry, plan: TeamPlanRecord | null): TeamPlanEntry {
  const draft = entry.draft
  const changed = !!draft && (!plan || plan.planId !== draft.planId || plan.revision !== draft.revision)
  return {
    ...entry, plan, loading: false,
    draft: changed && !draft.dirty ? (plan ? draftFor(plan) : undefined) : draft,
    conflict: changed && !!draft?.dirty,
  }
}

type TeamPlanState = {
  bySession: Record<string, TeamPlanEntry>
  refresh: (sessionId: string) => Promise<void>
  beginEdit: (sessionId: string) => void
  edit: (sessionId: string, edits: Partial<TeamPlanEdits>) => void
  discard: (sessionId: string) => void
  reapply: (sessionId: string) => void
  save: (sessionId: string) => Promise<boolean>
  act: (sessionId: string, action: TeamPlanAction, feedback?: string) => Promise<boolean>
}

export const useTeamPlanStore = create<TeamPlanState>((set, get) => {
  const update = (id: string, fn: (entry: TeamPlanEntry) => TeamPlanEntry) => set(state => ({
    bySession: { ...state.bySession, [id]: fn(state.bySession[id] ?? EMPTY) },
  }))
  const fail = async (id: string, error: unknown) => {
    update(id, entry => ({ ...entry, busy: false, error: error instanceof Error ? error.message : String(error) }))
    if (error instanceof ApiError && error.status === 409) {
      await reads.get(id)
      await get().refresh(id)
    }
  }
  return {
    bySession: {},
    refresh: (id) => {
      const pending = reads.get(id)
      if (pending) return pending
      const epoch = epochs.get(id) ?? 0
      update(id, entry => ({ ...entry, loading: true }))
      const request = (async () => {
        try {
          const { plan } = await teamPlansApi.get(id)
          if (epoch !== (epochs.get(id) ?? 0)) return
          update(id, entry => reconcile(entry, plan))
        } catch (error) {
          if (epoch !== (epochs.get(id) ?? 0)) return
          update(id, entry => ({ ...entry, loading: false, error: error instanceof Error ? error.message : String(error) }))
        } finally {
          reads.delete(id)
        }
      })()
      reads.set(id, request)
      return request
    },
    beginEdit: id => update(id, entry => ({ ...entry, draft: entry.draft ?? (entry.plan ? draftFor(entry.plan) : undefined) })),
    edit: (id, edits) => update(id, entry => entry.draft
      ? { ...entry, draft: { ...entry.draft, ...clone(edits), dirty: true }, error: null }
      : entry),
    discard: id => update(id, entry => ({ ...entry, draft: entry.plan ? draftFor(entry.plan) : undefined, conflict: false, error: null })),
    reapply: id => update(id, entry => {
      if (!entry.plan || !entry.draft || entry.plan.planId !== entry.draft.planId) return entry
      const previous = entry.draft
      return {
        ...entry, conflict: false, error: null,
        draft: {
          ...draftFor(entry.plan), dirty: true,
          members: entry.plan.members.map(member => {
            const old = previous.members.find(row => row.id === member.id)
            const baseline = previous.baseline.members.find(row => row.id === member.id)
            if (!old || !baseline) return member
            return {
              ...member,
              ...(old.agentType !== baseline.agentType ? { agentType: old.agentType } : {}),
              ...(JSON.stringify(old.runtime) !== JSON.stringify(baseline.runtime) ? { runtime: old.runtime } : {}),
            }
          }),
          tasks: entry.plan.tasks.map(task => {
            const old = previous.tasks.find(row => row.id === task.id)
            const baseline = previous.baseline.tasks.find(row => row.id === task.id)
            return old && baseline && old.ownerId !== baseline.ownerId ? { ...task, ownerId: old.ownerId } : task
          }),
        },
      }
    }),
    save: async id => {
      const entry = get().bySession[id]
      if (!entry?.plan || !entry.draft || entry.busy || entry.conflict) return false
      if (!entry.draft.dirty) return true
      epochs.set(id, (epochs.get(id) ?? 0) + 1)
      update(id, current => ({ ...current, busy: true, error: null }))
      try {
        const { plan } = await teamPlansApi.save(entry.plan, { members: entry.draft.members, tasks: entry.draft.tasks })
        // Polls started during this mutation may still carry the previous revision.
        epochs.set(id, (epochs.get(id) ?? 0) + 1)
        update(id, current => ({ ...current, plan, draft: draftFor(plan), conflict: false, busy: false, loading: false }))
        return true
      } catch (error) {
        await fail(id, error)
        return false
      }
    },
    act: async (id, action, feedback) => {
      let entry = get().bySession[id]
      if (!entry?.plan || entry.busy || entry.conflict) return false
      if ((action === 'approve' || action === 'retry') && entry.draft?.dirty) {
        if (!await get().save(id)) return false
        entry = get().bySession[id]
      }
      if (!entry?.plan) return false
      const plan = entry.plan
      const key = `${id}:${plan.planId}:${plan.revision}:${action}`
      const requestId = actionRequests.get(key) ?? crypto.randomUUID()
      actionRequests.set(key, requestId)
      epochs.set(id, (epochs.get(id) ?? 0) + 1)
      update(id, current => ({ ...current, busy: true, error: null }))
      try {
        const { plan: next } = await teamPlansApi.act(plan, action, requestId, feedback)
        actionRequests.delete(key)
        epochs.set(id, (epochs.get(id) ?? 0) + 1)
        update(id, current => ({ ...current, plan: next, draft: draftFor(next), busy: false, loading: false, conflict: false }))
        return true
      } catch (error) {
        await fail(id, error)
        return false
      }
    },
  }
})
