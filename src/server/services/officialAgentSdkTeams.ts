import { z } from 'zod/v4'
import type { ToolUseContext } from '../../Tool.js'
import { proposedTeamPlanSchema, snapshotTeamAgents, teamPlanToolResult, type ProposedTeamPlan } from '../../tools/TeamPlanTool/context.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import type { TeamPlanAgentSnapshot, TeamPlanRuntime } from '../../shared/teamPlan.js'
import {
  beginTaskListLifecycle, createTask, ensureTasksDir, getCanonicalTeamTaskListId,
  getTask, listTasks, readTaskListLifecycleState, updateTaskAtomically, withTaskListLifecycleLock,
} from '../../utils/tasks.js'
import { formatAgentId } from '../../utils/agentId.js'
import { readTeamFile, sanitizeName, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { ensureTeamDraft, findTeamPlanForSession, isTeamExecutionApproved, readTeamPlan, replaceTeamPlan, submitTeamPlan, validateTeamPlanGraph } from '../../utils/swarm/teamPlanStore.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import type { ExtensionTool } from './officialAgentSdkExtensionTools.js'

export type ExtensionSessionConfig = { sessionId: string; cwd: string; env: NodeJS.ProcessEnv; model?: string; effort?: string }
export type ExtensionWorker = { parentSessionId: string; teamName: string; memberId: string; name: string }

export function extensionWorker(config: ExtensionSessionConfig): ExtensionWorker | undefined {
  if (!config.env.CC_HAHA_TEAM_WORKER) return undefined
  return z.object({ parentSessionId: z.string().min(1), teamName: z.string().min(1), memberId: z.string().min(1), name: z.string().min(1) }).parse(JSON.parse(config.env.CC_HAHA_TEAM_WORKER))
}

export async function createOfficialAgentSdkTeamTools(config: ExtensionSessionConfig, deps: {
  catalog?: Record<string, TeamPlanAgentSnapshot>
  requestReview?: () => void
} = {}): Promise<ExtensionTool[]> {
  if (config.env.CC_HAHA_AGENT_TEAMS_ENABLED !== '1') return []
  const worker = extensionWorker(config)
  const catalog = deps.catalog ?? snapshotTeamAgents({
    options: { agentDefinitions: await getAgentDefinitionsWithOverrides(config.cwd), commands: [], mcpClients: [] },
  } as ToolUseContext)
  // The native SDK's agent loader owns normal Agent subcalls. These snapshots
  // are solely for the app's existing review card and worker supervisor.
  const runtime = (): TeamPlanRuntime => {
    const source = JSON.parse(config.env.CC_HAHA_TEAM_LEADER_RUNTIME ?? 'null')
    const value = z.object({ providerId: z.string().min(1), modelId: z.string().min(1), effortLevel: z.string().optional() }).parse(source)
    return { ...value, modelId: config.model || value.modelId, ...(config.effort ? { effortLevel: config.effort } : {}) }
  }
  const ownedTeam = async (requested?: string) => {
    const name = requested ?? worker?.teamName ?? (await findTeamPlanForSession(config.sessionId))?.teamName
    const team = name ? readTeamFile(name) : undefined
    if (!name || !team || (worker
      ? team.leadSessionId !== worker.parentSessionId || !team.members.some(member => member.sessionId === config.sessionId && member.name === worker.name)
      : team.leadSessionId !== config.sessionId)) throw new Error('This session does not belong to the requested team')
    return { name, team, taskListId: getCanonicalTeamTaskListId(name) }
  }
  const resolvePlan = (proposal: ProposedTeamPlan) => {
    const leaderRuntime = runtime()
    const members = proposal.members.map(member => {
      const agentType = member.agentType || 'general-purpose'
      const agentSnapshot = catalog[agentType]
      if (!agentSnapshot || agentSnapshot.configurationError) throw new Error(agentSnapshot?.configurationError || `Unknown Agent preset '${agentType}'`)
      // Provider changes remain a human choice on the review card. A model
      // cannot silently route a team to another saved account.
      const suggested = member.runtime?.providerId === leaderRuntime.providerId ? member.runtime : undefined
      const memberRuntime = suggested ?? { ...leaderRuntime,
        ...(agentSnapshot.model && agentSnapshot.model !== 'inherit' ? { modelId: agentSnapshot.model } : {}),
        ...(agentSnapshot.effortLevel ? { effortLevel: agentSnapshot.effortLevel } : {}),
      }
      return { ...member, agentType, agentSnapshot, runtime: memberRuntime, suggestedRuntime: { ...memberRuntime } }
    })
    const patch = { members, tasks: proposal.tasks, agentCatalog: catalog, leaderRuntime }
    validateTeamPlanGraph(patch)
    return patch
  }
  const tools: ExtensionTool[] = []
  if (!worker) tools.push({
    name: 'TeamCreate', description: 'Create a cc-hh team draft for the desktop team panel. No members run before the human approves. Include the complete roster and task dependencies when known.',
    schema: z.strictObject({ team_name: z.string().min(1).max(100), description: z.string().optional(), plan: proposedTeamPlanSchema.optional() }),
    async call(input) {
      const prior = await findTeamPlanForSession(config.sessionId)
      if (prior) throw new Error(`This session already owns team '${prior.teamName}'. Use TeamPlan to read or update it.`)
      const teamName = sanitizeName(input.team_name)
      if (!teamName || teamName !== input.team_name) throw new Error('Use a team name containing only lowercase letters, digits and hyphens')
      const initial = input.plan ? resolvePlan(input.plan) : { agentCatalog: catalog, leaderRuntime: runtime() }
      const listId = getCanonicalTeamTaskListId(teamName)
      await withTaskListLifecycleLock(listId, async () => {
        const lifecycle = await readTaskListLifecycleState(listId)
        if (readTeamFile(teamName) || (!lifecycle.deleted && lifecycle.activeIdentity)) throw new Error('That team name is already in use')
        const now = Date.now()
        const leadAgentId = formatAgentId('team-lead', teamName)
        await beginTaskListLifecycle(listId, { teamName, createdAt: now, leadSessionId: config.sessionId })
        await writeTeamFileAsync(teamName, {
          name: teamName, description: input.description, createdAt: now,
          leadAgentId, leadSessionId: config.sessionId, reviewRequired: true,
          members: [{ agentId: leadAgentId, name: 'team-lead', agentType: 'team-lead', model: runtime().modelId,
            joinedAt: now, tmuxPaneId: '', cwd: config.cwd, subscriptions: [] }],
        })
        await ensureTasksDir(listId)
      })
      const plan = await ensureTeamDraft(teamName, config.sessionId, runtime(), { workDir: config.cwd, ...initial })
      return { team_name: teamName, lead_agent_id: formatAgentId('team-lead', teamName), plan: teamPlanToolResult(plan) }
    },
  }, {
    name: 'TeamPlan', description: 'Read, replace or submit a cc-hh team draft. Submit never approves or launches members. After submitting, end the turn and wait for the user to approve in the team panel.',
    schema: z.strictObject({ team_name: z.string().min(1), operation: z.enum(['get', 'replace', 'submit']), expected_revision: z.number().int().positive().optional(), plan: proposedTeamPlanSchema.optional() }),
    async call(input) {
      await ownedTeam(input.team_name)
      let plan = await readTeamPlan(input.team_name)
      if (!plan || plan.sessionId !== config.sessionId) throw new Error('Create the team draft first')
      if (input.operation === 'get') return teamPlanToolResult(plan)
      if (!input.expected_revision) throw new Error('Read the latest plan and supply expected_revision')
      const identity = { ...plan, expectedRevision: input.expected_revision }
      const patch = input.plan ? resolvePlan(input.plan) : undefined
      if (input.operation === 'replace') {
        if (!patch) throw new Error('A complete plan is required')
        plan = await replaceTeamPlan(input.team_name, identity, patch)
      } else {
        plan = await submitTeamPlan(input.team_name, identity, patch)
        deps.requestReview?.()
      }
      return teamPlanToolResult(plan)
    },
  })
  tools.push({
    name: 'SendMessage', description: 'Send a plain text message to an existing member of this cc-hh team. Use to=team-lead to report results; to=* broadcasts. The desktop supervisor wakes stopped workers from their saved conversation.',
    schema: z.strictObject({ to: z.string().min(1), message: z.string().min(1).max(32000), summary: z.string().optional() }),
    async call(input) {
      const { name, team } = await ownedTeam()
      const sender = worker?.name ?? 'team-lead'
      const recipients = input.to === '*' ? team.members.filter(member => member.name !== sender).map(member => member.name) : [input.to]
      if (recipients.some(name => !team.members.some(member => member.name === name))) throw new Error('Recipient is not an existing team member')
      for (const recipient of recipients) {
        const written = await writeToMailbox(recipient, { from: sender, text: input.message, summary: input.summary, timestamp: new Date().toISOString() }, name)
        if (!written) throw new Error(`Message to ${recipient} was not delivered`)
      }
      return { success: true, recipients }
    },
  }, {
    name: 'TaskList', description: 'List the shared cc-hh team tasks and their dependencies.', readOnly: true,
    schema: z.strictObject({}),
    async call() { return { tasks: await listTasks((await ownedTeam()).taskListId) } },
  }, {
    name: 'TaskGet', description: 'Read one shared cc-hh team task.', readOnly: true,
    schema: z.strictObject({ taskId: z.string().min(1) }),
    async call(input) { return { task: await getTask((await ownedTeam()).taskListId, input.taskId) } },
  }, {
    name: 'TaskCreate', description: 'Create a shared task in an approved cc-hh team. Before approval, put tasks in TeamPlan instead.',
    schema: z.strictObject({ subject: z.string().min(1), description: z.string(), activeForm: z.string().optional() }),
    async call(input) {
      const { name, taskListId } = await ownedTeam()
      if (!await isTeamExecutionApproved(name, worker?.name)) throw new Error('The team must be approved before creating execution tasks')
      const taskId = await createTask(taskListId, { ...input, status: 'pending', blocks: [], blockedBy: [] })
      return { taskId, task: await getTask(taskListId, taskId) }
    },
  }, {
    name: 'TaskUpdate', description: 'Update a shared task after team approval. Check dependencies before starting; report your result to the team lead before completing.',
    schema: z.strictObject({ taskId: z.string().min(1), status: z.enum(['pending', 'in_progress', 'completed']).optional(), subject: z.string().optional(), description: z.string().optional(), owner: z.string().optional(), activeForm: z.string().optional() }),
    async call(input) {
      const { name, team, taskListId } = await ownedTeam()
      if (!await isTeamExecutionApproved(name, worker?.name)) throw new Error('The team must be approved before updating execution tasks')
      if (input.owner && !team.members.some(member => member.name === input.owner)) throw new Error('Unknown task owner')
      const { taskId, ...updates } = input
      const result = await withTaskListLifecycleLock(taskListId, async () => {
        const tasks = updates.status === 'in_progress' ? await listTasks(taskListId) : []
        return updateTaskAtomically(taskListId, taskId, task => {
          if (worker && task.owner && task.owner !== worker.name) throw new Error('This task belongs to another teammate')
          if (updates.status === 'in_progress' && task.blockedBy.some(id => tasks.find(item => item.id === id)?.status !== 'completed')) throw new Error('This task is waiting for dependencies')
          return updates
        })
      })
      if (!result) throw new Error('Task not found')
      return { task: result.task }
    },
  })
  return tools
}
