import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { Tool, Tools, ToolPermissionContext } from '../Tool.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { QueryParams } from '../query.js'

const home = mkdtempSync(join(tmpdir(), 'print-computer-use-refresh-'))
const originalEnv = { ...process.env }
const buildMacros = globalThis as { MACRO?: unknown }
const previousMacro = buildMacros.MACRO
buildMacros.MACRO = { VERSION: 'fixture', BUILD_TIME: 'fixture' }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(home, {
  CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: 'fixture-computer-use-key',
  CLAUDE_COMPUTER_USE_ENABLED: 'true',
}, originalEnv))
const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
Object.defineProperty(process, 'platform', { ...previousPlatform, value: 'darwin' })

const mcpClient = await import('../services/mcp/client.js')
const helperBridge = await import('../utils/computerUse/cuHelperBridge.js')
const queryModule = await import('../query.js')
const { __runHeadlessStreamingForTests } = await import('./print.js')
const { StructuredIO } = await import('./structuredIO.js')
const { Stream } = await import('../utils/stream.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createAssistantMessage } = await import('../utils/messages.js')
const { clearCommandQueue } = await import('../utils/messageQueueManager.js')
const { getCommands, clearCommandsCache } = await import('../commands.js')
const { getComputerUseConfigPath } = await import('../utils/computerUse/preauthorizedConfig.js')
const { invalidateComputerUseSkillGate } = await import('../utils/computerUse/skillGate.js')
const { getAgentProfile, setAgentProfile } = await import('../utils/agentProfile.js')
const { getGlobalClaudeFile } = await import('../utils/env.js')
const { SETTING_SOURCES } = await import('../utils/settings/constants.js')
const settingsCache = await import('../utils/settings/settingsCache.js')
const { getBundledSkills, clearBundledSkills, registerBundledSkill } = await import('../skills/bundledSkills.js')
const { registerComputerUseSkill } = await import('../skills/bundled/computerUse.js')
const { setIsInteractive, getIsInteractive } = await import('../bootstrap/state.js')
const wasInteractive = getIsInteractive()
const previousProfile = getAgentProfile()
const previousGlobalFileCache = getGlobalClaudeFile.cache
const previousSettings = settingsCache.getSessionSettingsCache()
const previousSources = SETTING_SOURCES.map(source => settingsCache.getCachedSettingsForSource(source))
const previousBundledSkills = getBundledSkills()
const addedComputerUseSkill = !previousBundledSkills.some(command => command.name === 'computer-use')
if (addedComputerUseSkill) registerComputerUseSkill()
getGlobalClaudeFile.cache = new Map()
settingsCache.resetSettingsCache()
settingsCache.setSessionSettingsCache({ settings: {}, errors: [] })
settingsCache.setCachedSettingsForSource('policySettings', {})
setIsInteractive(false)
setAgentProfile('standard')

afterAll(() => {
  clearCommandQueue()
  clearCommandsCache()
  invalidateComputerUseSkillGate()
  if (addedComputerUseSkill) {
    clearBundledSkills()
    for (const command of previousBundledSkills) registerBundledSkill(command as never)
  }
  settingsCache.resetSettingsCache()
  if (previousSettings) settingsCache.setSessionSettingsCache(previousSettings)
  SETTING_SOURCES.forEach((source, index) => {
    const value = previousSources[index]
    if (value !== undefined) settingsCache.setCachedSettingsForSource(source, value)
  })
  getGlobalClaudeFile.cache = previousGlobalFileCache
  setAgentProfile(previousProfile)
  setIsInteractive(wasInteractive)
  Object.defineProperty(process, 'platform', previousPlatform)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (previousMacro === undefined) delete buildMacros.MACRO
  else buildMacros.MACRO = previousMacro
  rmSync(home, { recursive: true, force: true })
})

test('a running headless query refreshes tools, permission rules, and skills together without losing another MCP', async () => {
  const names = ['mcp__computer-use__js', 'mcp__computer-use__js_reset']
  const nativeTools = names.map(name => ({ name, isReadOnly: () => true })) as Tools
  const unrelated = { name: 'mcp__business__lookup', isReadOnly: () => true } as Tool
  const config: ScopedMcpServerConfig = { type: 'stdio', command: 'fixture', args: [], scope: 'dynamic' }
  const connected = (connectionConfig: ScopedMcpServerConfig): ConnectedMCPServer => ({
    name: 'computer-use', type: 'connected', config: connectionConfig,
    client: {} as ConnectedMCPServer['client'], capabilities: {}, cleanup: async () => {},
  })
  const helper = spyOn(helperBridge, 'resolveLaunchableCuHelperBinary').mockReturnValue('/fixture/cu-helper')
  const initialConnect = spyOn(mcpClient, 'connectToServer').mockImplementation(async (name, connectionConfig) => {
    expect(name).toBe('computer-use')
    return connected(connectionConfig)
  })
  const fetchTools = spyOn(mcpClient, 'fetchToolsForClient').mockResolvedValue(nativeTools)
  const reconnect = spyOn(mcpClient, 'reconnectMcpServerImpl').mockImplementation(async (name, connectionConfig) => ({
    name, client: connected(connectionConfig), tools: nativeTools, commands: [], resources: [],
  }))
  const retire = spyOn(mcpClient, 'clearServerCache').mockResolvedValue()
  const snapshots: Array<{
    tools: string[]
    commands: string[]
    permissions: ToolPermissionContext
  }> = []
  // Keep the real QueryEngine and stop only at the model-query boundary.
  // Everything recorded here is the final context passed to query().
  const query = spyOn(queryModule, 'query').mockImplementation(async function* (params: QueryParams) {
    snapshots.push({
      tools: params.toolUseContext.options.tools.map(tool => tool.name),
      commands: params.toolUseContext.options.commands.map(command => command.name),
      permissions: params.toolUseContext.getAppState().toolPermissionContext,
    })
    yield createAssistantMessage({ content: 'fixture completed' })
    return { reason: 'completed' } as never
  })
  let state = getDefaultAppState()
  state = {
    ...state,
    toolPermissionContext: {
      ...state.toolPermissionContext,
      alwaysAllowRules: { cliArg: ['Read', ...names] },
      alwaysDenyRules: { session: [names[1]!] },
    },
    mcp: {
      ...state.mcp,
      clients: [{ name: 'business', type: 'pending', config }],
      tools: [...nativeTools, unrelated],
    },
  }
  mkdirSync(dirname(getComputerUseConfigPath()), { recursive: true })
  writeFileSync(getComputerUseConfigPath(), '{"enabled":false}')
  invalidateComputerUseSkillGate()
  clearCommandsCache()
  const commands = await getCommands(home)
  expect(commands.some(command => command.name === 'computer-use')).toBe(false)
  const input = new Stream<string>()
  const output = __runHeadlessStreamingForTests(
    new StructuredIO(input), [], commands, [...nativeTools, unrelated], [],
    (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    {}, () => state, update => { state = update(state) }, [],
    { outputFormat: 'stream-json', computerUse: true, systemPrompt: 'fixture', userSpecifiedModel: 'claude-sonnet-4-5' } as never,
  )
  const iterator = output[Symbol.asyncIterator]()
  async function turn(text: string) {
    input.enqueue(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    while (true) {
      const next = await iterator.next()
      if (next.done) throw new Error('Headless session ended before a result')
      if (next.value.type === 'result') {
        expect(next.value.is_error).toBe(false)
        return snapshots.at(-1)!
      }
    }
  }
  try {
    const off = await turn('before enablement')
    expect(off.tools.filter(name => name.startsWith('mcp__computer-use__'))).toEqual([])
    expect(off.permissions.alwaysAllowRules.cliArg).toEqual(['Read'])
    expect(initialConnect).not.toHaveBeenCalled()

    writeFileSync(getComputerUseConfigPath(), '{"enabled":true}')
    const on = await turn('after enabling Computer Use')
    expect(on.tools).toContain(names[0]!)
    expect(on.tools).not.toContain(names[1]!)
    expect(on.permissions.alwaysDenyRules.session).toEqual([names[1]!])
    expect(on.permissions.alwaysAllowRules.cliArg).toEqual(['Read', ...names])
    expect(on.commands).toContain('computer-use')
    expect(initialConnect).toHaveBeenCalledTimes(1)
    expect(fetchTools).toHaveBeenCalledTimes(1)

    await turn('use the same healthy connection')
    expect(initialConnect).toHaveBeenCalledTimes(1)
    expect(reconnect).not.toHaveBeenCalled()

    // A connection whose first tools/list ran while disabled must refresh
    // its empty inventory rather than remaining permanently tool-less.
    state = { ...state, mcp: { ...state.mcp, tools: [unrelated] } }
    const refreshed = await turn('recover the prewarmed empty tool inventory')
    expect(refreshed.tools).toContain(names[0]!)
    expect(reconnect).toHaveBeenCalledTimes(1)

    writeFileSync(getComputerUseConfigPath(), '{"enabled":false}')
    const disabled = await turn('after disabling Computer Use')
    expect(disabled.tools.filter(name => name.startsWith('mcp__computer-use__'))).toEqual([])
    expect(disabled.commands).not.toContain('computer-use')
    expect(disabled.permissions.alwaysAllowRules.cliArg).toEqual(['Read'])
    expect(retire).toHaveBeenCalledTimes(1)
    for (const snapshot of snapshots) expect(snapshot.tools).toContain(unrelated.name)
    expect(state.mcp.clients.map(client => client.name)).toEqual(['business'])
  } finally {
    input.done()
    await iterator.return?.()
    clearCommandQueue()
    query.mockRestore()
    retire.mockRestore()
    reconnect.mockRestore()
    fetchTools.mockRestore()
    initialConnect.mockRestore()
    helper.mockRestore()
  }
}, 15_000)
