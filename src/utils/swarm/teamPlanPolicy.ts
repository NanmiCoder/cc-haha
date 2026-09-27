import type { TeamPlanRuntime } from '../../shared/teamPlan.js'

/** Desktop controls this at process launch, never through a model tool argument. */
export function isTeamReviewRequired(): boolean {
  return process.env.CC_HAHA_TEAM_REVIEW_REQUIRED === '1'
}

export function getTeamLeaderRuntime(fallbackModel: string): TeamPlanRuntime {
  let value: unknown
  try {
    value = JSON.parse(process.env.CC_HAHA_TEAM_LEADER_RUNTIME ?? 'null')
  } catch {
    throw new Error('The desktop team runtime is invalid. Reopen the session before planning a team.')
  }
  if (!value || typeof value !== 'object' || !('providerId' in value)
    || typeof value.providerId !== 'string' || !value.providerId.trim()) {
    throw new Error('The desktop team provider is unavailable. Select a provider before planning a team.')
  }
  const modelId = fallbackModel.trim() || ('modelId' in value && typeof value.modelId === 'string'
    ? value.modelId.trim() : '')
  if (!modelId) throw new Error('Select a leader model before planning a team.')
  return {
    providerId: value.providerId,
    modelId,
    ...('effortLevel' in value && typeof value.effortLevel === 'string'
      ? { effortLevel: value.effortLevel } : {}),
  }
}
