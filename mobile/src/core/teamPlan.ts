import type {
  TeamPlanMember,
  TeamPlanRecord,
  TeamPlanRuntime,
  TeamPlanTask,
} from '../../../src/shared/teamPlan'
import type { ApiClient } from './client'
import { OFFICIAL_RUNTIME_SOURCES } from './runtimeCatalog'
import type { RuntimeConfig } from './types'

export type { TeamPlanMember, TeamPlanRecord, TeamPlanRuntime, TeamPlanTask }
export type TeamPlanAction = 'approve' | 'return' | 'cancel' | 'retry' | 'end'
export type TeamPlanEdit = {
  members?: { id: string; agentType?: string; runtime?: TeamPlanRuntime }[]
  tasks?: { id: string; ownerId: string }[]
}

/** 团队方案里 Claude 官方来源写作这个 id；手机端的运行配置用 null 表示它（同桌面）。 */
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

/** 来源名：先找电脑上保存的供应商，再找官方来源；都认不出就原样显示 id，不猜。 */
export function teamRuntimeSource(runtime: TeamPlanRuntime, providers: readonly { id: string; name: string }[] = []) {
  const id = teamRuntimeConfig(runtime).providerId
  return (
    providers.find((provider) => provider.id === id)?.name ??
    OFFICIAL_RUNTIME_SOURCES.find((official) => official.id === id)?.name ??
    runtime.providerId
  )
}

/** 「来源 · 模型 id」，和电脑端团队卡片一致。 */
export const teamRuntimeLabel = (runtime: TeamPlanRuntime, providers: readonly { id: string; name: string }[] = []) =>
  `${teamRuntimeSource(runtime, providers)} · ${runtime.modelId}`

export const sameTeamRuntime = (a?: TeamPlanRuntime, b?: TeamPlanRuntime) =>
  !!a &&
  !!b &&
  a.providerId === b.providerId &&
  a.modelId === b.modelId &&
  (a.effortLevel ?? '') === (b.effortLevel ?? '')

/**
 * 手机上要不要为这份方案留出操作入口：
 * - review：队长提交了团队、回合已暂停，只有人批准才会开工（不处理就永远卡住）。
 * - failed：启动失败，可以重新审阅或取消。
 * - interrupted：运行时丢了，只能由人结束团队。
 * 其余状态（规划中、启动中、运行中、已取消）没有要人做的事。
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

/** 批准前要补齐的地方，和电脑上的启动校验一致：每项任务有负责人，每个成员有任务。 */
export function teamPlanReview(plan: Pick<TeamPlanRecord, 'members' | 'tasks'>) {
  const unassigned = plan.tasks.filter((task) => !plan.members.some((member) => member.id === task.ownerId))
  const idle = plan.members.filter((member) => !plan.tasks.some((task) => task.ownerId === member.id))
  const blocker = unassigned.length
    ? `还有 ${unassigned.length} 项任务没有负责人。`
    : idle.length
      ? `${idle.map((member) => member.name).join('、')} 没有分到任务，给它分一项或退回让队长调整。`
      : !plan.members.length
        ? '方案里还没有成员。'
        : undefined
  return { unassigned, idle, blocker }
}

export const memberTasks = (plan: Pick<TeamPlanRecord, 'tasks'>, memberId: string) =>
  plan.tasks.filter((task) => task.ownerId === memberId)

const DIFFICULTY: Record<string, string> = { low: '简单', medium: '中等', high: '复杂' }
export const difficultyLabel = (member: Pick<TeamPlanMember, 'difficulty'>) =>
  member.difficulty ? DIFFICULTY[member.difficulty] : undefined

/** 成员换了模型，和队长给的建议不同时可以一键恢复。 */
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

/** 只发真正改了的字段；服务端按 revision 拒绝过期的改动。 */
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

/** 同一份方案、同一版本上的同一操作复用 requestId，重试时服务端按幂等处理，不会启动两次。 */
export function actionKey(plan: TeamPlanRecord, action: TeamPlanAction) {
  return `${plan.planId}:${plan.revision}:${action}`
}

/**
 * 读取和改动可能交错返回：同一份方案只接受不更旧的版本，
 * 否则改完模型后迟到的一次读取会把界面拨回改之前。
 */
export function newerTeamPlan(current: TeamPlanRecord | null, next: TeamPlanRecord | null) {
  if (current && next && current.planId === next.planId && next.revision < current.revision) return current
  return next
}

const KNOWN_ERRORS: [RegExp, string][] = [
  [/Plan changed|refresh before continuing/i, '方案刚在别处更新过，已重新读取，请再确认一次。'],
  [/Plan not found/i, '这个团队方案已经不在了（可能在电脑上取消了），已重新读取。'],
  [/Every member needs an assigned task/i, '每个成员都要分到至少一项任务。'],
  [/Every task needs an assigned member|Plan needs members and assigned tasks/i, '每项任务都要有负责人。'],
  [/Agent preset is unavailable/i, '这个 Agent 类型在电脑上已不可用。'],
  [/Agent teams are unavailable in lean sessions/i, '轻量会话不能使用 Agent 团队。'],
  [/Use the running team stop control/i, '团队已经在运行，请用停止按钮。'],
  [/Desktop-only capability/i, '电脑端版本较旧，还不支持在手机上审批团队，请先更新电脑端。'],
]

/** 服务端的报错是英文；常见的几种换成中文，其余原样显示，方便对照电脑端日志。 */
export function teamPlanErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return KNOWN_ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? message
}
