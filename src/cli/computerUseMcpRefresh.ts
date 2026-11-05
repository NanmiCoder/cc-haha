import type { Tools, ToolPermissionContext } from '../Tool.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../services/mcp/types.js'
import { COMPUTER_USE_MCP_SERVER_NAME, isComputerUseMCPServer, isComputerUseRuntimeTool, isComputerUseSupportedPlatform } from '../utils/computerUse/common.js'

export type ComputerUseRefreshConfiguration = {
  config: ScopedMcpServerConfig
  allowedTools: string[]
}

export type ComputerUseUnavailableReason =
  | 'session_disabled'
  | 'profile_disabled'
  | 'unsupported_platform'
  | 'environment_disabled'
  | 'settings_invalid'
  | 'settings_disabled'
  | 'policy_disabled'
  | 'runtime_missing'
  | 'connection_unavailable'

type RefreshConfiguration = ComputerUseRefreshConfiguration | { unavailable: ComputerUseUnavailableReason }

export function computerUseUnavailableMessage(reason?: ComputerUseUnavailableReason): string {
  const details = {
    session_disabled: 'This session was started with --no-computer-use.',
    profile_disabled: 'Switch to the Standard agent profile to use desktop tools.',
    unsupported_platform: 'The current platform has no supported desktop runtime.',
    environment_disabled: 'CLAUDE_COMPUTER_USE_ENABLED disables the desktop runtime.',
    settings_invalid: 'Check the Computer Use configuration in Settings.',
    settings_disabled: 'Enable Computer Use in Settings and confirm the consent dialog, then retry.',
    policy_disabled: 'MCP policy blocks the Computer Use server for this session.',
    runtime_missing: 'The native runtime is missing. Check the Computer Use status in Settings.',
    connection_unavailable: 'The native tools could not connect. Check the Computer Use status in Settings.',
  } satisfies Record<ComputerUseUnavailableReason, string>
  return `Computer Use is unavailable. ${reason ? details[reason] : 'This session’s tool permissions exclude desktop actions.'}`
}

/** The settings consent is the same boundary used by startup's CLI allow rules. */
export function computerUsePermissionContext(
  context: ToolPermissionContext,
  allowedTools: readonly string[],
): ToolPermissionContext {
  const rules = context.alwaysAllowRules.cliArg ?? []
  const next = [...new Set([
    ...rules.filter(rule => !rule.startsWith(`mcp__${COMPUTER_USE_MCP_SERVER_NAME}__`)),
    ...allowedTools,
  ])]
  if (rules.length === next.length && rules.every((rule, index) => rule === next[index])) return context
  return {
    ...context,
    alwaysAllowRules: { ...context.alwaysAllowRules, cliArg: next },
  }
}

/** Fresh disk reads also cover first enablement, when there was no file to watch at startup. */
export async function readComputerUseRefreshConfiguration(cliEnabled = true): Promise<RefreshConfiguration> {
  if (!cliEnabled) return { unavailable: 'session_disabled' }
  if (!isComputerUseSupportedPlatform()) return { unavailable: 'unsupported_platform' }
  const { isAgentProfileMcpEnabled } = await import('../utils/agentProfile.js')
  if (!isAgentProfileMcpEnabled()) return { unavailable: 'profile_disabled' }
  const { getChicagoEnabled } = await import('../utils/computerUse/gates.js')
  if (!getChicagoEnabled()) return { unavailable: 'environment_disabled' }
  const { loadStoredComputerUseConfigResult } = await import('../utils/computerUse/preauthorizedConfig.js')
  const stored = await loadStoredComputerUseConfigResult()
  if (stored.error) return { unavailable: 'settings_invalid' }
  if (!stored.config.enabled) return { unavailable: 'settings_disabled' }
  const { filterMcpServersByPolicy, isMcpServerDisabledForExecution } = await import('../services/mcp/config.js')
  if (isMcpServerDisabledForExecution(COMPUTER_USE_MCP_SERVER_NAME)) return { unavailable: 'policy_disabled' }
  const { setupComputerUseMCP } = await import('../utils/computerUse/setup.js')
  const setup = setupComputerUseMCP()
  if (setup.allowedTools.length === 0) return { unavailable: 'runtime_missing' }
  const config = filterMcpServersByPolicy(setup.mcpConfig).allowed[COMPUTER_USE_MCP_SERVER_NAME]
  return config ? { config, allowedTools: setup.allowedTools } : { unavailable: 'policy_disabled' }
}

type RefreshDependencies = {
  readConfiguration(): Promise<RefreshConfiguration>
  snapshot(): {
    clients: readonly MCPServerConnection[]
    tools: Tools
  }
  connect(config: ScopedMcpServerConfig, reconnect: boolean): Promise<{
    client: MCPServerConnection
    tools: Tools
  }>
  retire(client: MCPServerConnection): Promise<void>
  publish(client: MCPServerConnection | null, tools: Tools, allowedTools: readonly string[]): void
  onError?(error: unknown): void
}

/** Only this approved snapshot may contribute Computer Use tools to a headless query. */
export function createComputerUseMcpRefresh(deps: RefreshDependencies) {
  let approvedTools: Tools = []
  let unavailable: ComputerUseUnavailableReason | undefined = 'connection_unavailable'
  let pending: Promise<void> | undefined
  const sameConfiguration = (a: ComputerUseRefreshConfiguration, b: ComputerUseRefreshConfiguration) =>
    JSON.stringify(a) === JSON.stringify(b)
  const retire = async (client: MCPServerConnection) => {
    try {
      await deps.retire(client)
    } catch (error) {
      deps.onError?.(error)
    }
  }
  const read = async (): Promise<RefreshConfiguration> => {
    try {
      return await deps.readConfiguration()
    } catch (error) {
      deps.onError?.(error)
      return { unavailable: 'connection_unavailable' }
    }
  }
  const work = async () => {
    const desired = await read()
    const snapshot = deps.snapshot()
    const existing = snapshot.clients.find(client => isComputerUseMCPServer(client.name))
    if ('unavailable' in desired) {
      approvedTools = []
      unavailable = desired.unavailable
      deps.publish(null, [], [])
      // Do not wait for an old pending handshake just to disable the feature.
      if (existing) void retire(existing)
      return
    }
    const currentTools = snapshot.tools.filter(isComputerUseRuntimeTool)
    const complete = (tools: Tools) => desired.allowedTools.every(name => tools.some(tool => tool.name === name))
    if (existing?.type === 'connected'
      && JSON.stringify(existing.config) === JSON.stringify(desired.config)
      && complete(currentTools)) {
      approvedTools = currentTools
      unavailable = undefined
      deps.publish(existing, approvedTools, desired.allowedTools)
      return
    }
    let connected: Awaited<ReturnType<RefreshDependencies['connect']>>
    try {
      // Join an initial pending connection, but refresh a connected server whose
      // first tools/list happened while disabled and cached an empty inventory.
      connected = await deps.connect(desired.config, Boolean(existing && existing.type !== 'pending'))
    } catch (error) {
      deps.onError?.(error)
      approvedTools = []
      unavailable = 'connection_unavailable'
      // Remember the attempt so the next turn evicts failed connection/tool
      // promises instead of joining the same memoized failure indefinitely.
      deps.publish({
        name: COMPUTER_USE_MCP_SERVER_NAME,
        type: 'failed',
        config: desired.config,
        error: error instanceof Error ? error.message : String(error),
      }, [], [])
      return
    }
    const latest = await read()
    if ('unavailable' in latest || !sameConfiguration(desired, latest)) {
      approvedTools = []
      unavailable = 'unavailable' in latest ? latest.unavailable : 'connection_unavailable'
      deps.publish(null, [], [])
      await retire(connected.client)
      return
    }
    approvedTools = connected.client.type === 'connected' && complete(connected.tools)
      ? connected.tools.filter(isComputerUseRuntimeTool)
      : []
    unavailable = approvedTools.length ? undefined : 'connection_unavailable'
    deps.publish(connected.client, approvedTools, approvedTools.length ? latest.allowedTools : [])
  }
  return {
    tools: () => approvedTools,
    unavailableReason: () => unavailable,
    sync(): Promise<void> {
      pending ??= work().finally(() => { pending = undefined })
      return pending
    },
  }
}
