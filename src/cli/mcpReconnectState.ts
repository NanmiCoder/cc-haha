import type { Command } from '../commands.js'
import type { Tool } from '../Tool.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from '../services/mcp/types.js'
import { getMcpPrefix } from '../services/mcp/mcpStringUtils.js'
import { commandBelongsToServer } from '../services/mcp/utils.js'

interface McpState {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
}

interface DynamicMcpState {
  clients: MCPServerConnection[]
  tools: Tool[]
  configs: Record<string, ScopedMcpServerConfig>
}

export function disableStaleMcpReconnect(
  name: string,
  config: ScopedMcpServerConfig,
  client: MCPServerConnection,
  mcp: McpState,
  dynamic: DynamicMcpState,
): { mcp: McpState; dynamic: DynamicMcpState } {
  if (client.type === 'connected') void client.cleanup()

  const disabled = { name, type: 'disabled' as const, config }
  const prefix = getMcpPrefix(name)
  const { [name]: _removedResources, ...resources } = mcp.resources

  return {
    mcp: {
      ...mcp,
      clients: mcp.clients.map(existing =>
        existing.name === name ? disabled : existing,
      ),
      tools: mcp.tools.filter(tool => !tool.name?.startsWith(prefix)),
      commands: mcp.commands.filter(
        command => !commandBelongsToServer(command, name),
      ),
      resources,
    },
    dynamic: {
      ...dynamic,
      clients: [
        ...dynamic.clients.filter(existing => existing.name !== name),
        disabled,
      ],
      tools: dynamic.tools.filter(tool => !tool.name?.startsWith(prefix)),
    },
  }
}
