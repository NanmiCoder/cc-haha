import { z } from 'zod/v4'
import { teamPlanRuntimeSchema, type TeamPlanAction, type TeamPlanIdentity, type TeamPlanRecord } from '../../shared/teamPlan.js'
import { approveTeamPlan, findTeamPlanForSession, mutateTeamPlan, readTeamPlan, replaceTeamPlan, TeamPlanError } from '../../utils/swarm/teamPlanStore.js'

const identitySchema = z.object({
  sessionId: z.string().min(1), planId: z.string().min(1), incarnationId: z.string().min(1), expectedRevision: z.number().int().positive(),
})
export const teamPlanActionSchema = identitySchema.extend({ requestId: z.string().min(1), feedback: z.string().optional() })
export const teamPlanPatchRequestSchema = identitySchema.extend({
  members: z.array(z.object({ id: z.string().min(1), agentType: z.string().min(1).optional(), runtime: teamPlanRuntimeSchema.optional() }).strict()).optional(),
  tasks: z.array(z.object({ id: z.string().min(1), ownerId: z.string().min(1) }).strict()).optional(),
}).strict()

export type TeamPlanRuntimeAdapter = {
  validate(plan: TeamPlanRecord): Promise<TeamPlanRecord>
  launch(plan: TeamPlanRecord): Promise<{ memberIds: Record<string, string> }>
  stop(planId: string): Promise<void>
  isRunning?(planId: string): boolean | Promise<boolean>
  notifyLeader?(plan: TeamPlanRecord, kind: 'approved' | 'returned' | 'cancelled'): Promise<void>
}
const defaultRuntime: TeamPlanRuntimeAdapter = {
  isRunning: async id => (await import('./teamPlanRuntime.js')).isTeamPlanRuntimeActive(id),
  validate: async plan => (await import('./teamPlanRuntime.js')).validateTeamPlanRuntime(plan),
  launch: async plan => (await import('./teamPlanRuntime.js')).launchTeamPlanRuntime(plan),
  notifyLeader: async (plan, kind) => { await (await import('./teamPlanRuntime.js')).notifyTeamPlanLeader(plan, kind) },
  stop: async id => { await (await import('./teamPlanRuntime.js')).stopTeamPlanRuntime(id) },
}

/** Only trusted HTTP/UI actions call approve; model tools import the draft store only. */
export class TeamPlanService {
  private launches = new Map<string, Promise<void>>()
  constructor(private runtime: TeamPlanRuntimeAdapter = defaultRuntime) {}
  async getForSession(sessionId: string): Promise<TeamPlanRecord | null> {
    const plan = await findTeamPlanForSession(sessionId)
    // A server restart lost ownership of an unfinished launch. Never silently replay it.
    if (plan?.state === 'launching' && !this.launches.has(plan.planId)) {
      return mutateTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, current => ({ ...current, state: 'interrupted', launch: { ...current.launch, status: 'failed', error: 'Launch ownership was lost. Work may have started and will not be replayed.' } }))
    }
    if (plan?.state === 'running' && this.runtime.isRunning && !await this.runtime.isRunning(plan.planId)) {
      return mutateTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, current => ({ ...current, state: 'interrupted', launch: { ...current.launch, status: 'failed', error: 'The worker runtime was interrupted. Started work will not be replayed.' } }))
    }
    return plan
  }
  async update(teamName: string, identity: TeamPlanIdentity, patch: { members?: Array<{ id: string; agentType?: string; runtime?: TeamPlanRecord['leaderRuntime'] }>; tasks?: Array<{ id: string; ownerId: string }> }): Promise<TeamPlanRecord> {
    const current = await readTeamPlan(teamName)
    if (!current) throw new TeamPlanError('Plan not found', 404)
    for (const member of patch.members ?? []) if (!current.members.some(item => item.id === member.id)) throw new TeamPlanError('Unknown member', 400)
    for (const task of patch.tasks ?? []) if (!current.tasks.some(item => item.id === task.id)) throw new TeamPlanError('Unknown task', 400)
    const members = current.members.map(member => {
      const edit = patch.members?.find(item => item.id === member.id)
      if (!edit) return member
      const agentType = edit.agentType ?? member.agentType
      const snapshot = current.agentCatalog?.[agentType]
      if (!snapshot) throw new TeamPlanError('Agent preset is unavailable', 400)
      const presetChanged = agentType !== member.agentType
      const presetModel = snapshot.model && snapshot.model !== 'inherit' ? snapshot.model : current.leaderRuntime.modelId
      const suggestedRuntime = { providerId: member.runtime.providerId, modelId: presetModel, ...(snapshot.effortLevel ? { effortLevel: snapshot.effortLevel } : {}) }
      return { ...member, agentType, agentSnapshot: structuredClone(snapshot),
        ...(presetChanged ? { suggestedRuntime } : {}),
        ...(presetChanged && !edit.runtime && member.runtimeSource !== 'human' ? { runtime: suggestedRuntime } : {}),
        ...(edit.runtime ? { runtime: edit.runtime, runtimeSource: 'human' } : {}),
      }
    })
    const tasks = current.tasks.map(task => ({ ...task, ...patch.tasks?.find(item => item.id === task.id) }))
    return replaceTeamPlan(teamName, identity, { members, tasks }, { preserveReview: true })
  }
  private start(plan: TeamPlanRecord): void {
    const operation = this.runtime.launch(plan).then(async result => {
      const current = await readTeamPlan(plan.teamName)
      if (!current || current.planId !== plan.planId || current.state !== 'launching') return
      await mutateTeamPlan(plan.teamName, { ...current, expectedRevision: current.revision }, item => ({ ...item, state: 'running', launch: { ...item.launch, status: 'running', memberIds: result.memberIds } }))
    }).catch(async error => {
      await this.runtime.stop(plan.planId).catch(() => {})
      const current = await readTeamPlan(plan.teamName)
      if (!current || current.planId !== plan.planId || current.state !== 'launching') return
      await mutateTeamPlan(plan.teamName, { ...current, expectedRevision: current.revision }, item => ({ ...item, state: error && typeof error === 'object' && 'executionStarted' in error && error.executionStarted === true ? 'interrupted' : 'launch_failed', launch: { ...item.launch, status: 'failed', error: error instanceof Error ? error.message : String(error) } }))
    }).finally(() => { this.launches.delete(plan.planId) })
    this.launches.set(plan.planId, operation)
    void operation.catch(() => {})
  }
  async approve(teamName: string, action: TeamPlanAction): Promise<TeamPlanRecord> {
    const current = await readTeamPlan(teamName)
    if (!current) throw new TeamPlanError('Plan not found', 404)
    // Idempotent replay still goes through store identity/incarnation checks.
    let validated = current
    if (current.approvedSnapshot?.requestId !== action.requestId) {
      if (current.planId !== action.planId || current.sessionId !== action.sessionId || current.incarnationId !== action.incarnationId || current.revision !== action.expectedRevision) throw new TeamPlanError('Plan changed; refresh before continuing')
      try { validated = await this.runtime.validate(current) }
      catch (error) { throw new TeamPlanError(error instanceof Error ? error.message : 'Team configuration is unavailable', 400) }
    }
    const result = await approveTeamPlan(teamName, action, action.requestId, validated)
    if (result.committed) this.start(result.plan)
    return result.plan
  }
  async action(teamName: string, kind: 'return' | 'cancel' | 'retry', action: TeamPlanAction): Promise<TeamPlanRecord> {
    if (kind === 'retry') {
      const plan = await mutateTeamPlan(teamName, action, current => {
        if (current.state !== 'launch_failed') throw new TeamPlanError('Only failed launches can retry')
        return { ...current, state: 'review_pending', approvedSnapshot: undefined, launch: undefined }
      })
      return plan
    }
    const plan = await mutateTeamPlan(teamName, action, current => {
      if (kind === 'return' && current.state !== 'draft' && current.state !== 'review_pending') throw new TeamPlanError('Only a pending plan can return to planning')
      if (kind === 'cancel' && current.state === 'running') throw new TeamPlanError('Use the running team stop control')
      return { ...current, state: kind === 'cancel' ? 'cancelled' : 'draft', feedback: action.feedback }
    })
    if (kind === 'cancel') await this.runtime.stop(plan.planId)
    try {
      await this.runtime.notifyLeader?.(plan, kind === 'cancel' ? 'cancelled' : 'returned')
    } catch (error) {
      // The control transition already committed. Preserve the delivery failure
      // on the durable draft instead of inviting a duplicate control action.
      return mutateTeamPlan(teamName, { ...plan, expectedRevision: plan.revision }, current => ({ ...current, controlDeliveryError: error instanceof Error ? error.message : String(error) }))
    }
    return plan
  }
}
export const teamPlanService = new TeamPlanService()
