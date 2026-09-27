import { api } from '@/api/client'
import type { TeamPlanRecord, TeamPlanMember, TeamPlanTask } from '../../../src/shared/teamPlan'

export type TeamPlanAction = 'approve' | 'return' | 'cancel' | 'retry'
export type TeamPlanEdits = { members: TeamPlanMember[]; tasks: TeamPlanTask[] }

function identity(plan: TeamPlanRecord) {
  return {
    sessionId: plan.sessionId,
    planId: plan.planId,
    incarnationId: plan.incarnationId,
    expectedRevision: plan.revision,
  }
}

export const teamPlansApi = {
  get(sessionId: string) {
    return api.get<{ plan: TeamPlanRecord | null }>(`/api/teams/session/${encodeURIComponent(sessionId)}/plan`)
  },
  save(plan: TeamPlanRecord, edits: TeamPlanEdits) {
    return api.patch<{ plan: TeamPlanRecord }>(`/api/teams/${encodeURIComponent(plan.teamName)}/plan`, {
      ...identity(plan),
      members: edits.members.flatMap(({ id, agentType, runtime }) => {
        const previous = plan.members.find(member => member.id === id)
        const changedAgent = previous?.agentType !== agentType
        const changedRuntime = JSON.stringify(previous?.runtime) !== JSON.stringify(runtime)
        return changedAgent || changedRuntime ? [{ id, ...(changedAgent ? { agentType } : {}), ...(changedRuntime ? { runtime } : {}) }] : []
      }),
      tasks: edits.tasks.filter(task => plan.tasks.find(previous => previous.id === task.id)?.ownerId !== task.ownerId)
        .map(({ id, ownerId }) => ({ id, ownerId })),
    })
  },
  act(plan: TeamPlanRecord, action: TeamPlanAction, requestId: string, feedback?: string) {
    return api.post<{ plan: TeamPlanRecord }>(`/api/teams/${encodeURIComponent(plan.teamName)}/plan/${action}`, {
      ...identity(plan), requestId, ...(feedback ? { feedback } : {}),
    })
  },
}
