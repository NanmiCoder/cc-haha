import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getEmptyToolPermissionContext, type Tool, type Tools } from '../Tool.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../services/mcp/types.js'
import { getAgentProfile, setAgentProfile } from '../utils/agentProfile.js'
import * as helperBridge from '../utils/computerUse/cuHelperBridge.js'
import { getComputerUseConfigPath } from '../utils/computerUse/preauthorizedConfig.js'
import { getProjectPathForConfig } from '../utils/config.js'
import { getCwd } from '../utils/cwd.js'
import { getGlobalClaudeFile } from '../utils/env.js'
import { getCachedSettingsForSource, getSessionSettingsCache, resetSettingsCache, setCachedSettingsForSource, setSessionSettingsCache } from '../utils/settings/settingsCache.js'
import { SETTING_SOURCES } from '../utils/settings/constants.js'
import { computerUsePermissionContext, createComputerUseMcpRefresh, isComputerUseRuntimeTool, readComputerUseRefreshConfiguration } from './computerUseMcpRefresh.js'

const config: ScopedMcpServerConfig = { type: 'stdio', command: 'fixture', args: [], scope: 'dynamic' }
const names = ['mcp__computer-use__js', 'mcp__computer-use__js_reset']
const tools = names.map(name => ({ name })) as Tools
const connected = () => ({ name: 'computer-use', type: 'connected', config, cleanup: async () => {} }) as unknown as MCPServerConnection

function fixture() {
  let enabled = false
  let clients: MCPServerConnection[] = []
  let inventory: Tools = []
  let connects = 0
  let retires = 0
  let reconnects: boolean[] = []
  let allowed: readonly string[] = []
  let connection: (() => Promise<{
    client: MCPServerConnection
    tools: Tools
  }>) | undefined
  const refresh = createComputerUseMcpRefresh({
    readConfiguration: async () => enabled ? { config, allowedTools: names } : null,
    snapshot: () => ({ clients, tools: inventory }),
    connect: async (_config, reconnect) => {
      connects++
      reconnects.push(reconnect)
      return connection ? connection() : { client: connected(), tools }
    },
    retire: async () => {
      retires++
    },
    publish: (client, next, rules) => {
      clients = client ? [client] : []
      inventory = next
      allowed = rules
    },
  })
  return {
    refresh,
    enable(value: boolean) {
      enabled = value
    },
    initial(client: MCPServerConnection, initialTools: Tools) {
      clients = [client]
      inventory = initialTools
    },
    connectWith(fn: NonNullable<typeof connection>) {
      connection = fn
    },
    state: () => ({ clients, inventory, connects, retires, reconnects, allowed }),
  }
}

describe('headless Computer Use configuration gates', () => {
  const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA', 'CLAUDE_COMPUTER_USE_ENABLED'] as const
  let previousEnv: Record<string, string | undefined>
  let previousPlatform: PropertyDescriptor
  let previousProfile: ReturnType<typeof getAgentProfile>
  let previousGlobalFileCache: typeof getGlobalClaudeFile.cache
  let previousSettings: ReturnType<typeof getSessionSettingsCache>
  let previousSources: ReturnType<typeof getCachedSettingsForSource>[]
  let sandboxHome: string
  let helper: ReturnType<typeof spyOn<typeof helperBridge, 'resolveLaunchableCuHelperBinary'>>

  beforeEach(() => {
    previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    previousProfile = getAgentProfile()
    previousGlobalFileCache = getGlobalClaudeFile.cache
    previousSettings = getSessionSettingsCache()
    previousSources = SETTING_SOURCES.map(source => getCachedSettingsForSource(source))
    sandboxHome = mkdtempSync(join(tmpdir(), 'computer-use-config-'))
    for (const key of envKeys) process.env[key] = sandboxHome
    process.env.CLAUDE_CONFIG_DIR = join(sandboxHome, '.claude')
    process.env.CLAUDE_COMPUTER_USE_ENABLED = 'true'
    Object.defineProperty(process, 'platform', { ...previousPlatform, value: 'darwin' })
    setAgentProfile('standard')
    getGlobalClaudeFile.cache = new Map()
    // Seed the real settings cache rather than mocking policy functions or
    // reading the host's OS-managed settings during this config-file test.
    resetSettingsCache()
    setSessionSettingsCache({ settings: {}, errors: [] })
    setCachedSettingsForSource('policySettings', {})
    helper = spyOn(helperBridge, 'resolveLaunchableCuHelperBinary').mockReturnValue('/fixture/cu-helper')
    mkdirSync(dirname(getComputerUseConfigPath()), { recursive: true })
  })

  afterEach(() => {
    helper.mockRestore()
    resetSettingsCache()
    if (previousSettings) setSessionSettingsCache(previousSettings)
    SETTING_SOURCES.forEach((source, index) => {
      const value = previousSources[index]
      if (value !== undefined) setCachedSettingsForSource(source, value)
    })
    getGlobalClaudeFile.cache = previousGlobalFileCache
    setAgentProfile(previousProfile)
    Object.defineProperty(process, 'platform', previousPlatform)
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
    rmSync(sandboxHome, { recursive: true, force: true })
  })

  const store = (raw: string) => writeFileSync(getComputerUseConfigPath(), raw)

  test('respects CLI opt-out, lean, the environment kill switch, and unsupported platforms before helper resolution', async () => {
    store('{"enabled":true}')
    expect(await readComputerUseRefreshConfiguration(false)).toBeNull()
    setAgentProfile('lean')
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    setAgentProfile('standard')
    process.env.CLAUDE_COMPUTER_USE_ENABLED = 'false'
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    process.env.CLAUDE_COMPUTER_USE_ENABLED = 'true'
    Object.defineProperty(process, 'platform', { ...previousPlatform, value: 'linux' })
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    expect(helper).not.toHaveBeenCalled()
  })

  test('reads first creation and every later setting from disk, and fails closed on corrupt config', async () => {
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    store('{"enabled":false}')
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    store('{"enabled":true')
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    expect(helper).not.toHaveBeenCalled()
    store('{"enabled":true}')
    const enabled = await readComputerUseRefreshConfiguration(true)
    expect(enabled?.allowedTools).toEqual(names)
    expect(enabled?.config.scope).toBe('dynamic')
    store('{"enabled":false}')
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    expect(helper).toHaveBeenCalledTimes(1)
  })

  test('retains the canonical native-helper gate after consent', async () => {
    store('{"enabled":true}')
    helper.mockReturnValue(null)
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    helper.mockReturnValue('/fixture/cu-helper')
    expect((await readComputerUseRefreshConfiguration(true))?.allowedTools).toEqual(names)
    expect(helper).toHaveBeenCalledTimes(2)
  })

  test('respects managed policy and a freshly persisted MCP disable', async () => {
    store('{"enabled":true}')
    setSessionSettingsCache({ settings: { deniedMcpServers: [{ serverName: 'computer-use' }] }, errors: [] })
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    setSessionSettingsCache({ settings: {}, errors: [] })
    const policyPath = getGlobalClaudeFile()
    const projectPath = getProjectPathForConfig(getCwd())
    writeFileSync(policyPath, JSON.stringify({ projects: { [projectPath]: { disabledMcpServers: ['computer-use'] } } }))
    expect(await readComputerUseRefreshConfiguration(true)).toBeNull()
    writeFileSync(policyPath, '{}')
    expect((await readComputerUseRefreshConfiguration(true))?.allowedTools).toEqual(names)
  })
})

describe('headless Computer Use inventory refresh', () => {
  test('does not read configuration when the caller has not enabled the runtime integration', async () => {
    expect(await readComputerUseRefreshConfiguration(false)).toBeNull()
  })

  test('late enablement connects before the query, stays connected, and removes old startup tools on disable', async () => {
    const f = fixture()
    await f.refresh.sync()
    expect(f.state().connects).toBe(0)
    f.enable(true)
    await f.refresh.sync()
    expect(f.refresh.tools().map(tool => tool.name)).toEqual(names)
    expect(f.state().allowed).toEqual(names)
    await f.refresh.sync()
    expect(f.state().connects).toBe(1)
    f.enable(false)
    await f.refresh.sync()
    expect(f.refresh.tools()).toEqual([])
    expect(f.state().allowed).toEqual([])
    f.enable(true)
    await f.refresh.sync()
    expect(f.refresh.tools().map(tool => tool.name)).toEqual(names)
    expect(f.state().connects).toBe(2)
  })

  test('adopts a complete initial connection and reconnects an empty or failed one', async () => {
    const f = fixture()
    f.enable(true)
    f.initial(connected(), tools)
    await f.refresh.sync()
    expect(f.state().connects).toBe(0)
    f.initial(connected(), [])
    await f.refresh.sync()
    expect(f.state().reconnects).toEqual([true])
    f.initial({ name: 'computer-use', type: 'pending', config }, [])
    await f.refresh.sync()
    expect(f.state().reconnects).toEqual([true, false])
    f.initial({ name: 'computer-use', type: 'failed', config, error: 'fixture' }, [])
    await f.refresh.sync()
    expect(f.state().reconnects).toEqual([true, false, true])
  })

  test('does not publish a connection that finishes after disablement and serializes concurrent refreshes', async () => {
    const f = fixture()
    let finish!: (value: { client: MCPServerConnection, tools: Tools }) => void
    f.connectWith(() => new Promise(resolve => { finish = resolve }))
    f.enable(true)
    const first = f.refresh.sync()
    expect(f.refresh.sync()).toBe(first)
    await Promise.resolve()
    await Promise.resolve()
    f.enable(false)
    finish({ client: connected(), tools })
    await first
    expect(f.refresh.tools()).toEqual([])
    expect(f.state().allowed).toEqual([])
    expect(f.state().retires).toBe(1)
  })

  test('reconnects after a tools fetch failure rather than reusing a failed cached fetch', async () => {
    const f = fixture()
    f.enable(true)
    f.connectWith(async () => { throw new Error('tools/list failed') })
    await f.refresh.sync()
    expect(f.refresh.tools()).toEqual([])
    f.connectWith(async () => ({ client: connected(), tools }))
    await f.refresh.sync()
    expect(f.state().reconnects).toEqual([false, true])
    expect(f.refresh.tools().map(tool => tool.name)).toEqual(names)
  })

  test('only replaces automatic CLI allow rules, preserving other grants and explicit deny/ask rules', () => {
    const context = {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { cliArg: ['Read', ...names], session: ['Write'] },
      alwaysDenyRules: { userSettings: [names[0]!] },
      alwaysAskRules: { policySettings: [names[1]!] },
    }
    const disabled = computerUsePermissionContext(context, [])
    expect(disabled.alwaysAllowRules.cliArg).toEqual(['Read'])
    expect(disabled.alwaysAllowRules.session).toEqual(['Write'])
    expect(disabled.alwaysDenyRules).toBe(context.alwaysDenyRules)
    expect(disabled.alwaysAskRules).toBe(context.alwaysAskRules)
    const enabled = computerUsePermissionContext(disabled, names)
    expect(enabled.alwaysAllowRules.cliArg).toEqual(['Read', ...names])
    expect(computerUsePermissionContext(enabled, names)).toBe(enabled)
    expect(isComputerUseRuntimeTool({ name: names[0]! } as Tool)).toBe(true)
    expect(isComputerUseRuntimeTool({ name: 'Read' } as Tool)).toBe(false)
  })
})
