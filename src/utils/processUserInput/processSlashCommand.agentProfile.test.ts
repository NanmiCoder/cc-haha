import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from '../../commands.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getAgentProfile, setAgentProfile, type AgentProfile } from '../agentProfile.js'
import { processPromptSlashCommand, processSlashCommand } from './processSlashCommand.js'

const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'ANTHROPIC_API_KEY'] as const
let savedEnv: (string | undefined)[]
let savedProfile: AgentProfile
let root: string

beforeEach(async () => {
  savedEnv = keys.map(key => process.env[key])
  savedProfile = getAgentProfile()
  root = await mkdtemp(join(tmpdir(), 'lean-slash-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
  process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
  process.env.ANTHROPIC_API_KEY = 'fixture-lean-slash-key'
  setAgentProfile('lean')
})

afterEach(async () => {
  setAgentProfile(savedProfile)
  keys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[index]
  })
  await rm(root, { recursive: true, force: true })
})

function context(commands: Command[]): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    options: { commands, tools: [], mainLoopModel: 'fixture-model', agentDefinitions: { activeAgents: [] } },
  } as unknown as ToolUseContext
}

for (const kind of ['fork', 'mcp'] as const) {
  test(`lean rejects ${kind} prompt commands before loading content, hooks, or permissions`, async () => {
    const load = mock(async () => [{ type: 'text', text: 'must not be injected' }])
    const command = {
      type: 'prompt', name: kind === 'mcp' ? 'mcp__fixture__prompt' : 'fixture',
      description: 'fixture', isEnabled: () => true, isHidden: false,
      progressMessage: 'loading', contentLength: 0,
      ...(kind === 'fork' ? { context: 'fork' } : {}),
      source: kind === 'mcp' ? 'mcp' : 'projectSettings',
      getPromptForCommand: load,
      get hooks() { throw new Error('hooks must not be accessed') },
      get allowedTools() { throw new Error('permissions must not be accessed') },
    } as unknown as Command
    const ctx = context([command])
    const result = await processSlashCommand(`/${command.name} arguments`, [], [], [], ctx, () => {})
    expect(result.shouldQuery).toBe(false)
    expect(result.resultText).toContain('unavailable with --agent-profile lean')
    expect(result.resultText).toContain('--agent-profile standard')
    expect(result.allowedTools).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
    const direct = await processPromptSlashCommand(command.name, 'arguments', [command], ctx)
    expect(direct.shouldQuery).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })
}

test('lean retains local command dispatch', async () => {
  const call = mock(async () => ({ type: 'text', value: 'local result' }))
  const command = {
    type: 'local', name: 'cost', description: 'fixture',
    isEnabled: () => true, isHidden: false, load: async () => ({ call }),
  } as unknown as Command
  const result = await processSlashCommand('/cost arg', [], [], [], context([command]), () => {})
  expect(call).toHaveBeenCalledTimes(1)
  expect(result.shouldQuery).toBe(false)
  expect(result.resultText).toBe('local result')
})

test('standard continues to expand prompt commands', async () => {
  setAgentProfile('standard')
  const load = mock(async () => [{ type: 'text' as const, text: 'standard skill content' }])
  const command = {
    type: 'prompt', name: 'fixture', description: 'fixture',
    isEnabled: () => true, isHidden: false, progressMessage: 'loading', contentLength: 0,
    getPromptForCommand: load,
  } as unknown as Command
  const result = await processPromptSlashCommand('fixture', 'arg', [command], context([command]))
  expect(result.shouldQuery).toBe(true)
  expect(JSON.stringify(result.messages)).toContain('standard skill content')
  expect(load).toHaveBeenCalledTimes(1)
})

test('lean explicit inline skill loads only selected content without hooks or permission/model overrides', async () => {
  const command = {
    type: 'prompt', name: 'fixture', description: 'fixture', source: 'projectSettings',
    isEnabled: () => true, isHidden: false, progressMessage: 'loading', contentLength: 0,
    getPromptForCommand: async () => [{ type: 'text' as const, text: 'selected skill content' }],
    get hooks() { throw new Error('must not register skill hooks') },
    get allowedTools() { throw new Error('must not widen permissions') },
    get model() { throw new Error('must not override model') },
    get effort() { throw new Error('must not override effort') },
  } as unknown as Command
  const result = await processPromptSlashCommand('fixture', '', [command], context([command]))
  expect(result.shouldQuery).toBe(true)
  expect(JSON.stringify(result.messages)).toContain('selected skill content')
  expect(result.allowedTools).toBeUndefined()
  expect(result.model).toBeUndefined()
  expect(result.effort).toBeUndefined()
  expect(JSON.stringify(result.messages)).not.toContain('command_permissions')
})


test('lean rejects the real /plan command from a refreshed command list before changing permission state', async () => {
  const { getCommands, clearCommandsCache } = await import('../../commands.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  clearCommandsCache()
  const commands = await getCommands(root)
  expect(commands.some(command => command.name === 'plan')).toBe(true)
  let state = getDefaultAppState()
  const ctx = {
    ...context(commands),
    getAppState: () => state,
    setAppState: (update: (previous: typeof state) => typeof state) => { state = update(state) },
  } as ToolUseContext
  const result = await processSlashCommand('/plan implement a change', [], [], [], ctx, () => {})
  expect(result.shouldQuery).toBe(false)
  expect(result.resultText).toContain('unavailable with --agent-profile lean')
  expect(state.toolPermissionContext.mode).toBe('default')
  clearCommandsCache()
})

test('lean rejects local capability commands before loading their implementation', async () => {
  const load = mock(async () => { throw new Error('must not load advisor') })
  const command = { type: 'local', name: 'advisor', description: 'fixture', supportsNonInteractive: true, load } as Command
  const result = await processSlashCommand('/advisor', [], [], [], context([command]), () => {})
  expect(result.shouldQuery).toBe(false)
  expect(result.resultText).toContain('unavailable with --agent-profile lean')
  expect(load).not.toHaveBeenCalled()
})
