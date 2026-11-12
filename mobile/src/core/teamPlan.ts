import type {
  TeamPlanMember,
  TeamPlanRecord,
  TeamPlanRuntime,
  TeamPlanTask,
} from '../../../src/shared/teamPlan'
import type { ApiClient } from './client'
import { OFFICIAL_RUNTIME_SOURCES } from './runtimeCatalog'
import type { RuntimeConfig } from './types'
import { plural } from './plural'

export type { TeamPlanMember, TeamPlanRecord, TeamPlanRuntime, TeamPlanTask }
export type TeamPlanAction = 'approve' | 'return' | 'cancel' | 'retry' | 'end'
export type TeamPlanEdit = {
  members?: { id: string; agentType?: string; runtime?: TeamPlanRuntime }[]
  tasks?: { id: string; ownerId: string }[]
}

/** The official Claude source is written as this id in team plans; mobile run configuration represents it with null (same as desktop). */
export const CLAUDE_OFFICIAL_RUNTIME = 'claude-official'

export function teamRuntimeConfig(runtime: TeamPlanRuntime): RuntimeConfig {
  return {
    providerId: runtime.providerId === CLAUDE_OFFICIAL_RUNTIME ? null : runtime.providerId,
    modelId: runtime.modelId,
    ...(runtime.effortLevel ? { effortLevel: runtime.effortLevel } : {}),
  }
}

export function teamRuntime(config: RuntimeConfig): TeamPlanRuntime {
  return {
    providerId: config.providerId ?? CLAUDE_OFFICIAL_RUNTIME,
    modelId: config.modelId,
    ...(config.effortLevel ? { effortLevel: config.effortLevel } : {}),
    ...(config.openAIFastMode !== undefined ? { openAIFastMode: config.openAIFastMode } : {}),
  }
}

/** Source name: first look up providers saved on the computer, then official sources; if unrecognized show the id as is without guessing. */
export function teamRuntimeSource(runtime: TeamPlanRuntime, providers: readonly { id: string; name: string }[] = []) {
  const id = teamRuntimeConfig(runtime).providerId
  return (
    providers.find((provider) => provider.id === id)?.name ??
    OFFICIAL_RUNTIME_SOURCES.find((official) => official.id === id)?.name ??
    runtime.providerId
  )
}

/** "Source · model id", consistent with the desktop team card. */
export const teamRuntimeLabel = (runtime: TeamPlanRuntime, providers: readonly { id: string; name: string }[] = []) =>
  `${teamRuntimeSource(runtime, providers)} · ${runtime.modelId}`

export const sameTeamRuntime = (a?: TeamPlanRuntime, b?: TeamPlanRuntime) =>
  !!a &&
  !!b &&
  a.providerId === b.providerId &&
  a.modelId === b.modelId &&
  (a.effortLevel ?? '') === (b.effortLevel ?? '')

/**
 * Whether the phone should offer an action entry for this plan: 
 * - review: the lead submitted the team and the turn is paused; work starts only after human approval (stuck forever if unhandled).
 * - failed: launch failed; can be re-reviewed or canceled.
 * - interrupted: lost at runtime; only a human can end the team.
 * Other states (planning, launching, running, canceled) need nothing from a human.
 */
export type TeamPlanSurface = 'review' | 'failed' | 'interrupted'
export function teamPlanSurface(plan: TeamPlanRecord | null | undefined): TeamPlanSurface | null {
  switch (plan?.state) {
    case 'review_pending':
      return 'review'
    case 'launch_failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    default:
      return null
  }
}

/**
 * A one-line hint when the plan was just approved (awaiting approval → launching/running). The review card disappears after approval, 
 * and without this line the screen would show nothing. Plans already running on session open, or a different plan, do not count as just approved.
 */
export function teamLaunchNotice(
  previous: Pick<TeamPlanRecord, 'planId' | 'state'> | null | undefined,
  next: Pick<TeamPlanRecord, 'planId' | 'state' | 'members' | 'parentPlanId' | 'approvedSnapshot'> | null | undefined
) {
  if (!previous || !next || previous.planId !== next.planId || previous.state !== 'review_pending') return null
  if (next.state !== 'launching' && next.state !== 'running') return null
  const count = (next.approvedSnapshot?.members ?? next.members).length
  return next.parentPlanId ? `Approved, adding ${plural(count, 'member')}` : `Approved, launching ${plural(count, 'member')}`
}

/** What must be filled in before approval, matching the launch validation on the computer: every task has an owner and every member has a task. */
export function teamPlanReview(plan: Pick<TeamPlanRecord, 'members' | 'tasks'>) {
  const unassigned = plan.tasks.filter((task) => !plan.members.some((member) => member.id === task.ownerId))
  const idle = plan.members.filter((member) => !plan.tasks.some((task) => task.ownerId === member.id))
  const blocker = unassigned.length
    ? `${plural(unassigned.length, 'task')} still ${unassigned.length === 1 ? 'has' : 'have'} no owner.`
    : idle.length
      ? `${idle.map((member) => member.name).join(', ')} has no task assigned; assign one or send it back for the lead to adjust.`
      : !plan.members.length
        ? 'The plan has no members yet.'
        : undefined
  return { unassigned, idle, blocker }
}

export const memberTasks = (plan: Pick<TeamPlanRecord, 'tasks'>, memberId: string) =>
  plan.tasks.filter((task) => task.ownerId === memberId)

const DIFFICULTY: Record<string, string> = { low: 'Simple', medium: 'Medium', high: 'Complex' }
export const difficultyLabel = (member: Pick<TeamPlanMember, 'difficulty'>) =>
  member.difficulty ? DIFFICULTY[member.difficulty] : undefined

/** When a member's model was changed and differs from the lead's suggestion, it can be restored with one tap. */
export const suggestionDiffers = (member: TeamPlanMember) =>
  !!member.suggestedRuntime && !sameTeamRuntime(member.runtime, member.suggestedRuntime)

function identity(plan: TeamPlanRecord) {
  return {
    sessionId: plan.sessionId,
    planId: plan.planId,
    incarnationId: plan.incarnationId,
    expectedRevision: plan.revision,
  }
}
const planPath = (plan: TeamPlanRecord) => `/api/teams/${encodeURIComponent(plan.teamName)}/plan`
type PlanClient = Pick<ApiClient, 'get' | 'patch' | 'post'>

export async function loadTeamPlan(client: PlanClient, sessionId: string, signal?: AbortSignal) {
  const { plan } = await client.get<{ plan: TeamPlanRecord | null }>(
    `/api/teams/session/${encodeURIComponent(sessionId)}/plan`,
    { signal }
  )
  return plan
}

/** Send only fields that actually changed; the server rejects stale changes by revision. */
export async function editTeamPlan(client: PlanClient, plan: TeamPlanRecord, edit: TeamPlanEdit) {
  const { plan: next } = await client.patch<{ plan: TeamPlanRecord }>(planPath(plan), {
    ...identity(plan),
    ...edit,
  })
  return next
}

export async function actOnTeamPlan(
  client: PlanClient,
  plan: TeamPlanRecord,
  action: TeamPlanAction,
  requestId: string,
  feedback?: string
) {
  const { plan: next } = await client.post<{ plan: TeamPlanRecord }>(`${planPath(plan)}/${action}`, {
    ...identity(plan),
    requestId,
    ...(feedback ? { feedback } : {}),
  })
  return next
}

/** The same action on the same plan and revision reuses the requestId, so retries are idempotent on the server and never launch twice. */
export function actionKey(plan: TeamPlanRecord, action: TeamPlanAction) {
  return `${plan.planId}:${plan.revision}:${action}`
}

/**
 * Reads and changes may return interleaved: the same plan only accepts versions that are not older, 
 * otherwise a late read after changing the model would revert the UI to before the change.
 */
export function newerTeamPlan(current: TeamPlanRecord | null, next: TeamPlanRecord | null) {
  if (current && next && current.planId === next.planId && next.revision < current.revision) return current
  return next
}

const KNOWN_ERRORS: [RegExp, string][] = [
  [/Plan changed|refresh before continuing/i, 'The plan was just updated elsewhere and has been reloaded; please confirm again.'],
  [/Plan not found/i, 'This team plan is no longer there (maybe canceled on the computer); reloaded.'],
  [/Every member needs an assigned task/i, 'Every member must be assigned at least one task.'],
  [/Every task needs an assigned member|Plan needs members and assigned tasks/i, 'Every task must have an owner.'],
  [/Agent preset is unavailable/i, 'This agent type is no longer available on the computer.'],
  [/Agent teams are unavailable in lean sessions/i, 'Light sessions cannot use agent teams.'],
  [/Use the running team stop control/i, 'The team is already running; please use the stop button.'],
  [/Desktop-only capability/i, 'The desktop version is too old to approve teams on mobile; please update the desktop app first.'],
]

/** Server errors are in English; common ones are rephrased, the rest are shown as is for comparison with desktop logs. */
export function teamPlanErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return KNOWN_ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? message
}
