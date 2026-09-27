import type { ToolUseContext, Tools } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { getSessionId, getProjectRoot } from '../../bootstrap/state.js'
import { getCommand, getSkillToolCommands } from '../../commands.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { registerFrontmatterHooks } from '../hooks/registerFrontmatterHooks.js'
import { createUserMessage } from '../messages.js'
import { isRestrictedToPluginOnly, isSourceAdminTrusted } from '../settings/pluginOnlyPolicy.js'

/** Created lazily by the first released worker task, never SDK initialization. */
export async function prepareTeamWorkerPreset(agent: AgentDefinition, tools: Tools, clients: MCPServerConnection[]) {
  if (agent.mcpServers?.some(reference => typeof reference !== 'string')) throw new Error('Team worker MCP requires named configured servers')
  const { initializeAgentMcpServers } = await import('../../tools/AgentTool/runAgent.js')
  const mcp = await initializeAgentMcpServers(agent, clients)
  for (const reference of agent.mcpServers ?? []) {
    if (typeof reference !== 'string' || !mcp.clients.some(client => client.name === reference && client.type === 'connected')) {
      await mcp.cleanup()
      throw new Error(`Team worker MCP server unavailable: ${typeof reference === 'string' ? reference : 'inline configuration'}`)
    }
  }
  registerCleanup(mcp.cleanup)
  const { resolveAgentTools } = await import('../../tools/AgentTool/agentToolUtils.js')
  return { tools: resolveAgentTools(agent, [...tools, ...mcp.tools], false, true).resolvedTools, clients: mcp.clients }
}

/** Preload skill content only: a skill's model override cannot replace human routing. */
export async function activateTeamWorkerPreset(agent: AgentDefinition, context: ToolUseContext) {
  const { resolveSkillName } = await import('../../tools/AgentTool/runAgent.js')
  const allSkills = agent.skills?.length ? await getSkillToolCommands(getProjectRoot()) : []
  const messages = []
  for (const name of agent.skills ?? []) {
    const resolved = resolveSkillName(name, allSkills, agent)
    if (!resolved) throw new Error(`Team worker skill unavailable: ${name}`)
    const skill = getCommand(resolved, allSkills)
    if (skill.type !== 'prompt') throw new Error(`Team worker skill is not prompt-based: ${name}`)
    const content = await skill.getPromptForCommand('', context)
    messages.push(createUserMessage({ content, isMeta: true }))
  }
  if (agent.hooks) {
    if (isRestrictedToPluginOnly('hooks') && !isSourceAdminTrusted(agent.source)) throw new Error('Team worker hooks are blocked by customization policy')
    // The worker owns a main QueryEngine, whose terminal event is Stop.
    registerFrontmatterHooks(context.setAppState, getSessionId(), agent.hooks, `team worker '${agent.agentType}'`)
  }
  return messages
}
