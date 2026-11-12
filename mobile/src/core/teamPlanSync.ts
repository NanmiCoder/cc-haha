import { ApiError, type ApiClient } from './client'
import {
  actOnTeamPlan,
  actionKey,
  editTeamPlan,
  loadTeamPlan,
  newerTeamPlan,
  teamPlanErrorText,
  type TeamPlanAction,
  type TeamPlanEdit,
  type TeamPlanRecord,
} from './teamPlan'

export type TeamPlanPending = 'edit' | TeamPlanAction
export type TeamPlanSnapshot = {
  plan: TeamPlanRecord | null
  pending: TeamPlanPending | null
  error: string
}

/**
 * The plan has changed on the computer (edited elsewhere, already launching) or is gone (team deleted): 
 * the copy in hand can no longer be used and must be reread.
 */
const isStale = (error: unknown) => error instanceof ApiError && (error.status === 409 || error.status === 404)

/**
 * A session's team plan: reads, edits and actions all go through here. Changes save directly to the computer, 
 * and there is no "unsaved" draft on the phone; on failure the original plan is kept with a reason.
 */
export class TeamPlanSync {
  #snapshot: TeamPlanSnapshot = { plan: null, pending: null, error: '' }
  #listeners = new Set<() => void>()
  #loads = 0
  // Retrying the same action on the same revision reuses the requestId, so the computer handles it idempotently and never launches twice.
  #requestIds = new Map<string, string>()

  constructor(
    private readonly client: Pick<ApiClient, 'get' | 'patch' | 'post'>,
    private readonly sessionId: string,
    private readonly newRequestId: () => string
  ) {}

  get snapshot() {
    return this.#snapshot
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #set(patch: Partial<TeamPlanSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const listener of this.#listeners) listener()
  }

  #accept(next: TeamPlanRecord | null) {
    const current = this.#snapshot.plan
    const plan = newerTeamPlan(current, next)
    if (plan === current) return
    // The plan or state changed, so the error from the previous action no longer applies.
    const moved = plan?.planId !== current?.planId || plan?.state !== current?.state
    this.#set({ plan, ...(moved ? { error: '' } : {}) })
  }

  /** Only use the last read started: older results arriving later (including the plan before team deletion) must not overwrite newer ones. */
  async load(signal?: AbortSignal) {
    const load = ++this.#loads
    try {
      const next = await loadTeamPlan(this.client, this.sessionId, signal)
      if (load === this.#loads && !signal?.aborted) this.#accept(next)
    } catch {
      // If it cannot be read keep the last result without disturbing chat; the next signal or reconnect reads again.
    }
  }

  async #run(kind: TeamPlanPending, task: (plan: TeamPlanRecord) => Promise<TeamPlanRecord>) {
    const plan = this.#snapshot.plan
    if (!plan || this.#snapshot.pending) return false
    this.#set({ pending: kind, error: '' })
    try {
      const next = await task(plan)
      this.#set({ pending: null })
      this.#accept(next)
      return true
    } catch (error) {
      this.#set({ pending: null, error: teamPlanErrorText(error) })
      if (isStale(error)) void this.load()
      return false
    }
  }

  edit(edit: TeamPlanEdit) {
    return this.#run('edit', (plan) => editTeamPlan(this.client, plan, edit))
  }

  act(action: TeamPlanAction, feedback?: string) {
    return this.#run(action, async (plan) => {
      const key = actionKey(plan, action)
      const requestId = this.#requestIds.get(key) ?? this.newRequestId()
      this.#requestIds.set(key, requestId)
      const next = await actOnTeamPlan(this.client, plan, action, requestId, feedback)
      this.#requestIds.delete(key)
      return next
    })
  }
}
