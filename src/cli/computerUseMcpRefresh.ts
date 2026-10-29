import type { Tool, Tools, ToolPermissionContext } from '../Tool.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../services/mcp/types.js'
import { COMPUTER_USE_MCP_SERVER_NAME, isComputerUseMCPServer } from '../utils/computerUse/common.js'

export type ComputerUseRefreshConfiguration = {
  config: ScopedMcpServerConfig
  allowedTools: string[]
}

export function isComputerUseRuntimeTool(tool: Pick<Tool, 'name' | 'mcpInfo'>): boolean {
  return tool.name.startsWith(`mcp__${COMPUTER_USE_MCP_SERVER_NAME}__`)
    || Boolean(tool.mcpInfo && isComputerUseMCPServer(tool.mcpInfo.serverName))
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
export async function readComputerUseRefreshConfiguration(cliEnabled = true): Promise<ComputerUseRefreshConfiguration | null> {
  if (!cliEnabled) return null
  const { isAgentProfileMcpEnabled } = await import('../utils/agentProfile.js')
  if (!isAgentProfileMcpEnabled()
    || (process.platform !== 'darwin' && process.platform !== 'win32')) return null
  const { getChicagoEnabled } = await import('../utils/computerUse/gates.js')
  if (!getChicagoEnabled()) return null
  const { loadStoredComputerUseConfigResult } = await import('../utils/computerUse/preauthorizedConfig.js')
  const stored = await loadStoredComputerUseConfigResult()
  if (stored.error || !stored.config.enabled) return null
  const { filterMcpServersByPolicy, isMcpServerDisabledForExecution } = await import('../services/mcp/config.js')
  if (isMcpServerDisabledForExecution(COMPUTER_USE_MCP_SERVER_NAME)) return null
  const { setupComputerUseMCP } = await import('../utils/computerUse/setup.js')
  const setup = setupComputerUseMCP()
  const config = filterMcpServersByPolicy(setup.mcpConfig).allowed[COMPUTER_USE_MCP_SERVER_NAME]
  return config && setup.allowedTools.length ? { config, allowedTools: setup.allowedTools } : null
}

type RefreshDependencies = {
  readConfiguration(): Promise<ComputerUseRefreshConfiguration | null>
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
  const read = async () => {
    try {
      return await deps.readConfiguration()
    } catch (error) {
      deps.onError?.(error)
      return null
    }
  }
  const work = async () => {
    const desired = await read()
    const snapshot = deps.snapshot()
    const existing = snapshot.clients.find(client => isComputerUseMCPServer(client.name))
    if (!desired) {
      approvedTools = []
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
    if (!latest || !sameConfiguration(desired, latest)) {
      approvedTools = []
      deps.publish(null, [], [])
      await retire(connected.client)
      return
    }
    approvedTools = connected.client.type === 'connected' && complete(connected.tools)
      ? connected.tools.filter(isComputerUseRuntimeTool)
      : []
    deps.publish(connected.client, approvedTools, approvedTools.length ? latest.allowedTools : [])
  }
  return {
    tools: () => approvedTools,
    sync(): Promise<void> {
      pending ??= work().finally(() => { pending = undefined })
      return pending
    },
  }
}
