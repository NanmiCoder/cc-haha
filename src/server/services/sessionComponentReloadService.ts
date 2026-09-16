import { conversationService } from './conversationService.js'
import { updateSessionSlashCommands } from '../ws/handler.js'

export type SessionComponentReloadSummary = {
  applied: boolean
  reason?: 'not_running' | 'failed'
  commands: number
  agents: number
  plugins: number
  mcpServers: number
  errors: number
  error?: string
}

/**
 * Refresh the disk-backed commands, agents, plugins, and MCP state captured by
 * an already-running CLI session. The control request updates the session in
 * place, so callers do not need to restart or replace the conversation.
 */
export async function reloadSessionComponents(
  sessionId: string,
  requiredMcpServer?: string,
  requiredPlugin?: { pluginId: string, skillName: string },
): Promise<SessionComponentReloadSummary> {
  if (!conversationService.hasSession(sessionId)) {
    return emptySummary('not_running')
  }

  try {
    const response = await conversationService.requestControl(
      sessionId,
      { subtype: 'reload_plugins' },
      120_000,
    )
    const commands = Array.isArray(response.commands) ? response.commands : []
    const normalizedCommands = updateSessionSlashCommands(sessionId, commands)
    let mcpServers = response.mcpServers

    // All connectors publish a skill entry point, including native CLIs and
    // skill bundles. A plugin on disk does not prove that this chat loaded it.
    if (requiredPlugin && (
      !Array.isArray(response.plugins) || !response.plugins.some(plugin => plugin?.source === requiredPlugin.pluginId) ||
      !commands.some(command => command?.name === requiredPlugin.skillName)
    )) {
      throw new Error('Connector plugin and skill are not available in the active task')
    }

    if (requiredMcpServer && !hasServerTools(mcpServers, requiredMcpServer)) {
      // OAuth can finish in the desktop server while this CLI still holds a
      // needs-auth connection and cached credentials. Reconnect in that process
      // so it reads fresh credentials and replaces its actual query tools.
      await conversationService.requestControl(sessionId, {
        subtype: 'mcp_reconnect', serverName: requiredMcpServer,
      }, 120_000)
      const status = await conversationService.requestControl(sessionId, { subtype: 'mcp_status' }, 30_000)
      mcpServers = status.mcpServers
      if (!hasServerTools(mcpServers, requiredMcpServer)) {
        throw new Error('Connector tools are not available in the active task')
      }
    }

    return {
      applied: true,
      commands: normalizedCommands.length,
      agents: Array.isArray(response.agents) ? response.agents.length : 0,
      plugins: Array.isArray(response.plugins) ? response.plugins.length : 0,
      mcpServers: Array.isArray(mcpServers) ? mcpServers.length : 0,
      errors: typeof response.error_count === 'number' ? response.error_count : 0,
    }
  } catch (error) {
    return {
      ...emptySummary('failed'),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function hasServerTools(servers: unknown, name: string): boolean {
  return Array.isArray(servers) && servers.some(server =>
    server?.name === name && server.status === 'connected' &&
    // The local OAuth helper is not evidence of a discovered business tool.
    Array.isArray(server.tools) && server.tools.some((tool: { name?: unknown } | null) =>
      typeof tool?.name === 'string' && tool.name.length > 0 && tool.name !== 'authenticate',
    ),
  )
}

function emptySummary(
  reason: 'not_running' | 'failed',
): SessionComponentReloadSummary {
  return {
    applied: false,
    reason,
    commands: 0,
    agents: 0,
    plugins: 0,
    mcpServers: 0,
    errors: 0,
  }
}
