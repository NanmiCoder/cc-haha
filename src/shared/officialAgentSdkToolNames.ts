const ownedTools = new Set([
  'TeamCreate', 'TeamPlan', 'TeamDelete', 'SendMessage', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
  'Workflow', 'CronCreate', 'CronList', 'CronUpdate', 'CronDelete',
  'ListSessions', 'ReadSession', 'CreateSession', 'CreateSessions', 'SendSessionMessage', 'WaitSessions', 'ListSessionModels',
])
const prefix = 'mcp__cc_haha__'

/** Normalize only our registered tools for desktop display/projection. Native
 * transcripts, permission rules and third-party MCP identities stay intact. */
export function normalizeOfficialAgentSdkToolName(name: string): string {
  if (!name.startsWith(prefix)) return name
  const short = name.slice(prefix.length)
  return ownedTools.has(short) ? short : name
}

/** Copy only changed blocks; never mutate native SDK events or stored records. */
export function normalizeOfficialAgentSdkToolContent<T>(content: T): T {
  if (!Array.isArray(content)) return content
  let changed = false
  const normalized = content.map(block => {
    if (!block || typeof block !== 'object' || block.type !== 'tool_use' || typeof block.name !== 'string') return block
    const name = normalizeOfficialAgentSdkToolName(block.name)
    if (name === block.name) return block
    changed = true
    return { ...block, name }
  })
  return changed ? normalized as T : content
}
