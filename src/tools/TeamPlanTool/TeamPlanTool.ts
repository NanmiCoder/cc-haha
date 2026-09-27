import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isTeamReviewRequired } from '../../utils/swarm/teamPlanPolicy.js'
import { readTeamPlan, replaceTeamPlan, submitTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { isTeammate } from '../../utils/teammate.js'
import { requestTeamPlanTurnPause } from '../../utils/swarm/teamPlanTurnBoundary.js'
import { TEAM_PLAN_TOOL_NAME } from './constants.js'
import { captureLegacyPlanTasks, proposedTeamPlanSchema, resolveProposedTeamPlan, snapshotTeamAgents, teamPlanToolResult } from './context.js'

const inputSchema = lazySchema(() => z.object({
  team_name: z.string().min(1),
  operation: z.enum(['get', 'replace', 'submit']),
  expected_revision: z.number().int().positive().optional().describe('Required for replace and submit; use the revision returned by TeamCreate, Agent or TeamPlan.'),
  plan: proposedTeamPlanSchema.optional(),
}))

export const TeamPlanTool = buildTool({
  name: TEAM_PLAN_TOOL_NAME,
  searchHint: 'prepare and submit a complete team for human model allocation before execution',
  maxResultSizeChars: 100_000,
  alwaysLoad: true,
  get inputSchema() { return inputSchema() },
  userFacingName() { return TEAM_PLAN_TOOL_NAME },
  isEnabled() { return isAgentSwarmsEnabled() && isTeamReviewRequired() && !isTeammate() },
  async description() { return 'Read, replace or submit a team draft for human review. Never starts members or approves a plan.' },
  async prompt() {
    return 'After TeamCreate, use TeamPlan to submit the complete roster and tasks together. Give each member a stable id, a launchable name using only letters, numbers, underscores or hyphens (team-lead is reserved), available agentType, task prompt, suggested runtime and a short reason. Task ownerId refers to a member id; dependencies refer to task ids. Use get to read the current revision. Replace and submit require expected_revision. Submit may include a complete replacement plan. After submit, end the planning turn and wait for human approval. Do not start work, claim tasks, poll the plan or call Agent to bypass review. Only the user can approve in the team panel.'
  },
  toAutoClassifierInput(input) { return `${input.operation} ${input.team_name}` },
  renderToolUseMessage(input) { return `${input.operation} team plan: ${input.team_name}` },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: [{ type: 'text' as const, text: jsonStringify(data) }] }
  },
  async call(input, context) {
    if (isTeammate()) throw new Error('Only the team leader can submit a team plan.')
    let plan = await readTeamPlan(input.team_name)
    if (!plan || plan.sessionId !== getSessionId()) throw new Error('No team draft belongs to this session. Create the team first.')
    if (input.operation === 'get') return { data: teamPlanToolResult(plan) }
    if (input.expected_revision === undefined) throw new Error('expected_revision is required. Read the latest plan before editing it.')
    const identity = { sessionId: plan.sessionId, planId: plan.planId, incarnationId: plan.incarnationId, expectedRevision: input.expected_revision }
    if (!input.plan && input.operation === 'replace') {
      throw new Error('A complete plan is required for replace.')
    }
    const patch = input.plan ? resolveProposedTeamPlan(input.plan, context) : {
      tasks: await captureLegacyPlanTasks(plan),
      agentCatalog: snapshotTeamAgents(context),
    }
    if (input.operation === 'submit') {
      plan = await submitTeamPlan(input.team_name, identity, patch)
      requestTeamPlanTurnPause(context.abortController)
    } else plan = await replaceTeamPlan(input.team_name, identity, patch)
    return { data: teamPlanToolResult(plan) }
  },
})
