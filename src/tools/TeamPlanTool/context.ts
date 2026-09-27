import { z } from 'zod/v4'
import { snapshotTeamPlanPresetSource } from '../../utils/swarm/teamPlanPresetSource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { TeamPlanMember, TeamPlanRecord, TeamPlanRuntime, TeamPlanTask } from '../../shared/teamPlan.js'
import { getTeamLeaderRuntime } from '../../utils/swarm/teamPlanPolicy.js'
import { listTasks, getCanonicalTeamTaskListId } from '../../utils/tasks.js'
import { resolveTeammateModel } from '../../utils/swarm/resolveTeammateModel.js'

const runtimeSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  effortLevel: z.string().optional(),
})

export const proposedTeamPlanSchema = z.object({
  members: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    agentType: z.string().optional().describe('An available Agent preset; defaults to general-purpose.'),
    prompt: z.string().min(1),
    runtime: runtimeSchema.optional().describe('Suggested provider and model; the user makes the final choice.'),
    reason: z.string().optional(),
    difficulty: z.enum(['low', 'medium', 'high']).optional(),
  })),
  tasks: z.array(z.object({
    id: z.string().min(1),
    subject: z.string().min(1),
    description: z.string().optional(),
    ownerId: z.string().optional().describe('Stable member id, not its display name.'),
    dependencies: z.array(z.string()).default([]),
  })),
})

export type ProposedTeamPlan = z.infer<typeof proposedTeamPlanSchema>

export function snapshotTeamAgents(context: ToolUseContext) {
  return Object.fromEntries(context.options.agentDefinitions.activeAgents.map(agent => [agent.agentType, {
    agentType: agent.agentType,
    source: agent.source,
    sourceIdentity: snapshotTeamPlanPresetSource(agent),
    description: agent.whenToUse,
    systemPrompt: agent.rawSystemPrompt ?? agent.getSystemPrompt({ toolUseContext: context }),
    ...(agent.tools ? { tools: [...agent.tools] } : {}),
    ...(agent.disallowedTools ? { disallowedTools: [...agent.disallowedTools] } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effortLevel: String(agent.effort) } : {}),
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.skills ? { skills: [...agent.skills] } : {}),
    ...(agent.isolation ? { isolation: agent.isolation } : {}),
    ...(agent.memory ? { memory: agent.memory } : {}),
    ...(agent.hooks ? { hooks: structuredClone(agent.hooks) } : {}),
    ...(agent.mcpServers ? { mcpServers: agent.mcpServers.filter(spec => typeof spec === 'string') } : {}),
    ...(agent.mcpServers?.some(spec => typeof spec !== 'string') ? { configurationError: 'Inline MCP server configurations are not supported in team plans. Configure the server separately and reference its name in the Agent preset.' } : {}),
    ...(agent.initialPrompt ? { initialPrompt: agent.initialPrompt } : {}),
    ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
    ...(agent.omitClaudeMd !== undefined ? { omitClaudeMd: agent.omitClaudeMd } : {}),
  }]))
}

export function resolveProposedTeamPlan(plan: ProposedTeamPlan, context: ToolUseContext) {
  const state = context.getAppState()
  const leaderRuntime = getTeamLeaderRuntime(state.mainLoopModelForSession ?? state.mainLoopModel ?? '')
  const agentCatalog = snapshotTeamAgents(context)
  const members: TeamPlanMember[] = plan.members.map(member => {
    const agentType = member.agentType || 'general-purpose'
    const agentSnapshot = agentCatalog[agentType]
    if (!agentSnapshot) throw new Error(`Agent preset '${agentType}' is unavailable. Choose a listed Agent preset.`)
    if (agentSnapshot.configurationError) throw new Error(agentSnapshot.configurationError)
    const runtime: TeamPlanRuntime = member.runtime ?? {
      ...leaderRuntime,
      modelId: resolveTeammateModel(undefined, leaderRuntime.modelId, agentSnapshot.model, true),
    }
    if (!member.runtime) {
      if (agentSnapshot.effortLevel !== undefined) runtime.effortLevel = agentSnapshot.effortLevel
      else if (runtime.modelId !== leaderRuntime.modelId) delete runtime.effortLevel
    }
    return { ...member, agentType, runtime, suggestedRuntime: { ...runtime }, agentSnapshot }
  })
  return { members, tasks: plan.tasks, agentCatalog, leaderRuntime }
}

export async function captureLegacyPlanTasks(plan: TeamPlanRecord): Promise<TeamPlanTask[]> {
  if (plan.tasks.length > 0) return plan.tasks
  const tasks = await listTasks(getCanonicalTeamTaskListId(plan.teamName))
  const proposed = tasks.filter(task => task.status === 'pending' && !task.metadata?.teamPlanId
    && plan.members.some(member => member.name === task.owner))
  const ids = new Set(proposed.map(task => task.id))
  for (const task of proposed) {
    if (task.blockedBy.some(id => !ids.has(id) && tasks.find(dependency => dependency.id === id)?.status !== 'completed')) {
      throw new Error(`Task '${task.subject}' depends on work outside this proposal. Submit an explicit complete plan with TeamPlan.`)
    }
  }
  return proposed.map(task => ({
    id: task.id,
    subject: task.subject,
    description: task.description,
    ownerId: plan.members.find(member => member.name === task.owner)?.id,
    dependencies: task.blockedBy.filter(id => ids.has(id)),
  }))
}

/** Do not repeat the full preset prompts in the leader's tool-result history. */
export function teamPlanToolResult(plan: TeamPlanRecord) {
  return {
    team_name: plan.teamName,
    plan_id: plan.planId,
    revision: plan.revision,
    state: plan.state,
    members: plan.members.map(({ agentSnapshot: _snapshot, ...member }) => member),
    tasks: plan.tasks,
    message: plan.state === 'review_pending'
      ? 'The proposed members are awaiting human review and have not started. Existing approved members may continue. End this planning turn and wait for the user to confirm in the team panel.'
      : plan.state === 'draft'
        ? 'The proposed members have not started. Finish the roster and tasks, then call TeamPlan with operation="submit" and this revision.'
        : `The plan is ${plan.state}. Do not recreate or replay its members. Inspect the team panel for execution status.`,
  }
}
