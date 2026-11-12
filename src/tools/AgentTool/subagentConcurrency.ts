import { getMaxConcurrentSubagentsUncached } from '../../utils/settings/settings.js'

// Counts only ordinary AgentTool calls; counts even when unlimited, so sessions already open
// don't miss still-running sub-agents when the limit is enabled or lowered dynamically.
let activeSubagents = 0

export function reserveSubagentSlot(): () => void {
  const limit = getMaxConcurrentSubagentsUncached()
  // No await between check and increment, guaranteeing atomic reservation for nested or parallel calls in the same process.
  // No queueing, to avoid deadlock where a nested sub-agent waits for its parent agent's slot.
  if (limit != null && activeSubagents >= limit) {
    throw new Error(
      `Maximum concurrent subagents reached (${limit}). Wait for a running subagent to finish before spawning another. ` +
      'The user can change this limit in Settings > General.',
    )
  }
  activeSubagents += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeSubagents -= 1
  }
}
