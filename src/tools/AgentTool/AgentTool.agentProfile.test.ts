import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { getAgentProfile, setAgentProfile } from '../../utils/agentProfile.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { AgentTool, inputSchema } from './AgentTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { getAgentDefinitionsForProfile } from './leanAgents.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { initializeAgentMcpServers, runAgent } from './runAgent.js'

const originalProfile = getAgentProfile()
const originalConfig = process.env.CLAUDE_CONFIG_DIR
let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'cc-haha-lean-agent-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  resetSettingsCache()
  setAgentProfile('lean')
})

afterEach(() => {
  mock.restore()
  setAgentProfile(originalProfile)
  resetSettingsCache()
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  rmSync(configDir, { recursive: true, force: true })
})

function parentContext(agents: AgentDefinition[] = []): ToolUseContext {
  let state = {
    ...getDefaultAppState(),
    agentDefinitions: { activeAgents: agents, allAgents: agents },
  }
  return {
    options: {
      commands: [], mainLoopModel: 'sonnet', tools: [], mcpClients: [],
      mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: state.agentDefinitions,
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state,
    setAppState: update => { state = update(state) },
    setResponseLength: () => {},
    messages: [],
    toolUseId: 'lean-agent-fixture',
  } as unknown as ToolUseContext
}

describe('lean Agent contract', () => {
  test('keeps schemas profile-specific across standard and lean sessions', () => {
    const input = { description: 'Inspect code', prompt: 'Find the parser.', team_name: 'fixture' }
    setAgentProfile('standard')
    expect(inputSchema().safeParse(input).success).toBe(true)
    expect(AgentTool.inputSchema.safeParse(input).success).toBe(true)
    setAgentProfile('lean')
    expect(inputSchema().safeParse(input).success).toBe(false)
    expect(AgentTool.inputSchema.safeParse(input).success).toBe(false)
    expect(inputSchema().safeParse({ ...input, team_name: undefined }).success).toBe(false)
    expect(inputSchema().safeParse({ description: 'Inspect code', prompt: 'Find the parser.', subagent_type: 'Explore', name: 'researcher', run_in_background: true }).success).toBe(true)
    expect(inputSchema().safeParse({ description: 'Inspect code', prompt: 'Find the parser.', subagent_type: 'custom' }).success).toBe(false)
    setAgentProfile('standard')
    expect(inputSchema().safeParse(input).success).toBe(true)
    expect(AgentTool.inputSchema.safeParse(input).success).toBe(true)
  })

  test('advertises only compact built-ins and preserves agent permission filters', async () => {
    const custom = { ...GENERAL_PURPOSE_AGENT, agentType: 'custom-sentinel', whenToUse: 'UNSELECTED_CATALOG_SENTINEL' }
    const context = parentContext([custom])
    const prompt = await AgentTool.prompt({
      agents: [custom], tools: [],
      getToolPermissionContext: async () => context.getAppState().toolPermissionContext,
      allowedAgentTypes: ['Explore'],
    } as never)
    expect(prompt).toContain('- Explore:')
    expect(prompt).not.toContain('- general-purpose:')
    expect(prompt).not.toContain('UNSELECTED_CATALOG_SENTINEL')
    expect(prompt.length).toBeLessThan(1200)
    expect(getAgentDefinitionsForProfile([custom]).map(agent => agent.agentType)).toEqual(['general-purpose', 'Explore'])
    setAgentProfile('standard')
    expect(getAgentDefinitionsForProfile([custom])).toEqual([custom])
  })

  test.each([
    { team_name: 'fixture-team', name: 'worker' },
    { mode: 'plan' },
    { isolation: 'worktree' },
  ])('rejects unsupported spawn controls before side effects: %j', async overrides => {
    await expect(AgentTool.call({
      description: 'Inspect code', prompt: 'Find the parser.', ...overrides,
    } as never, parentContext(), (async () => ({ behavior: 'allow' })) as never,
    createAssistantMessage({ content: 'Inspect the parser.' }))).rejects.toThrow('ordinary subagents only')
  })

  test('rejects arbitrary custom agents even when they are present in the loaded catalog', async () => {
    const custom = { ...GENERAL_PURPOSE_AGENT, agentType: 'custom-sentinel' }
    await expect(AgentTool.call({
      description: 'Inspect code', prompt: 'Find the parser.', subagent_type: custom.agentType,
    }, parentContext([custom]), (async () => ({ behavior: 'allow' })) as never,
    createAssistantMessage({ content: 'Inspect the parser.' }))).rejects.toThrow("Agent type 'custom-sentinel' not found")
  })

  test.each([false, true])('constructs a lean runtime for foreground/background=%s without custom prompt or skill preloads', async isAsync => {
    const suppliedAgent = {
      ...GENERAL_PURPOSE_AGENT,
      getSystemPrompt: () => 'CUSTOM_PROMPT_SENTINEL',
      skills: ['UNSELECTED_SKILL_SENTINEL'],
      mcpServers: [{ fixture: { type: 'stdio', command: 'must-not-start' } }],
    } as AgentDefinition
    let captured: CacheSafeParams | undefined
    const stop = new Error('Captured before any provider request')
    const stream = runAgent({
      agentDefinition: suppliedAgent,
      promptMessages: [], toolUseContext: parentContext([suppliedAgent]),
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      isAsync, querySource: 'agent:builtin',
      // Even a restored override cannot replace the lean prompt.
      override: { userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt(['OLD_PROMPT_SENTINEL']) },
      availableTools: [
        { name: 'Read' }, { name: 'Write' }, { name: 'WebSearch' },
        { name: 'Agent' }, { name: 'TeamCreate' }, { name: 'mcp__fixture__read', isMcp: true },
      ] as never,
      onCacheSafeParams: params => { captured = params; throw stop },
    })
    await expect(stream.next()).rejects.toBe(stop)
    const prompt = JSON.stringify(captured?.systemPrompt)
    expect(prompt).toContain('You are cc-haha')
    expect(prompt).toContain('You are a subagent completing the assigned task')
    expect(prompt).not.toMatch(/CUSTOM_PROMPT_SENTINEL|OLD_PROMPT_SENTINEL|UNSELECTED_SKILL_SENTINEL/)
    expect(captured?.toolUseContext.options.tools.map(tool => tool.name)).toEqual(['Read', 'Write', 'WebSearch'])
    expect(captured?.toolUseContext.options.mcpClients).toEqual([])
    expect(captured?.forkContextMessages).toEqual([])
  })

  test('keeps Explore read-only at the runtime boundary', async () => {
    let captured: CacheSafeParams | undefined
    const stop = new Error('Captured before any provider request')
    const stream = runAgent({
      agentDefinition: { ...GENERAL_PURPOSE_AGENT, agentType: 'Explore' },
      promptMessages: [], toolUseContext: parentContext(),
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
      isAsync: false, querySource: 'agent:builtin',
      override: { userContext: {}, systemContext: {} },
      availableTools: [{ name: 'Read' }, { name: 'Write' }, { name: 'Edit' }, { name: 'Bash' }] as never,
      onCacheSafeParams: params => { captured = params; throw stop },
    })
    await expect(stream.next()).rejects.toBe(stop)
    expect(captured?.toolUseContext.options.tools.map(tool => tool.name).sort()).toEqual(['Bash', 'Read'])
    expect(JSON.stringify(captured?.systemPrompt)).toContain('Do not create, edit, delete')
  })

  test('does not initialize inherited or agent-specific MCP servers', async () => {
    const result = await initializeAgentMcpServers({
      ...GENERAL_PURPOSE_AGENT,
      mcpServers: [{ fixture: { type: 'stdio', command: 'must-not-start' } }],
    } as never, [{ name: 'inherited-fixture', type: 'connected' }] as never)
    expect(result.clients).toEqual([])
    expect(result.tools).toEqual([])
    await result.cleanup()
  })
})
