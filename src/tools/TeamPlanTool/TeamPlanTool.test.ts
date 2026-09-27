import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { getSessionCreatedTeams } from '../../bootstrap/state.js'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { approveTeamPlan, mutateTeamPlan, readTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { clearLeaderTeamName, createTask, getCanonicalTeamTaskListId } from '../../utils/tasks.js'
import { GENERAL_PURPOSE_AGENT } from '../AgentTool/built-in/generalPurposeAgent.js'
import { EXPLORE_AGENT } from '../AgentTool/built-in/exploreAgent.js'
import { TeamCreateTool } from '../TeamCreateTool/TeamCreateTool.js'
import { TaskUpdateTool } from '../TaskUpdateTool/TaskUpdateTool.js'
import { spawnTeammate } from '../shared/spawnMultiAgent.js'
import { TeamPlanTool } from './TeamPlanTool.js'
import { getPrompt } from '../TeamCreateTool/prompt.js'
import { captureLegacyPlanTasks, resolveProposedTeamPlan, snapshotTeamAgents, teamPlanToolResult } from './context.js'

let directory: string
let context: ToolUseContext
let saved: Record<string, string | undefined>
const keys = ['CLAUDE_CONFIG_DIR', 'CC_HAHA_TEAM_REVIEW_REQUIRED', 'CC_HAHA_TEAM_LEADER_RUNTIME', 'CLAUDE_CODE_SUBAGENT_MODEL']

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'team-plan-tools-'))
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CC_HAHA_TEAM_REVIEW_REQUIRED = '1'
  process.env.CC_HAHA_TEAM_LEADER_RUNTIME = JSON.stringify({ providerId: 'fake-provider', modelId: 'fake-model' })
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  let state = { mainLoopModel: 'fake-model', inbox: { messages: [] } } as ReturnType<ToolUseContext['getAppState']>
  context = {
    getAppState: () => state,
    setAppState: update => { state = typeof update === 'function' ? update(state) : update },
    abortController: new AbortController(),
    options: {
      mainLoopModel: 'fake-model',
      agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT], allAgents: [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT] },
      commands: [], tools: [], mcpClients: [],
    },
  } as unknown as ToolUseContext
})
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearLeaderTeamName()
  getSessionCreatedTeams().delete('review-team')
  await rm(directory, { recursive: true, force: true })
})

describe('whole-team planning tools', () => {
  test('review instructions describe the actual draft and execution states', () => {
    expect(getPrompt()).toContain('Human review before execution')
    expect(getPrompt()).toContain('Member names may contain letters, numbers, underscores and hyphens only')
    expect(getPrompt()).toContain('Additional members require a new incremental review')
    const result = teamPlanToolResult({ teamName: 'review-team', state: 'running', members: [], tasks: [] } as never)
    expect(result.message).toContain('running')
    expect(result.message).not.toContain('No teammate has started')
    delete process.env.CC_HAHA_TEAM_REVIEW_REQUIRED
    expect(getPrompt()).not.toContain('Human review before execution')
  })
  test('legacy Agent spawns only stage members, then whole-plan submit waits for human review', async () => {
    const created = await TeamCreateTool.call({ team_name: 'review-team' }, context)
    expect(created.data.plan?.state).toBe('draft')
    const staged = await spawnTeammate({ name: 'researcher', team_name: 'review-team', agent_type: 'Explore', prompt: 'Inspect the source' }, context)
    expect(staged.data).toMatchObject({ staged: true, agent_id: '', tmux_pane_id: '' })
    expect((await readTeamFileAsync('review-team'))?.members.map(member => member.name)).toEqual(['team-lead'])
    const submitted = await TeamPlanTool.call({
      team_name: 'review-team', operation: 'submit', expected_revision: staged.data.revision,
      plan: { members: [{ id: 'researcher', name: 'researcher', agentType: 'Explore', prompt: 'Inspect the source' }], tasks: [{ id: 'audit', subject: 'Audit source', ownerId: 'researcher', dependencies: [] }] },
    }, context)
    expect(submitted.data.state).toBe('review_pending')
    expect(TeamPlanTool.mapToolResultToToolResultBlockParam(submitted.data, 'submit-plan')).toMatchObject({
      type: 'tool_result', tool_use_id: 'submit-plan', content: [{ type: 'text', text: expect.stringContaining('review_pending') }],
    })
    const plan = await readTeamPlan('review-team')
    expect(plan?.approvedSnapshot).toBeUndefined()
    expect(plan?.members[0]?.agentSnapshot?.systemPrompt).toContain('READ-ONLY')
    expect(plan?.members[0]?.agentSnapshot?.disallowedTools).toContain('Edit')
    expect((await readTeamFileAsync('review-team'))?.members).toHaveLength(1)
    const update = await TaskUpdateTool.call({ taskId: 'audit', status: 'in_progress' }, context)
    expect(update.data.success).toBe(false)
    expect(update.data.error).toContain('human review')
  })

  test('refuses stale revisions and unknown presets without silently using a generic worker', async () => {
    const created = await TeamCreateTool.call({ team_name: 'review-team' }, context)
    await expect(spawnTeammate({ name: 'worker', team_name: 'review-team', agent_type: 'unknown', prompt: 'Work' }, context)).rejects.toThrow('unavailable')
    const staged = await spawnTeammate({ name: 'worker', team_name: 'review-team', prompt: 'Work' }, context)
    expect(staged.data.staged).toBe(true)
    await expect(TeamPlanTool.call({ team_name: 'review-team', operation: 'submit', expected_revision: created.data.plan!.revision }, context)).rejects.toThrow('changed')
    expect((await readTeamPlan('review-team'))?.state).toBe('draft')
  })

  test('rejects a teammate name the launcher cannot use before submitting a plan', async () => {
    const created = await TeamCreateTool.call({ team_name: 'review-team' }, context)
    await expect(TeamPlanTool.call({ team_name: 'review-team', operation: 'submit', expected_revision: created.data.plan!.revision,
      plan: { members: [{ id: 'reader', name: 'README Reader', prompt: 'Read README' }], tasks: [{ id: 'read', subject: 'Read', ownerId: 'reader', dependencies: [] }] },
    }, context)).rejects.toThrow('Use letters, numbers, underscores or hyphens')
    expect((await readTeamPlan('review-team'))?.state).toBe('draft')
  })

  test('a persisted desktop draft cannot fall through to an execution backend if the environment flag is absent', async () => {
    await TeamCreateTool.call({ team_name: 'review-team' }, context)
    delete process.env.CC_HAHA_TEAM_REVIEW_REQUIRED
    const staged = await spawnTeammate({ name: 'worker', team_name: 'review-team', prompt: 'Work' }, context)
    expect(staged.data.staged).toBe(true)
    expect((await readTeamFileAsync('review-team'))?.members).toHaveLength(1)
  })

  test('snapshots both custom and built-in preset semantics without losing tool restrictions', async () => {
    const sourceFilePath = join(directory, 'custom.md')
    await writeFile(sourceFilePath, 'Custom instructions')
    const sourceContentHash = createHash('sha256').update('Custom instructions').digest('hex')
    const definitions = context.options.agentDefinitions.activeAgents
    definitions.push({ sourceFilePath, sourceContentHash, agentType: 'custom', source: 'projectSettings', whenToUse: 'A fixture', getSystemPrompt: () => 'Custom instructions', tools: ['Read'], disallowedTools: ['Write'], model: 'custom-model', effort: 'high', isolation: 'worktree', skills: ['fixture-skill'] } as typeof definitions[number])
    const snapshots = snapshotTeamAgents(context)
    expect(snapshots.custom).toMatchObject({ systemPrompt: 'Custom instructions', tools: ['Read'], disallowedTools: ['Write'], model: 'custom-model', effortLevel: 'high', isolation: 'worktree', skills: ['fixture-skill'] })
    expect(snapshots.Explore?.systemPrompt).toContain('READ-ONLY')
  })

  test('preset effort is suggested initially and an explicit runtime remains authoritative', () => {
    const definitions = context.options.agentDefinitions.activeAgents
    definitions.push({ agentType: 'effort-fixture', source: 'flagSettings', whenToUse: 'Fixture', getSystemPrompt: () => 'Fixture instructions', model: 'fixture-reasoner', effort: 'high' } as typeof definitions[number])
    const proposal = { members: [{ id: 'w', name: 'w', agentType: 'effort-fixture', prompt: 'Work' }], tasks: [] }
    expect(resolveProposedTeamPlan(proposal, context).members[0]?.runtime.effortLevel).toBe('high')
    const explicit = { ...proposal, members: [{ ...proposal.members[0]!, runtime: { providerId: 'fake-provider', modelId: 'plain-model' } }] }
    expect(resolveProposedTeamPlan(explicit, context).members[0]?.runtime.effortLevel).toBeUndefined()
  })

  test('inline MCP credentials never enter the durable catalog or a proposed member', async () => {
    const definitions = context.options.agentDefinitions.activeAgents
    definitions.push({ agentType: 'inline-mcp', source: 'flagSettings', whenToUse: 'Fixture', getSystemPrompt: () => 'Fixture prompt', mcpServers: [{ private: { command: 'fixture', env: { API_KEY: 'do-not-persist-fixture-token' } } }] } as typeof definitions[number])
    const snapshots = snapshotTeamAgents(context)
    expect(JSON.stringify(snapshots)).not.toContain('do-not-persist-fixture-token')
    expect(snapshots['inline-mcp']?.configurationError).toContain('reference its name')
    await expect(TeamCreateTool.call({ team_name: 'review-team', plan: { members: [{ id: 'w', name: 'w', agentType: 'inline-mcp', prompt: 'Work' }], tasks: [] } }, context)).rejects.toThrow('Inline MCP')
    expect(await readTeamFileAsync('review-team')).toBeNull()
  })

  test('rejects an invalid initial dependency graph before creating the durable team', async () => {
    await expect(TeamCreateTool.call({ team_name: 'review-team', plan: {
      members: [{ id: 'worker', name: 'worker', prompt: 'Work' }],
      tasks: [{ id: 'work', subject: 'Work', ownerId: 'worker', dependencies: ['missing'] }],
    } }, context)).rejects.toThrow('Unknown dependency')
    expect(await readTeamFileAsync('review-team')).toBeNull()
  })

  test('incremental review keeps existing workers able to update tasks and never recaptures their old work', async () => {
    const created = await TeamCreateTool.call({ team_name: 'review-team', plan: {
      members: [{ id: 'old', name: 'old', prompt: 'Existing work' }],
      tasks: [{ id: 'work', subject: 'Existing work', ownerId: 'old', dependencies: [] }],
    } }, context)
    await TeamPlanTool.call({ team_name: 'review-team', operation: 'submit', expected_revision: created.data.plan!.revision }, context)
    let plan = (await readTeamPlan('review-team'))!
    const approved = await approveTeamPlan(plan.teamName, { ...plan, expectedRevision: plan.revision }, 'fixture-approval', plan)
    plan = await mutateTeamPlan(plan.teamName, { ...approved.plan, expectedRevision: approved.plan.revision }, current => ({ ...current, state: 'running' }))
    const taskId = await createTask(getCanonicalTeamTaskListId(plan.teamName), {
      subject: 'Existing work', description: 'Keep working', owner: 'old', status: 'pending', blocks: [], blockedBy: [], metadata: { teamPlanId: plan.planId },
    })
    await spawnTeammate({ name: 'new', team_name: 'review-team', prompt: 'New work' }, context)
    const increment = (await readTeamPlan('review-team'))!
    expect(increment.state).toBe('draft')
    expect(await captureLegacyPlanTasks(increment)).toEqual([])
    const updated = await TaskUpdateTool.call({ taskId, status: 'in_progress' }, context)
    expect(updated.data.success).toBe(true)
  })
})
