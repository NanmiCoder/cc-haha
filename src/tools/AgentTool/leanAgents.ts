import { getAgentProfile } from '../../utils/agentProfile.js'
import { applyBuiltInAgentOverrides } from './builtInAgentOverrides.js'
import type { AgentDefinition, BuiltInAgentDefinition } from './loadAgentsDir.js'

// Keep the lean catalog independent of project/plugin agents and their prompts,
// skill preloads, hooks, MCP servers, and permission-mode overrides.
const leanAgents: BuiltInAgentDefinition[] = [
  {
    agentType: 'general-purpose',
    whenToUse: 'Research or implement an independent task.',
    tools: ['*'],
    disallowedTools: ['Agent'],
    model: 'inherit',
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => 'You are a subagent completing the assigned task. Work within its scope and return a concise report of findings, changes, and verification to the parent agent. Do not start other agents.',
  },
  {
    agentType: 'Explore',
    whenToUse: 'Read-only code and web research.',
    tools: ['Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    model: 'inherit',
    omitClaudeMd: true,
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => 'You are a read-only research subagent. Search and inspect existing code and sources, then return concise findings with file paths or source links. Do not create, edit, delete, or otherwise change files or system state, including through shell commands. Do not start other agents.',
  },
]

export function getAgentDefinitionsForProfile(agents: AgentDefinition[]): AgentDefinition[] {
  return getAgentProfile() === 'lean' ? applyBuiltInAgentOverrides(leanAgents) : agents
}

/** Apply at the execution boundary too, including SDK and transcript resume. */
export function resolveLeanAgentDefinition(agentType: string): AgentDefinition {
  const leanAgent = applyBuiltInAgentOverrides(leanAgents).find(candidate => candidate.agentType === agentType)
  if (!leanAgent) {
    throw new Error(`Agent type '${agentType}' is unavailable in lean mode. Use general-purpose or Explore.`)
  }
  return leanAgent
}
