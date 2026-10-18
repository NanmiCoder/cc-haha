import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../Tool.js'
import { getAgentProfile, setAgentProfile, type AgentProfile } from './agentProfile.js'
import { getAttachments, getAttachmentsForTesting } from './attachments.js'

const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_ATTACHMENTS'] as const
let savedEnv: (string | undefined)[]
let savedProfile: AgentProfile
let root: string

beforeEach(async () => {
  savedEnv = envKeys.map(key => process.env[key])
  savedProfile = getAgentProfile()
  root = await mkdtemp(join(tmpdir(), 'lean-attachments-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
})

afterEach(async () => {
  setAgentProfile(savedProfile)
  envKeys.forEach((key, i) => {
    if (savedEnv[i] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[i]
  })
  await rm(root, { recursive: true, force: true })
})

test('lean suppresses peripheral producers before they load or consume external state', async () => {
  setAgentProfile('lean')
  const load = mock(async () => [{ type: 'fixture' }])
  for (const label of [
    'plan_mode', 'plan_mode_exit', 'mcp_resources', 'mcp_instructions_delta', 'agent_mentions', 'agent_listing_delta',
    'deferred_tools_delta', 'dynamic_skill', 'skill_listing', 'skill_discovery',
    'teammate_mailbox', 'team_context', 'agent_pending_messages', 'todo_reminders',
    'workflow_keyword_request', 'workflow_size_guideline_change', 'ultra_effort_enter',
  ]) {
    expect(await getAttachmentsForTesting.produce(label, load)).toEqual([])
  }
  expect(load).not.toHaveBeenCalled()
  setAgentProfile('standard')
  expect(await getAttachmentsForTesting.produce('skill_listing', load)).toEqual([{ type: 'fixture' }])
  expect(load).toHaveBeenCalledTimes(1)
})

test('lean keeps user input, memory, hooks, permission and background result producers', async () => {
  setAgentProfile('lean')
  const load = mock(async () => [{ type: 'fixture' }])
  const labels = ['at_mentioned_files', 'nested_memory', 'changed_files', 'async_hook_responses',
    'auto_mode', 'queued_commands', 'unified_tasks', 'critical_system_reminder']
  for (const label of labels) {
    expect(await getAttachmentsForTesting.produce(label, load)).toEqual([{ type: 'fixture' }])
  }
  expect(load).toHaveBeenCalledTimes(labels.length)
})

test('actual attachment assembly omits agent mentions and leaves dynamic skill triggers untouched in lean', async () => {
  const skillDir = join(root, 'skills')
  await mkdir(join(skillDir, 'fixture'), { recursive: true })
  await writeFile(join(skillDir, 'fixture', 'SKILL.md'), '# fixture skill')
  const makeContext = () => ({
    agentId: 'fixture-thread',
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set([skillDir]),
    nestedMemoryAttachmentTriggers: new Set(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), tasks: {} }),
    options: {
      tools: [], mcpClients: [], mainLoopModel: 'fixture-model', commands: [],
      agentDefinitions: { activeAgents: [{ agentType: 'fixture' }] },
    },
  }) as unknown as ToolUseContext
  setAgentProfile('standard')
  const standardContext = makeContext()
  const standard = await getAttachments('@agent-fixture', standardContext, null, [])
  expect(standard.map(a => a.type)).toContain('agent_mention')
  expect(standard.map(a => a.type)).toContain('dynamic_skill')
  expect(standardContext.dynamicSkillDirTriggers?.size).toBe(0)

  setAgentProfile('lean')
  const leanContext = makeContext()
  for (let turn = 0; turn < 2; turn++) {
    const lean = await getAttachments('@agent-fixture', leanContext, null, [])
    expect(lean.map(a => a.type)).not.toContain('agent_mention')
    expect(lean.map(a => a.type)).not.toContain('dynamic_skill')
    expect(leanContext.dynamicSkillDirTriggers?.has(skillDir)).toBe(true)
  }
})
